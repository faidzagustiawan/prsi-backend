// src/modules/penjualan/pembayaran.service.js
//
// Alur 2: pembayaran PR Track menjadi jurnal. Dipanggil worker sinkronisasi
// setiap ada pembayaran baru/berubah di trk_payments, dan dari layar
// Keuangan untuk memproses ulang.
//
//   belum terverifikasi di Track      -> menunggu
//   gagal cek berat (penjualan, jenis,
//     rekening tujuan tidak dikenal)   -> gagal_validasi, tanpa jurnal
//   gagal cek ringan (bukti, duplikat,
//     periode terkunci)                -> gagal_validasi, jurnal draft untuk dilengkapi Keuangan
//   lolos                              -> jurnal diposting, dialokasikan ke jadwal, dijurnal
//   sudah dijurnal lalu berubah/dihapus
//     di Track                          -> perlu_ditinjau; jurnal TIDAK diubah otomatis
//
// Akun kredit: booking fee -> Titipan booking fee; sebelum BAST -> Uang muka
// penjualan; sejak tanggal BAST -> Piutang penjualan.
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { trkPayments, trkAssignments, statusPembayaranSi } from '../../shared/schemas/track.schema.js';
import { akun, lampiran, jurnal } from '../../shared/schemas/akuntansi.schema.js';
import { penjualanKeuangan, jadwalAngsuran, alokasiPembayaran, outboxTrack } from '../../shared/schemas/penjualan.schema.js';
import { AppError } from '../../shared/utils/AppError.js';
import { toCents, centsToString, toNumber } from '../../shared/utils/money.js';
import { JENIS_PEMBAYARAN } from '../../shared/constants.js';
import { buatJurnal, postingTx, hapusJurnalModulTx, registerAfterPosting, registerAfterReverse } from '../jurnal/jurnal.service.js';
import * as jurnalRepo from '../jurnal/jurnal.repository.js';
import { akunPeran } from '../akun-sistem/akun-sistem.routes.js';
import { findAssignment, kodePembantuPembeli } from './penjualan.helpers.js';

export const REF = 'trk_payments';
const digits = (s) => String(s ?? '').replace(/\D/g, '');

async function setStatus(tx, paymentId, statusProses, { jurnalId = null, alasan = null } = {}) {
  await tx.insert(statusPembayaranSi).values({ paymentId, statusProses, jurnalId, alasan })
    .onConflictDoUpdate({ target: statusPembayaranSi.paymentId, set: { statusProses, jurnalId, alasan, updatedAt: new Date() } });
  return { paymentId, statusProses, jurnalId, alasan };
}

async function akunKasDariRekening(tx, rekening) {
  const d = digits(rekening);
  if (!d) return null;
  const [row] = await tx.select().from(akun)
    .where(and(eq(akun.isKasBank, true), eq(akun.aktif, true), sql`regexp_replace(coalesce(${akun.noRekening}, ''), '\\D', '', 'g') = ${d}`))
    .limit(1);
  return row ?? null;
}

async function penjualanOf(tx, assignmentId) {
  const [pj] = await tx.select().from(penjualanKeuangan).where(eq(penjualanKeuangan.assignmentId, assignmentId)).limit(1);
  return pj ?? null;
}

async function akunKredit(tx, p, pj) {
  if (p.jenis === 'booking_fee') return akunPeran(tx, 'titipan_booking_fee');
  if (pj?.tanggalBast && p.tanggal >= pj.tanggalBast) return akunPeran(tx, 'piutang_penjualan');
  return akunPeran(tx, 'uang_muka_penjualan');
}

async function isDuplikat(tx, p) {
  const [dupe] = await tx.select({ id: trkPayments.id }).from(trkPayments)
    .innerJoin(statusPembayaranSi, eq(statusPembayaranSi.paymentId, trkPayments.id))
    .where(and(
      eq(trkPayments.assignmentId, p.assignmentId), eq(trkPayments.tanggal, p.tanggal), eq(trkPayments.nominal, p.nominal),
      ne(trkPayments.id, p.id), eq(statusPembayaranSi.statusProses, 'dijurnal'),
    )).limit(1);
  return Boolean(dupe);
}

