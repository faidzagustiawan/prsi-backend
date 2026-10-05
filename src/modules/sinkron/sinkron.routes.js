// src/modules/sinkron/sinkron.routes.js
//
// Pemantauan sinkronisasi (RancanganSistem 7.4) dan tombol "Sinkron sekarang".
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { env } from '../../config/env.js';
import { syncLog, syncError, statusPembayaranSi } from '../../shared/schemas/track.schema.js';
import { outboxTrack } from '../../shared/schemas/penjualan.schema.js';
import { authorize } from '../../middleware/authorize.js';
import { AppError } from '../../shared/utils/AppError.js';
import { getCursor } from '../../sync/pull.js';
import { runCycle, runReconcile } from '../../sync/runner.js';
import { TrackError } from '../../sync/track-client.js';

const tags = ['Sinkronisasi PR Track'];

// Ambang peringatan (RancanganSistem 7.4)
const JEDA_MAKS_MENIT = 15;

async function status() {
  const cursor = await getCursor();
  const [terakhir] = await db.select().from(syncLog).where(and(eq(syncLog.arah, 'tarik'), eq(syncLog.status, 'sukses')))
    .orderBy(desc(syncLog.mulai)).limit(1);
  const [rekon] = await db.select().from(syncLog).where(eq(syncLog.arah, 'rekonsiliasi')).orderBy(desc(syncLog.mulai)).limit(1);
  const [{ errorTerbuka }] = await db.select({ errorTerbuka: count() }).from(syncError).where(isNull(syncError.resolvedAt));
  const outbox = await db.select({ status: outboxTrack.status, n: count(), maks: sql`MAX(${outboxTrack.percobaan})`.mapWith(Number) })
    .from(outboxTrack).where(inArray(outboxTrack.status, ['tertunda', 'gagal'])).groupBy(outboxTrack.status);
  const antrean = await db.select({ status: statusPembayaranSi.statusProses, n: count() }).from(statusPembayaranSi)
    .where(inArray(statusPembayaranSi.statusProses, ['menunggu', 'gagal_validasi', 'perlu_ditinjau'])).groupBy(statusPembayaranSi.statusProses);

  const jedaMenit = terakhir ? Math.round((Date.now() - terakhir.selesai.getTime()) / 60000) : null;
  const peringatan = [];
  if (!env.sync.enabled) peringatan.push('Sinkronisasi dimatikan (SYNC_ENABLED=false).');
  if (env.sync.enabled && (jedaMenit === null || jedaMenit > JEDA_MAKS_MENIT)) peringatan.push(`Data Track tertinggal ${jedaMenit ?? '?'} menit.`);
  if (Number(errorTerbuka) > 0) peringatan.push(`${errorTerbuka} event Track gagal diterapkan.`);
  const gagal = outbox.find((o) => o.status === 'gagal');
  if (gagal?.maks >= 5) peringatan.push(`${gagal.n} kiriman ke Track gagal berulang.`);
  if (rekon?.status === 'gagal') peringatan.push(`Rekonsiliasi terakhir gagal: ${rekon.pesan}`);
  const v2 = env.sync.protocol === 'v2';
  // v2: gap_since = event tertahan transaksi Track yang masih terbuka
  if (v2 && cursor.gapSince && (Date.now() - cursor.gapSince.getTime()) / 1000 >= env.sync.heldWarnSec) {
    peringatan.push(`Event Track tertahan transaksi terbuka sejak ${cursor.gapSince.toISOString()}.`);
  }

  return {
    aktif: env.sync.enabled,
    protokol: env.sync.protocol,
    cursor: v2 ? `${cursor.cursorTxid ?? 0}:${cursor.cursorSeq}` : String(cursor.cursorSeq),
    cursorSeq: cursor.cursorSeq,
    menungguLubangSeq: v2 ? null : cursor.gapSeq,
    tertahanSejak: v2 ? cursor.gapSince : null,
    dataTrackPer: terakhir?.selesai ?? null,
    jedaMenit,
    errorTerbuka: Number(errorTerbuka),
    outbox: Object.fromEntries(outbox.map((o) => [o.status, Number(o.n)])),
    antreanPembayaran: Object.fromEntries(antrean.map((a) => [a.status, Number(a.n)])),
    rekonsiliasiTerakhir: rekon ? { waktu: rekon.mulai, status: rekon.status, pesan: rekon.pesan } : null,
    peringatan,
  };
}

const runOrFail = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TrackError) throw new AppError(err.message, err.retryable ? 502 : 409);
    throw err;
  }
};

export default async function sinkronRoutes(fastify) {
  const guard = [fastify.authenticate, authorize('keuangan', 'admin')];

  fastify.get('/status', { preHandler: guard, schema: { tags, description: 'Kesehatan sinkronisasi: jeda data, error, outbox, antrean pembayaran' } },
    async () => ({ success: true, message: 'Success', data: await status() }));

  fastify.get('/log', { preHandler: guard, schema: { tags, description: '50 log putaran terakhir' } }, async () => ({
    success: true, message: 'Success', data: await db.select().from(syncLog).orderBy(desc(syncLog.mulai)).limit(50),
  }));

  fastify.get('/error', { preHandler: guard, schema: { tags, description: 'Event Track yang belum berhasil diterapkan' } }, async () => ({
    success: true, message: 'Success',
    data: (await db.select().from(syncError).where(isNull(syncError.resolvedAt)).orderBy(desc(syncError.createdAt)).limit(200))
      .map((e) => ({ id: e.id, seq: e.seq, entity: e.entity, trackId: e.entityTrackId, alasan: e.alasan, percobaan: e.percobaan, createdAt: e.createdAt })),
  }));

  fastify.post('/jalankan', {
    preHandler: guard, config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    schema: { tags, description: 'Jalankan satu putaran sekarang (tombol "Sinkron" di halaman Piutang)' },
  }, async () => ({ success: true, message: 'Sinkronisasi selesai', data: await runOrFail(() => runCycle()) }));

  fastify.post('/rekonsiliasi', {
    preHandler: [fastify.authenticate, authorize('admin', 'keuangan')], config: { rateLimit: { max: 2, timeWindow: '1 minute' } },
    schema: { tags, description: 'Jalankan rekonsiliasi checksum sekarang' },
  }, async () => ({ success: true, message: 'Rekonsiliasi selesai', data: await runOrFail(() => runReconcile()) }));
}
