// src/sync/push.js
//
// Jalur SI ke Track (RancanganSistem 6): kirim outbox_track lewat PUT
// idempoten. Urutan per dokumen dijaga: bila kiriman pertama untuk satu
// ref_id gagal, kiriman berikutnya untuk ref_id itu menunggu putaran berikut.
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { outboxTrack, jadwalAngsuran } from '../shared/schemas/penjualan.schema.js';
import { TrackError } from './track-client.js';

const BATAS_PERINGATAN = 5;

async function kirim(client, row) {
  // Versi naik menurut waktu dibuat; Track menolak (409) versi yang lebih lama
  const payload = { ...row.payload, versi: row.createdAt.getTime() };
  if (row.jenis === 'jadwal_angsuran') {
    const res = await client.putSchedule(row.refId, payload, row.id);
    const trackId = res.json?.data?.track_id ?? res.json?.track_id;
    if (trackId) await db.update(jadwalAngsuran).set({ trackId, updatedAt: new Date() }).where(eq(jadwalAngsuran.id, row.refId));
    return;
  }
  if (row.jenis === 'kunci_pembayaran') {
    await client.putPaymentLock(row.payload.trackPaymentId, payload, row.id);
    return;
  }
  throw new TrackError(`Jenis outbox tidak dikenal: ${row.jenis}`, { retryable: false });
}

export async function pushOutbox(client, counts, { limit = 200 } = {}) {
  const rows = await db.select().from(outboxTrack)
    .where(inArray(outboxTrack.status, ['tertunda', 'gagal']))
    .orderBy(asc(outboxTrack.createdAt)).limit(limit);
  const tertahan = new Set();

  for (const row of rows) {
    if (tertahan.has(row.refId)) continue;
    try {
      await kirim(client, row);
      await db.update(outboxTrack).set({ status: 'terkirim', dikirimPada: new Date(), galatTerakhir: null }).where(eq(outboxTrack.id, row.id));
      counts.terkirim += 1;
    } catch (err) {
      if (err instanceof TrackError && err.status === 409) {
        // Track sudah punya versi yang lebih baru: kiriman ini dianggap diterapkan
        await db.update(outboxTrack).set({ status: 'terkirim', dikirimPada: new Date(), galatTerakhir: 'versi lebih lama (409)' }).where(eq(outboxTrack.id, row.id));
        counts.terkirim += 1;
        continue;
      }
      if (!(err instanceof TrackError)) throw err;
      tertahan.add(row.refId);
      const percobaan = row.percobaan + 1;
      await db.update(outboxTrack).set({ status: 'gagal', percobaan, galatTerakhir: err.message.slice(0, 500) }).where(eq(outboxTrack.id, row.id));
      counts.gagalKirim += 1;
      if (percobaan >= BATAS_PERINGATAN) counts.peringatan.push(`Outbox ${row.jenis} ${row.refId} gagal ${percobaan}x: ${err.message}`);
    }
  }
}
