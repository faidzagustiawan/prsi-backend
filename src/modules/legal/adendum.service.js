// src/modules/legal/adendum.service.js
//
// Adendum SPPR (ERD Alur 3): perubahan harga, jadwal, atau kavling setelah
// SPPR final. Adendum adalah dokumen baru dengan induk_id = SPPR yang sedang
// berlaku; isinya disalin dari induk lalu diubah selama draft dengan endpoint
// dokumen biasa.
//
// Finalisasi adendum, dalam satu transaksi:
//   - penjualan_keuangan menunjuk adendum dan memakai nilai SPPR barunya
//   - jadwal lama dinonaktifkan, jadwal baru dibuat; keduanya antre ke Track
//   - semua pembayaran terjurnal dialokasikan ulang ke jadwal baru
//   - biaya pindah kavling (bila ada): D Uang muka penjualan  K Pendapatan lain-lain
//
// Pindah kavling dilakukan di PR Track lebih dulu (unit berganti pada
// assignment yang sama); adendum mengambil kavling terkini dari cermin.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../config/database.js';
import { dokumen, dokumenPasal, penjualanKeuangan, jadwalAngsuran, outboxTrack } from '../../shared/schemas/penjualan.schema.js';
import { AppError } from '../../shared/utils/AppError.js';
import { toCents, centsToString, toNumber } from '../../shared/utils/money.js';
import { nextNumber, pad } from '../../shared/utils/penomoran.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { buatJurnal } from '../jurnal/jurnal.service.js';
import { akunPeran } from '../akun-sistem/akun-sistem.routes.js';
import { findAssignment, kodePembantuPembeli, saldoAkunKp } from '../penjualan/penjualan.helpers.js';
import { realokasiPenjualan } from '../penjualan/pembayaran.service.js';

const nett = (data) => toCents(data.hargaAwal ?? 0) + toCents(data.bphtb ?? 0) + toCents(data.ajbBbn ?? 0);

/** Penjualan dan SPPR yang sedang berlaku untuk dokumen ini. */
async function konteks(tx, dokumenId) {
  const [d] = await tx.select().from(dokumen).where(eq(dokumen.id, dokumenId)).for('update').limit(1);
  if (!d) throw new AppError('Dokumen tidak ditemukan.', 404);
  if (!d.assignmentId) throw new AppError('Dokumen belum terhubung ke penjualan PR Track.', 409);
  const [pj] = await tx.select().from(penjualanKeuangan).where(eq(penjualanKeuangan.assignmentId, d.assignmentId)).for('update').limit(1);
  return { d, pj };
}

