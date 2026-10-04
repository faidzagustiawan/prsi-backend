// src/sync/runner.js
//
// Satu putaran worker: tarik dari Track, proses pembayaran (Alur 2), kirim
// outbox. Dijaga advisory lock Postgres supaya dua putaran (dua proses worker,
// atau worker + tombol "Sinkron sekarang") tidak pernah berjalan bersamaan.
import { db, sessionClient } from '../config/database.js';
import { env } from '../config/env.js';
import { syncLog } from '../shared/schemas/track.schema.js';
import { createTrackClient, TrackError } from './track-client.js';
import { initialLoadIfEmpty, pullEvents, retryErrors } from './pull.js';
import { pushOutbox } from './push.js';
import { reconcile } from './reconcile.js';
import { prosesSemua } from '../modules/penjualan/pembayaran.service.js';

const LOCK_KEY = 74_210_301; // angka tetap untuk pg_try_advisory_lock milik worker SI
// Pekerjaan worker tidak punya user; dibuat_oleh = NULL menandai "oleh sistem" (ERD)
export const WORKER_ACTOR = { userId: null, ip: null };

async function withLock(fn) {
  // Lock dipegang koneksi sesi; pekerjaannya sendiri tetap lewat pool biasa
  const conn = await sessionClient.reserve();
  try {
    const [{ locked }] = await conn`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
    if (!locked) return { dilewati: true, alasan: 'Putaran lain sedang berjalan.' };
    try {
      return await fn();
    } finally {
      await conn`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
}

async function logged(entitas, arah, fn) {
  const mulai = new Date();
  const counts = { baru: 0, ubah: 0, gagal: 0, diulang: 0, lubangDilewati: 0, terkirim: 0, gagalKirim: 0, peringatan: [] };
  let status = 'sukses';
  let pesan = null;
  let result;
  try {
    result = await fn(counts);
  } catch (err) {
    status = 'gagal';
    pesan = err.message;
    if (!(err instanceof TrackError)) throw err;
  } finally {
    await db.insert(syncLog).values({
      entitas, arah, mulai, selesai: new Date(), status,
      jmlBaru: counts.baru + counts.terkirim, jmlUbah: counts.ubah + counts.diulang, jmlGagal: counts.gagal + counts.gagalKirim,
      pesan: pesan ?? ([...counts.peringatan, counts.lubangDilewati ? `${counts.lubangDilewati} seq dilewati` : null].filter(Boolean).join(' | ') || null),
    });
  }
  return { status, pesan, counts, result };
}

export function assertEnabled() {
  if (!env.sync.enabled) throw new TrackError('Sinkronisasi dimatikan (SYNC_ENABLED=false).', { retryable: false });
}

export async function runCycle({ client } = {}) {
  assertEnabled();
  const track = client ?? createTrackClient();
  return withLock(async () => {
    const tarik = await logged('semua', 'tarik', async (counts) => {
      const muatAwal = await initialLoadIfEmpty(track, counts);
      const cursor = await pullEvents(track, counts);
      // Setelah tarik: induk yang baru tiba di putaran ini langsung melepas event yang tertahan
      await retryErrors(counts);
      return { muatAwal, cursor: cursor.cursorSeq, menungguLubang: cursor.gapSeq ?? null };
    });
    // Alur 2 tetap dijalankan walau Track sedang tidak terjangkau: antrean lokal tetap diproses
    const pembayaran = await prosesSemua(WORKER_ACTOR);
    const kirim = env.sync.writeEnabled
      ? await logged('outbox', 'kirim', (counts) => pushOutbox(track, counts))
      : {
        status: 'ditahan',
        pesan: 'SYNC_WRITE_ENABLED=false: SI tidak mengirim data ke PR Track.',
        counts: { terkirim: 0, gagalKirim: 0, peringatan: [] },
        result: null,
      };
    return { tarik, pembayaran, kirim };
  });
}

export async function runReconcile({ client } = {}) {
  assertEnabled();
  const track = client ?? createTrackClient();
  return withLock(async () => logged('semua', 'rekonsiliasi', (counts) => reconcile(track, counts)));
}
