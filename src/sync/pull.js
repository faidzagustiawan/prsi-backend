// src/sync/pull.js
//
// Jalur Track ke SI (RancanganSistem 5): muat awal dari snapshot, lalu event
// berurutan menurut seq. Setiap event diterapkan bersama majunya cursor dalam
// satu transaksi, jadi worker yang mati di tengah jalan melanjutkan dari event
// terakhir yang benar-benar diterapkan.
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { syncCursor, syncError } from '../shared/schemas/track.schema.js';
import { applyChange, ApplyError } from './apply.js';
import { ENTITIES, ENTITY_ORDER } from './mapping.js';

const CURSOR_ID = 'global';
const MAX_PERCOBAAN = 20;

export async function getCursor(tx = db) {
  await tx.insert(syncCursor).values({ id: CURSOR_ID }).onConflictDoNothing();
  const [c] = await tx.select().from(syncCursor).where(eq(syncCursor.id, CURSOR_ID)).limit(1);
  return c;
}

const setCursor = (tx, values) => tx.update(syncCursor).set({ ...values, updatedAt: new Date() }).where(eq(syncCursor.id, CURSOR_ID));

const eventToChange = (e) => ({
  entity: e.entity, trackId: e.entity_id, op: e.op, rowVersion: e.row_version, seq: e.seq, payload: e.payload, snapshot: Boolean(e.snapshot),
});

async function catatError(tx, e, err) {
  await tx.insert(syncError).values({
    seq: e.seq ?? null, entity: e.entity, entityTrackId: e.entity_id, alasan: err.message, payload: { ...e, _kind: err.kind },
  });
}

/** Terapkan satu event; galat data/induk dicatat di sync_error, tidak menghentikan putaran. */
async function applyEvent(e, counts, { advanceCursor }) {
  await db.transaction(async (tx) => {
    try {
      // Savepoint: galat di tengah penerapan tidak membatalkan pencatatan galat dan cursor
      const hasil = await tx.transaction((sp) => applyChange(sp, eventToChange(e)));
      if (hasil === 'baru') counts.baru += 1;
      else if (hasil !== 'abaikan') counts.ubah += 1;
      // Versi yang lebih baru dari baris yang sama sudah masuk: galat lamanya selesai
      if (hasil !== 'abaikan') {
        await tx.update(syncError).set({ resolvedAt: new Date() })
          .where(and(eq(syncError.entity, e.entity), eq(syncError.entityTrackId, e.entity_id), isNull(syncError.resolvedAt)));
      }
    } catch (err) {
      if (!(err instanceof ApplyError)) throw err;
      counts.gagal += 1;
      await catatError(tx, e, err);
    }
    if (advanceCursor) await setCursor(tx, { cursorSeq: e.seq, gapSeq: null, gapSince: null });
  });
}

/** Ulangi event yang tertahan karena induknya belum ada. Galat data menunggu perbaikan di Track. */
export async function retryErrors(counts) {
  const rows = await db.select().from(syncError)
    .where(and(isNull(syncError.resolvedAt), sql`${syncError.percobaan} < ${MAX_PERCOBAAN}`, sql`${syncError.payload}->>'_kind' = 'induk'`))
    .orderBy(asc(syncError.seq), asc(syncError.createdAt));
  for (const r of rows) {
    await db.transaction(async (tx) => {
      try {
        await tx.transaction((sp) => applyChange(sp, eventToChange(r.payload)));
        await tx.update(syncError).set({ resolvedAt: new Date() }).where(eq(syncError.id, r.id));
        counts.diulang += 1;
      } catch (err) {
        if (!(err instanceof ApplyError)) throw err;
        await tx.update(syncError).set({ percobaan: r.percobaan + 1, alasan: err.message }).where(eq(syncError.id, r.id));
      }
    });
  }
}

/**
 * Tarik event sampai habis. Lubang seq (transaksi Track yang belum commit)
 * ditunggu sampai gapTimeoutSec; setelah itu dianggap rollback dan dilewati.
 */
export async function pullEvents(client, counts, { now = () => new Date(), cfg = env.sync } = {}) {
  let cursor = await getCursor();
  for (let page = 0; page < 1000; page += 1) {
    const res = await client.events(cursor.cursorSeq, cfg.pageSize);
    let waiting = false;
    for (const e of res.events) {
      if (e.seq <= cursor.cursorSeq) continue;
      if (e.seq > cursor.cursorSeq + 1) {
        const gapSeq = cursor.cursorSeq + 1;
        if (cursor.gapSeq !== gapSeq) {
          await setCursor(db, { gapSeq, gapSince: now() });
          cursor = await getCursor();
          waiting = true;
          break;
        }
        const ageSec = (now() - cursor.gapSince) / 1000;
        if (ageSec < cfg.gapTimeoutSec) {
          waiting = true;
          break;
        }
        counts.lubangDilewati += e.seq - gapSeq;
      }
      await applyEvent(e, counts, { advanceCursor: true });
      cursor = { ...cursor, cursorSeq: e.seq, gapSeq: null, gapSince: null };
    }
    if (waiting || !res.has_more) break;
  }
  return cursor;
}

async function mirrorKosong() {
  for (const entity of ENTITY_ORDER) {
    const [{ n }] = await db.select({ n: count() }).from(ENTITIES[entity].table);
    if (Number(n) > 0) return false;
  }
  return true;
}

/** Tarik seluruh baris satu entitas lewat snapshot. Mengembalikan track_id yang terlihat. */
export async function pullSnapshot(client, entity, counts) {
  const seen = new Set();
  let after = '';
  let maxSeq = null;
  for (let page = 0; page < 100_000; page += 1) {
    const res = await client.snapshot(entity, after);
    if (maxSeq === null) maxSeq = res.max_seq;
    for (const row of res.rows) {
      seen.add(row.id);
      await applyEvent({ entity, entity_id: row.id, op: 'U', row_version: row.row_version, payload: row, snapshot: true }, counts, { advanceCursor: false });
    }
    if (!res.has_more || !res.rows.length) break;
    after = res.rows.at(-1).id;
  }
  return { seen, maxSeq };
}

/**
 * Muat awal (RancanganSistem 5.4): catat max_seq, tarik snapshot semua
 * entitas berurutan relasi, lalu cursor = max_seq. Event yang tumpang tindih
 * dengan snapshot aman karena cek row_version.
 */
export async function initialLoadIfEmpty(client, counts) {
  const cursor = await getCursor();
  if (cursor.cursorSeq > 0 || !(await mirrorKosong())) return false;
  let startSeq = null;
  for (const entity of ENTITY_ORDER) {
    const { maxSeq } = await pullSnapshot(client, entity, counts);
    if (startSeq === null) startSeq = maxSeq;
  }
  await setCursor(db, { cursorSeq: startSeq ?? 0 });
  return true;
}