export async function buat(actor, indukId, { alasan, biayaPindah = 0, tanggal }) {
  return db.transaction(async (tx) => {
    const { d: induk, pj } = await konteks(tx, indukId);
    if (!['final', 'ditandatangani'].includes(induk.status)) throw new AppError('Adendum hanya untuk SPPR yang sudah final.', 409);
    if (!pj || pj.dokumenId !== induk.id) throw new AppError('Dokumen ini bukan SPPR yang sedang berlaku. Adendum dari dokumen terbaru.', 409);
    if (pj.status !== 'aktif') throw new AppError('Penjualan sudah dibatalkan.', 409);
    const [draft] = await tx.select({ id: dokumen.id, no: dokumen.noDokumen }).from(dokumen)
      .where(and(eq(dokumen.indukId, induk.id), eq(dokumen.status, 'draft'))).limit(1);
    if (draft) throw new AppError(`Masih ada adendum draft ${draft.no}. Selesaikan atau hapus dulu.`, 409);

    const { a } = await findAssignment(tx, induk.assignmentId);
    const pindah = a.unitId !== induk.unitId;
    if (pindah && pj.tanggalBast) throw new AppError('Penjualan sudah BAST; pindah kavling tidak bisa lewat adendum.', 409);
    if (!pindah && toCents(biayaPindah) > 0n) throw new AppError('Biaya pindah hanya untuk adendum pindah kavling.', 422);

    // Jadwal yang berlaku sekarang menjadi titik awal jadwal adendum
    const aktif = await tx.select().from(jadwalAngsuran)
      .where(and(eq(jadwalAngsuran.penjualanId, pj.id), eq(jadwalAngsuran.aktif, true))).orderBy(asc(jadwalAngsuran.noUrut));
    const jadwal = induk.jadwal || aktif.length ? {
      ...(induk.jadwal ?? {}),
      baris: aktif.map((j) => ({ id: randomUUID(), tanggal: j.tanggal, jumlah: toNumber(j.jumlah), keterangan: j.keterangan ?? '' })),
    } : null;

    // Nomor adendum berurutan per SPPR asal: PRSM/2026/KPR/0001/ADD-01, ADD-02, ...
    const rootId = rootOf(induk);
    const rootNo = induk.data?.adendum?.rootNo ?? induk.noDokumen;
    const n = await nextNumber(tx, { jenis: 'adendum', scope: rootId, tahun: 0 });
    const [created] = await tx.insert(dokumen).values({
      noDokumen: `${rootNo}/ADD-${pad(n, 2)}`,
      ptId: induk.ptId,
      unitId: a.unitId,
      assignmentId: induk.assignmentId,
      templateId: induk.templateId,
      tipeTransaksi: induk.tipeTransaksi,
      tanggal: tanggal ?? new Date().toISOString().slice(0, 10),
      status: 'draft',
      indukId: induk.id,
      data: {
        ...induk.data,
        adendum: { alasan, biayaPindah, pindahKavling: pindah, unitLamaId: induk.unitId, rootId, rootNo },
      },
      jadwal,
    }).returning();

    const pasals = await tx.select().from(dokumenPasal).where(eq(dokumenPasal.dokumenId, induk.id)).orderBy(asc(dokumenPasal.urutan));
    if (pasals.length) {
      await tx.insert(dokumenPasal).values(pasals.map(({ id: _id, dokumenId: _d, ...p }) => ({ ...p, dokumenId: created.id })));
    }
    await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'dokumen', entityId: created.id, summary: `Adendum ${created.noDokumen}: ${alasan}` });
    await recordAuditTx(tx, { ...actor, action: AuditAction.UPDATE, entity: 'dokumen', entityId: created.id, field: 'status', summary: 'draft', metadata: { status: 'draft' } });
    return created.id;
  });
}

// SPPR asal dari rantai adendum; disimpan di data adendum supaya tidak perlu rekursi
const rootOf = (d) => d.data?.adendum?.rootId ?? d.indukId ?? d.id;

/**
 * Dipanggil dari finalisasi() di dalam transaksinya, setelah cek umum
 * (pembeli, harga, total jadwal = uang muka) lolos.
 */