/** Bukti dari Track dicatat sebagai lampiran tautan (sumber pr_track). */
async function lampiranBukti(tx, jurnalId, p) {
  if (!p.buktiUrl) return;
  let first = p.buktiUrl;
  try {
    const parsed = JSON.parse(p.buktiUrl);
    if (Array.isArray(parsed)) [first] = parsed;
  } catch {
    // bukti_pembayaran Track bisa berupa URL tunggal atau array JSON
  }
  if (!/^https:\/\//i.test(String(first))) return;
  const nama = decodeURIComponent(String(first).split('/').pop()?.split('?')[0] || 'bukti-transfer').slice(0, 255);
  await tx.insert(lampiran).values({
    entityType: 'jurnal', entityId: jurnalId, namaFile: nama, path: String(first).slice(0, 255),
    mime: /\.pdf$/i.test(nama) ? 'application/pdf' : 'image/jpeg', ukuran: 0, sumber: 'pr_track',
  });
}

/** Lepas jurnal draft hasil proses sebelumnya supaya pembayaran bisa diproses ulang. */
async function lepasDraftLama(tx, actor, status) {
  if (!status?.jurnalId) return;
  const j = await jurnalRepo.lockJurnal(tx, status.jurnalId);
  if (!j || j.status !== 'draft') return;
  await tx.delete(lampiran).where(and(eq(lampiran.entityType, 'jurnal'), eq(lampiran.entityId, j.id), eq(lampiran.sumber, 'pr_track')));
  await tx.update(statusPembayaranSi).set({ jurnalId: null }).where(eq(statusPembayaranSi.paymentId, status.paymentId));
  await hapusJurnalModulTx(tx, actor, j.id);
}

/** Pembayaran yang sudah dijurnal berubah di Track? (tanggal, nominal, hapus) */
async function berubahSejakDijurnal(tx, p, status) {
  if (p.isDeleted) return 'Pembayaran dihapus di PR Track setelah dijurnal.';
  const j = status.jurnalId ? await jurnalRepo.findJurnal(status.jurnalId, tx) : null;
  if (!j) return 'Jurnal pembayaran tidak ditemukan.';
  if (j.status === 'dikoreksi') return null;
  const { rowsByJurnal } = await jurnalRepo.loadChildren([j.id], tx);
  const total = (rowsByJurnal.get(j.id) ?? []).reduce((s, r) => s + toCents(r.debit), 0n);
  if (total !== toCents(p.nominal)) return `Nominal di Track berubah: ${p.nominal} (jurnal ${centsToString(total)}).`;
  if (j.tanggal !== p.tanggal) return `Tanggal di Track berubah: ${p.tanggal} (jurnal ${j.tanggal}).`;
  return null;
}

export async function prosesPembayaranTx(tx, actor, paymentId) {
  const [p] = await tx.select().from(trkPayments).where(eq(trkPayments.id, paymentId)).for('update').limit(1);
  if (!p) throw new AppError('Pembayaran tidak ditemukan.', 404);
  const [status] = await tx.select().from(statusPembayaranSi).where(eq(statusPembayaranSi.paymentId, p.id)).limit(1);

  if (status && ['dijurnal', 'perlu_ditinjau'].includes(status.statusProses)) {
    const j = status.jurnalId ? await jurnalRepo.findJurnal(status.jurnalId, tx) : null;
    if (!(status.statusProses === 'perlu_ditinjau' && j?.status === 'dikoreksi')) {
      const alasan = await berubahSejakDijurnal(tx, p, status);
      return alasan ? setStatus(tx, p.id, 'perlu_ditinjau', { jurnalId: status.jurnalId, alasan }) : status;
    }
    // Keuangan sudah membalik jurnal lama: alokasi dilepas, diproses dari awal
    await tx.delete(alokasiPembayaran).where(eq(alokasiPembayaran.paymentId, p.id));
  } else {
    await lepasDraftLama(tx, actor, status);
  }

  if (p.isDeleted) return setStatus(tx, p.id, 'menunggu', { alasan: 'Pembayaran dihapus di PR Track.' });
  if (p.isAutoInject) {
    return setStatus(tx, p.id, 'menunggu', { alasan: 'Auto-injeksi pencairan KPR di Track; dijurnal saat dana bank benar-benar cair.' });
  }
  if (p.statusVerifikasi !== 'terverifikasi') return setStatus(tx, p.id, 'menunggu', { alasan: 'Belum diverifikasi admin PR Track.' });

  const berat = [];
  const [asg] = await tx.select().from(trkAssignments).where(eq(trkAssignments.id, p.assignmentId)).limit(1);
  if (!asg || asg.isDeleted) berat.push('Penjualan tidak ada di cermin PR Track.');
  if (!JENIS_PEMBAYARAN.includes(p.jenis)) berat.push(`Jenis pembayaran tidak dikenal: ${p.jenis ?? '-'}.`);
  if (!(toCents(p.nominal) > 0n)) berat.push('Nominal harus lebih dari 0.');
  const kas = await akunKasDariRekening(tx, p.rekeningTujuan);
  if (!kas) berat.push(`Rekening tujuan ${p.rekeningTujuan ?? '-'} tidak cocok dengan akun kas/bank mana pun.`);
  if (berat.length) return setStatus(tx, p.id, 'gagal_validasi', { alasan: berat.join(' ') });

  const { unit, customer } = await findAssignment(tx, p.assignmentId);
  const pj = await penjualanOf(tx, p.assignmentId);
  const kredit = await akunKredit(tx, p, pj);
  const kp = await kodePembantuPembeli(tx, customer, unit.projectId);
  const nominal = toNumber(p.nominal);

  const j = await buatJurnal(tx, actor, {
    tanggal: p.tanggal,
    uraian: `Pembayaran ${p.jenis.replace('_', ' ')} ${customer.nama} kavling ${unit.kode}`,
    proyekId: unit.projectId, status: 'draft', sumber: 'pr_track', refType: REF, refId: p.id,
    rows: [
      { akunId: kas.id, debit: nominal, kredit: 0 },
      { akunId: kredit.id, kodePembantuId: kp.id, debit: 0, kredit: nominal },
    ],
  });
  await lampiranBukti(tx, j.id, p);
  await setStatus(tx, p.id, 'menunggu', { jurnalId: j.id });

  const ringan = [];
  if (!p.buktiUrl) ringan.push('Bukti transfer tidak tersedia di PR Track.');
  if (await isDuplikat(tx, p)) ringan.push('Terindikasi duplikat: pembayaran lain dengan tanggal dan nominal sama sudah dijurnal.');
  if (!ringan.length) {
    try {
      // afterPosting (di bawah) mengalokasikan dan menandai dijurnal
      await postingTx(tx, actor, j.id);
      const [done] = await tx.select().from(statusPembayaranSi).where(eq(statusPembayaranSi.paymentId, p.id)).limit(1);
      return done;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      ringan.push(...(err.errors?.length ? err.errors : [err.message]));
    }
  }
  return setStatus(tx, p.id, 'gagal_validasi', { jurnalId: j.id, alasan: ringan.join(' ') });
}

/**
 * Alokasi ke jadwal angsuran aktif, terlama lebih dulu (ERD Alur 2). Booking
 * fee, pencairan KPR, dan lebih bayar disimpan dengan jadwal_id kosong.
 */
export async function alokasikan(tx, actor, p) {
  const pj = await penjualanOf(tx, p.assignmentId);
  if (!pj) return;
  await tx.delete(alokasiPembayaran).where(and(eq(alokasiPembayaran.paymentId, p.id), eq(alokasiPembayaran.manual, false)));
  let sisa = toCents(p.nominal);
  const rows = [];
  if (['uang_muka', 'angsuran'].includes(p.jenis)) {
    const jadwal = await tx.select().from(jadwalAngsuran)
      .where(and(eq(jadwalAngsuran.penjualanId, pj.id), eq(jadwalAngsuran.aktif, true))).orderBy(asc(jadwalAngsuran.tanggal), asc(jadwalAngsuran.noUrut));
    const terpakai = jadwal.length
      ? await tx.select({ jadwalId: alokasiPembayaran.jadwalId, total: sql`SUM(${alokasiPembayaran.nominal})` }).from(alokasiPembayaran)
        .where(inArray(alokasiPembayaran.jadwalId, jadwal.map((x) => x.id))).groupBy(alokasiPembayaran.jadwalId)
      : [];
    const used = new Map(terpakai.map((t) => [t.jadwalId, toCents(t.total)]));
    for (const row of jadwal) {
      if (sisa <= 0n) break;
      const ruang = toCents(row.jumlah) - (used.get(row.id) ?? 0n);
      if (ruang <= 0n) continue;
      const ambil = ruang < sisa ? ruang : sisa;
      rows.push({ paymentId: p.id, penjualanId: pj.id, jadwalId: row.id, nominal: centsToString(ambil) });
      sisa -= ambil;
    }
  }
  if (sisa > 0n) rows.push({ paymentId: p.id, penjualanId: pj.id, jadwalId: null, nominal: centsToString(sisa) });
  if (rows.length) await tx.insert(alokasiPembayaran).values(rows.map((r) => ({ ...r, diubahOleh: actor.userId ?? null })));
}

registerAfterPosting(REF, async (tx, actor, j) => {
  const [p] = await tx.select().from(trkPayments).where(eq(trkPayments.id, j.refId)).limit(1);
  if (!p) return;
  await alokasikan(tx, actor, p);
  await setStatus(tx, p.id, 'dijurnal', { jurnalId: j.id });
  // Track mengunci pembayaran ini supaya tidak diubah setelah dibukukan
  await tx.insert(outboxTrack).values({
    jenis: 'kunci_pembayaran', refId: p.id, payload: { trackPaymentId: p.trackId, jurnal: j.noBukti, terkunci: true },
  });
});

// Jurnal pembayaran dibalik Keuangan: alokasinya dilepas dan pembayaran
// menunggu ditinjau / diproses ulang.
registerAfterReverse(REF, async (tx, _actor, j) => {
  await tx.delete(alokasiPembayaran).where(eq(alokasiPembayaran.paymentId, j.refId));
  await setStatus(tx, j.refId, 'perlu_ditinjau', { jurnalId: j.id, alasan: 'Jurnal pembayaran dibalik. Proses ulang setelah data benar.' });
});

export async function proses(actor, paymentId) {
  return db.transaction((tx) => prosesPembayaranTx(tx, actor, paymentId));
}

/**
 * Proses semua yang perlu: belum pernah diproses, masih menunggu, atau sudah
 * dijurnal tetapi barisnya disinkron ulang setelah diproses (cek perubahan).
 */
export async function prosesSemua(actor) {
  const rows = await db.select({ id: trkPayments.id }).from(trkPayments)
    .leftJoin(statusPembayaranSi, eq(statusPembayaranSi.paymentId, trkPayments.id))
    .where(or(
      isNull(statusPembayaranSi.paymentId),
      eq(statusPembayaranSi.statusProses, 'menunggu'),
      and(eq(statusPembayaranSi.statusProses, 'dijurnal'), sql`${trkPayments.syncedAt} > ${statusPembayaranSi.updatedAt}`),
    ))
    .orderBy(asc(trkPayments.tanggal));
  const hasil = { diproses: 0, dijurnal: 0, menunggu: 0, gagal_validasi: 0, perlu_ditinjau: 0 };
  for (const { id } of rows) {
    const s = await proses(actor, id);
    hasil.diproses += 1;
    hasil[s.statusProses] += 1;
  }
  return hasil;
}

export async function list({ statusProses, assignmentId }) {
  const f = [];
  if (statusProses) f.push(statusProses === 'belum_diproses' ? isNull(statusPembayaranSi.paymentId) : eq(statusPembayaranSi.statusProses, statusProses));
  if (assignmentId) f.push(eq(trkPayments.assignmentId, assignmentId));
  const rows = await db.select({ p: trkPayments, s: statusPembayaranSi, noBukti: jurnal.noBukti, jurnalStatus: jurnal.status })
    .from(trkPayments)
    .leftJoin(statusPembayaranSi, eq(statusPembayaranSi.paymentId, trkPayments.id))
    .leftJoin(jurnal, eq(jurnal.id, statusPembayaranSi.jurnalId))
    .where(f.length ? and(...f) : undefined)
    .orderBy(asc(trkPayments.tanggal));
  return rows.map(({ p, s, noBukti, jurnalStatus }) => ({
    id: p.id, trackId: p.trackId, assignmentId: p.assignmentId, tanggal: p.tanggal, nominal: toNumber(p.nominal), jenis: p.jenis,
    statusVerifikasi: p.statusVerifikasi, rekeningTujuan: p.rekeningTujuan, buktiUrl: p.buktiUrl, isAutoInject: p.isAutoInject,
    isDeleted: p.isDeleted, statusProses: s?.statusProses ?? 'belum_diproses', alasan: s?.alasan ?? null,
    jurnalId: s?.jurnalId ?? null, nomorJurnal: noBukti ?? null, jurnalStatus: jurnalStatus ?? null,
  }));
}
