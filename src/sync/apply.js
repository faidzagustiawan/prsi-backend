// src/sync/apply.js
//
// Menerapkan satu perubahan dari Track ke tabel cermin (RancanganSistem 5.3).
// Idempoten dan berversi: perubahan dengan row_version <= yang tersimpan
// diabaikan, jadi event ganda atau snapshot yang tumpang tindih aman.
import { eq } from 'drizzle-orm';
import { trkClusters } from '../shared/schemas/track.schema.js';
import { ENTITIES } from './mapping.js';

export class ApplyError extends Error {
  /** kind: 'induk' (induk belum ada, diulang nanti) atau 'data' (payload tidak lolos validasi) */
  constructor(kind, message) {
    super(message);
    this.name = 'ApplyError';
    this.kind = kind;
  }
}

async function localId(tx, entity, trackId) {
  const { table } = ENTITIES[entity];
  const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.trackId, trackId)).limit(1);
  return row?.id ?? null;
}

/**
 * change: { entity, trackId, op: 'I'|'U'|'D', rowVersion, seq?, payload, snapshot? }
 * snapshot = true: baris dari snapshot (keadaan Track saat ini), versi yang
 * sama tetap ditimpa supaya rekonsiliasi bisa memulihkan baris yang keliru.
 * Hasil: 'baru' | 'ubah' | 'hapus' | 'abaikan'
 * Invarian: ApplyError hanya dilempar SEBELUM ada tulis, jadi pemanggil boleh
 * melanjutkan transaksi yang sama tanpa savepoint (lihat applyBatch di pull.js).
 */
export async function applyChange(tx, change) {
  const def = ENTITIES[change.entity];
  if (!def) throw new ApplyError('data', `Entitas tidak dikenal: ${change.entity}`);
  const { table } = def;

  const [existing] = await tx.select({ id: table.id, rowVersion: table.rowVersion, isDeleted: table.isDeleted })
    .from(table).where(eq(table.trackId, change.trackId)).for('update').limit(1);
  if (existing && (change.snapshot ? change.rowVersion < existing.rowVersion : change.rowVersion <= existing.rowVersion)) return 'abaikan';

  const meta = { rowVersion: change.rowVersion, trackSeq: change.seq ?? null, syncedAt: new Date() };

  if (change.op === 'D') {
    if (!existing) return 'abaikan';
    await tx.update(table).set({ ...meta, isDeleted: true }).where(eq(table.id, existing.id));
    return 'hapus';
  }

  const parsed = def.schema.safeParse(change.payload ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '-'}: ${i.message}`).join('; ');
    throw new ApplyError('data', `Payload ${change.entity} tidak valid: ${detail}`);
  }
  const p = parsed.data;

  const ids = {};
  for (const [fk, parentEntity] of Object.entries(def.parents)) {
    ids[fk] = await localId(tx, parentEntity, p[fk]);
    if (!ids[fk]) throw new ApplyError('induk', `${parentEntity} ${p[fk]} belum ada di cermin.`);
  }
  const extra = {};
  if (change.entity === 'units') {
    const [c] = await tx.select({ projectId: trkClusters.projectId }).from(trkClusters).where(eq(trkClusters.id, ids.cluster_id)).limit(1);
    extra.projectId = c.projectId;
  }

  const values = { ...def.toRow(p, ids, extra), ...meta, isDeleted: false, raw: change.payload };
  if (existing) {
    await tx.update(table).set(values).where(eq(table.id, existing.id));
    return 'ubah';
  }
  await tx.insert(table).values({ ...values, trackId: change.trackId });
  return 'baru';
}