export async function finalisasiTx(tx, actor, d) {
  const { pj } = await konteks(tx, d.id);
  if (!pj || pj.dokumenId !== d.indukId) {
    throw new AppError('SPPR induk sudah tidak berlaku (ada adendum lain yang lebih baru).', 409);
  }
  if (pj.status !== 'aktif') throw new AppError('Penjualan sudah dibatalkan.', 409);
  const { a, unit, customer } = await findAssignment(tx, d.assignmentId);
  if (a.unitId !== d.unitId) throw new AppError('Kavling di PR Track berubah lagi. Buat ulang adendum.', 409);

  const nilaiBaru = nett(d.data);
  if (pj.tanggalBast && nilaiBaru !== toCents(pj.nilaiSppr)) {
    throw new AppError('Penjualan sudah BAST; nilai SPPR tidak bisa diubah lewat adendum.', 409);
  }

  // Jadwal lama nonaktif, jadwal baru masuk; keduanya dikabarkan ke Track
  const lama = await tx.update(jadwalAngsuran).set({ aktif: false, updatedAt: new Date() })
    .where(and(eq(jadwalAngsuran.penjualanId, pj.id), eq(jadwalAngsuran.aktif, true))).returning();
  const baris = d.jadwal?.baris ?? [];
  const baru = baris.length
    ? await tx.insert(jadwalAngsuran).values(baris.map((r, i) => ({
      penjualanId: pj.id, assignmentId: a.id, dokumenId: d.id, noUrut: i + 1, tanggal: r.tanggal,
      jumlah: centsToString(toCents(r.jumlah)), keterangan: r.keterangan || `DP ${i + 1}`,
    }))).returning()
    : [];
  const kirim = [
    ...lama.map((j) => ({ jenis: 'jadwal_angsuran', refId: j.id, payload: { siJadwalId: j.id, trackAssignmentId: a.trackId, aktif: false } })),
    ...baru.map((j) => ({
      jenis: 'jadwal_angsuran', refId: j.id,
      payload: { siJadwalId: j.id, trackAssignmentId: a.trackId, noUrut: j.noUrut, tanggal: j.tanggal, jumlah: toNumber(j.jumlah), keterangan: j.keterangan, aktif: true },
    })),
  ];
  if (kirim.length) await tx.insert(outboxTrack).values(kirim);

  await tx.update(penjualanKeuangan).set({ dokumenId: d.id, nilaiSppr: centsToString(nilaiBaru), updatedAt: new Date() })
    .where(eq(penjualanKeuangan.id, pj.id));
  const dialokasi = await realokasiPenjualan(tx, actor, pj.id, a.id);

  const biaya = toCents(d.data?.adendum?.biayaPindah ?? 0);
  if (biaya > 0n) {
    const kp = await kodePembantuPembeli(tx, customer, unit.projectId);
    const um = await akunPeran(tx, 'uang_muka_penjualan');
    const saldoUm = await saldoAkunKp(tx, { akunId: um.id, kodePembantuId: kp.id, proyekId: unit.projectId });
    if (saldoUm < biaya) {
      throw new AppError(`Uang muka terkumpul (${centsToString(saldoUm)}) kurang dari biaya pindah kavling.`, 422);
    }
    const lain = await akunPeran(tx, 'pendapatan_lain');
    await buatJurnal(tx, actor, {
      tanggal: d.tanggal, uraian: `Biaya pindah kavling ${customer.nama} ke ${unit.kode} (${d.noDokumen})`,
      proyekId: unit.projectId, status: 'diposting', sumber: 'penjualan', refType: 'dokumen', refId: d.id, noReferensi: d.noDokumen,
      rows: [
        { akunId: um.id, kodePembantuId: kp.id, debit: Number(centsToString(biaya)), kredit: 0 },
        { akunId: lain.id, debit: 0, kredit: Number(centsToString(biaya)) },
      ],
    });
  }

  await recordAuditTx(tx, {
    ...actor, action: AuditAction.UPDATE, entity: 'penjualan_keuangan', entityId: pj.id,
    summary: `Adendum ${d.noDokumen}: nilai ${centsToString(toCents(pj.nilaiSppr))} -> ${centsToString(nilaiBaru)}, ${lama.length} jadwal diganti ${baru.length}, ${dialokasi} pembayaran dialokasi ulang`,
  });
}

/** Rantai SPPR + adendum untuk satu penjualan, urut waktu. */
export async function riwayat(dokumenId) {
  const [d] = await db.select().from(dokumen).where(eq(dokumen.id, dokumenId)).limit(1);
  if (!d) throw new AppError('Dokumen tidak ditemukan.', 404);
  const rootId = rootOf(d);
  const rows = await db.select().from(dokumen)
    .where(d.assignmentId ? eq(dokumen.assignmentId, d.assignmentId) : inArray(dokumen.id, [rootId, d.id]))
    .orderBy(asc(dokumen.createdAt));
  const [pj] = d.assignmentId
    ? await db.select({ dokumenId: penjualanKeuangan.dokumenId }).from(penjualanKeuangan).where(eq(penjualanKeuangan.assignmentId, d.assignmentId)).limit(1)
    : [];
  return rows
    .filter((r) => r.id === rootId || rootOf(r) === rootId)
    .map((r) => ({
      id: r.id, noDokumen: r.noDokumen, jenis: r.indukId ? 'adendum' : 'sppr', status: r.status, tanggal: r.tanggal,
      indukId: r.indukId, berlaku: pj?.dokumenId === r.id, alasan: r.data?.adendum?.alasan ?? null,
      pindahKavling: Boolean(r.data?.adendum?.pindahKavling), nilaiSppr: Number(centsToString(nett(r.data))),
    }));
}
