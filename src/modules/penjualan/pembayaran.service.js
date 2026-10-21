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
//     posting ditolak)                 -> gagal_validasi, jurnal draft untuk dilengkapi Keuangan
//   jurnal tidak dapat dibuat (sebelum
//     saldo awal, periode terkunci)     -> gagal_validasi tanpa jurnal; batch tetap lanjut
//   lolos                              -> jurnal diposting, dialokasikan ke jadwal, dijurnal
//   tanpa tagihan, tanggal sebelum saldo
//     awal proyek, dicatat sebelum cutover -> historis: dialokasikan, tidak dijurnal (Opsi A)
//   sudah dijurnal lalu berubah/dihapus
//     di Track                          -> perlu_ditinjau; jurnal TIDAK diubah otomatis
//
// Akun kredit: booking fee -> Titipan booking fee; sebelum BAST -> Uang muka
// penjualan; sejak tanggal BAST -> Piutang penjualan.
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../../config/database.js';
import { trkPayments, trkAssignments, trkUnits, statusPembayaranSi } from '../../shared/schemas/track.schema.js';
import { akun, lampiran, jurnal, saldoAwalPeriode } from '../../shared/schemas/akuntansi.schema.js';
import { penjualanKeuangan, jadwalAngsuran, alokasiPembayaran, outboxTrack } from '../../shared/schemas/penjualan.schema.js';
import { AppError } from '../../shared/utils/AppError.js';
import { toCents, centsToString, toNumber } from '../../shared/utils/money.js';
import { JENIS_PEMBAYARAN } from '../../shared/constants.js';
import { buatJurnal, postingTx, hapusJurnalModulTx, registerAfterPosting, registerAfterReverse, registerPostingGuard } from '../jurnal/jurnal.service.js';
import * as jurnalRepo from '../jurnal/jurnal.repository.js';
import { akunPeran } from '../akun-sistem/akun-sistem.routes.js';
import { findAssignment, kodePembantuPembeli } from './penjualan.helpers.js';
import { enqueueBill, enqueuePaymentResult } from '../../sync/billing-outbox.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { env } from '../../config/env.js';

export const REF = 'trk_payments';
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const verificationHash = p => createHash('sha256').update(JSON.stringify([
  p.assignmentId,p.siJadwalId,p.nominal,p.tanggal,p.jenis,p.rekeningTujuan,p.buktiUrl,p.isDeleted,p.isAutoInject,
])).digest('hex');

async function validateSelectedBill(tx,p) {
  const [pj]=await tx.select().from(penjualanKeuangan).where(eq(penjualanKeuangan.assignmentId,p.assignmentId)).for('update');
  if(!pj || pj.status!=='aktif') throw new AppError('Penjualan sudah tidak aktif.',409);
  const [bill] = await tx.select().from(jadwalAngsuran).where(eq(jadwalAngsuran.id,p.siJadwalId)).for('update');
  if (!bill || !bill.aktif || bill.assignmentId !== p.assignmentId) throw new AppError('Tagihan tidak aktif atau bukan milik penjualan pembayaran.',409);
  const [{used}] = await tx.select({used:sql`coalesce(sum(${alokasiPembayaran.nominal}),0)::text`}).from(alokasiPembayaran)
    .where(and(eq(alokasiPembayaran.jadwalId,bill.id),ne(alokasiPembayaran.paymentId,p.id)));
  if (toCents(bill.jumlah)-toCents(used) !== toCents(p.nominal) || toCents(p.nominal)<=0n) throw new AppError('Nominal pembayaran tidak sama dengan sisa tagihan atau tagihan sudah lunas.',409);
  if (bill.jenis!==p.jenis) throw new AppError('Jenis pembayaran tidak sesuai tagihan.',409);
  return bill;
}

// Pembayaran tanpa tagihan ditahan selama billing aktif tetapi waktu cutover belum ditetapkan.
const legacyHeld = () => env.billingEnabled && !env.legacyCutoverAt;
const ditahan = (message) => Object.assign(new AppError(message, 409), { hold: true });
export const PENANDA_SALDO_AWAL = 'SALDO-AWAL';

// Produksi Track tidak menyimpan jenis untuk pembayaran lama (keputusan pemilik 21 Oktober
// 2026: lainnya dianggap uang muka; auto-injeksi KPR sudah dikecualikan lebih awal).
const jenisPembayaran = (p) => p.jenis ?? 'uang_muka';

/**
 * Opsi A: pembayaran tanpa tagihan yang bertanggal sebelum tanggal mulai saldo awal
 * proyek sudah terwakili saldo awal customer. Dialokasikan ke tagihan supaya sisa
 * tagihan benar, tetapi tidak dijurnal. Pembayaran yang tercatat sebelum cutover
 * dianggap sah walau belum berstatus terverifikasi (keputusan pemilik 21 Oktober
 * 2026), kecuali ditolak di Track. Mengembalikan null bila pembayaran diproses
 * jalur legacy biasa.
 */
async function klasifikasiPembayaranLama(tx, actor, p) {
  if (legacyHeld()) throw ditahan('Pembayaran tanpa tagihan ditahan: SI_LEGACY_CUTOVER_AT belum ditetapkan.');
  if (!env.legacyCutoverAt) return null;
  const [asg] = await tx.select().from(trkAssignments).where(eq(trkAssignments.id, p.assignmentId)).limit(1);
  if (!asg || asg.isDeleted) return null;
  const { unit } = await findAssignment(tx, p.assignmentId);
  const saldoAwal = await jurnalRepo.findSaldoAwalPeriode(unit.projectId, tx);
  if (saldoAwal?.status !== 'terkunci') throw ditahan('Pembayaran tanpa tagihan ditahan: saldo awal proyek belum dikunci.');
  if (p.tanggal >= saldoAwal.tanggalMulai) return null;
  if (p.statusVerifikasi === 'ditolak') return null;
  if (p.sourceCreatedAt && p.sourceCreatedAt >= env.legacyCutoverAt) {
    return setStatus(tx, p.id, 'perlu_ditinjau', {
      alasan: `Dicatat di PR Track sesudah cutover dengan tanggal ${p.tanggal}, sebelum saldo awal proyek (${saldoAwal.tanggalMulai}). Pastikan belum termasuk saldo awal.`,
    });
  }
  if (!(toCents(p.nominal) > 0n) || !JENIS_PEMBAYARAN.includes(jenisPembayaran(p))) {
    return setStatus(tx, p.id, 'perlu_ditinjau', {
      alasan: 'Pembayaran lama dengan nominal atau jenis tidak lazim (mis. pengembalian dana); tangani manual terhadap saldo awal.',
    });
  }
  await alokasikan(tx, actor, p);
  const tagihan = await tx.selectDistinct({ id: alokasiPembayaran.jadwalId }).from(alokasiPembayaran)
    .where(and(eq(alokasiPembayaran.paymentId, p.id), isNotNull(alokasiPembayaran.jadwalId)));
  for (const { id } of tagihan) await enqueueBill(tx, id);
  const hasil = await setStatus(tx, p.id, 'historis', { alasan: `Termasuk saldo awal proyek (mulai ${saldoAwal.tanggalMulai}); tidak dijurnal.` });
  // Sidik isi saat dicatat, untuk mendeteksi perubahan di Track sesudahnya.
  await tx.update(statusPembayaranSi).set({ verificationHash: verificationHash(p) }).where(eq(statusPembayaranSi.paymentId, p.id));
  await tx.insert(outboxTrack).values({
    jenis: 'kunci_pembayaran', refId: p.id, payload: { trackPaymentId: p.trackId, jurnal: PENANDA_SALDO_AWAL, terkunci: true },
  });
  return hasil;
}

/** Alokasikan ulang pembayaran historis satu assignment, mis. setelah SPPR difinalkan. */
export async function alokasiHistoris(tx, actor, assignmentId) {
  const rows = await tx.select({ p: trkPayments }).from(trkPayments)
    .innerJoin(statusPembayaranSi, eq(statusPembayaranSi.paymentId, trkPayments.id))
    .where(and(eq(trkPayments.assignmentId, assignmentId), eq(statusPembayaranSi.statusProses, 'historis')))
    .orderBy(asc(trkPayments.tanggal), asc(trkPayments.syncedAt));
  for (const { p } of rows) await alokasikan(tx, actor, p);
  return rows.length;
}

export async function verifikasi(actor,id,{keputusan,alasan=null}) {
  if (!env.billingEnabled) throw new AppError('Fitur tagihan SI belum diaktifkan.',409);
  return db.transaction(async tx => {
    const [p] = await tx.select().from(trkPayments).where(eq(trkPayments.id,id)).for('update');
    if (!p || !p.siJadwalId || p.isDeleted) throw new AppError('Pembayaran berbasis tagihan tidak ditemukan.',404);
    const [s] = await tx.select().from(statusPembayaranSi).where(eq(statusPembayaranSi.paymentId,id));
    if (s?.jurnalId) {
      const j=await jurnalRepo.findJurnal(s.jurnalId,tx);
      if (j?.status==='diposting') {
        if (keputusan==='terima' && s.verificationHash===verificationHash(p)) return s;
        throw new AppError('Balik jurnal terlebih dahulu sebelum mengubah keputusan.',409);
      }
    }
    if (keputusan==='terima') await validateSelectedBill(tx,p);
    await tx.insert(statusPembayaranSi).values({paymentId:id,statusProses:'menunggu'})
      .onConflictDoNothing();
    await tx.update(statusPembayaranSi).set({keputusan,verificationHash:verificationHash(p),diverifikasiOlehSi:actor.userId,diverifikasiPadaSi:new Date()})
      .where(eq(statusPembayaranSi.paymentId,id));
    await recordAuditTx(tx,{...actor,action:AuditAction.UPDATE,entity:'status_pembayaran_si',entityId:id,summary:`Verifikasi SI: ${keputusan}`,metadata:{alasan}});
    if (keputusan==='tolak') {
      await lepasDraftLama(tx,actor,s);
      await enqueuePaymentResult(tx,p,'ditolak',{alasan});
      return setStatus(tx,id,'ditolak',{alasan});
    }
    return prosesPembayaranTx(tx,actor,id);
  });
}

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
  if (p.siJadwalId && !env.billingEnabled) return setStatus(tx,p.id,'menunggu',{alasan:'Fitur tagihan SI belum diaktifkan.'});

  if (status?.statusProses === 'historis') {
    if (status.verificationHash === verificationHash(p)) {
      await tx.update(statusPembayaranSi).set({ updatedAt: new Date() }).where(eq(statusPembayaranSi.paymentId, p.id));
      return status;
    }
    return setStatus(tx, p.id, 'perlu_ditinjau', { alasan: 'Pembayaran historis berubah di PR Track setelah dicatat sebagai saldo awal.' });
  }

  if (status && ['dijurnal', 'perlu_ditinjau'].includes(status.statusProses)) {
    const j = status.jurnalId ? await jurnalRepo.findJurnal(status.jurnalId, tx) : null;
    if (!(status.statusProses === 'perlu_ditinjau' && j?.status === 'dikoreksi')) {
      const alasan = p.siJadwalId && status.verificationHash!==verificationHash(p)
        ? 'Isi pembayaran berubah setelah diverifikasi.' : await berubahSejakDijurnal(tx, p, status);
      if (alasan) {
        if (p.siJadwalId) await enqueuePaymentResult(tx,p,'perlu_ditinjau',{alasan,jurnal:j?.noBukti ?? null});
        return setStatus(tx, p.id, 'perlu_ditinjau', { jurnalId: status.jurnalId, alasan });
      }
      // Sudah dicek terhadap versi cermin ini: tidak dipilih lagi sampai Track berubah
      await tx.update(statusPembayaranSi).set({ updatedAt: new Date() }).where(eq(statusPembayaranSi.paymentId, p.id));
      return status;
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
  if (p.siJadwalId) {
    if (status?.keputusan==='tolak') return status;
    if (status?.keputusan!=='terima') return setStatus(tx,p.id,'menunggu',{alasan:'Menunggu verifikasi Keuangan SI.'});
    if (status.verificationHash!==verificationHash(p)) {
      await enqueuePaymentResult(tx,p,'perlu_ditinjau',{alasan:'Isi pembayaran berubah setelah diverifikasi.'});
      return setStatus(tx,p.id,'perlu_ditinjau',{alasan:'Isi pembayaran berubah setelah diverifikasi.'});
    }
    await validateSelectedBill(tx,p);
  } else {
    // Cutoff diputuskan sebelum syarat verifikasi: pembayaran lama tidak punya status verifikasi.
    const lama = await klasifikasiPembayaranLama(tx, actor, p);
    if (lama) return lama;
    if (p.statusVerifikasi !== 'terverifikasi') return setStatus(tx, p.id, 'menunggu', { alasan: 'Belum diverifikasi admin PR Track.' });
  }

  const berat = [];
  const [asg] = await tx.select().from(trkAssignments).where(eq(trkAssignments.id, p.assignmentId)).limit(1);
  if (!asg || asg.isDeleted) berat.push('Penjualan tidak ada di cermin PR Track.');
  if (!JENIS_PEMBAYARAN.includes(p.jenis)) berat.push(`Jenis pembayaran tidak dikenal: ${p.jenis ?? '-'}.`);
  if (!(toCents(p.nominal) > 0n)) berat.push('Nominal harus lebih dari 0.');
  const kas = await akunKasDariRekening(tx, p.rekeningTujuan);
  if (!kas) berat.push(`Rekening tujuan ${p.rekeningTujuan ?? '-'} tidak cocok dengan akun kas/bank mana pun.`);
  if (berat.length) {
    if (p.siJadwalId) await enqueuePaymentResult(tx,p,'perlu_ditinjau',{alasan:berat.join(' ')});
    return setStatus(tx,p.id,'gagal_validasi',{alasan:berat.join(' ')});
  }

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
  if (!p.siJadwalId && await isDuplikat(tx, p)) ringan.push('Terindikasi duplikat: pembayaran lain dengan tanggal dan nominal sama sudah dijurnal.');
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
  if (p.siJadwalId) await enqueuePaymentResult(tx,p,'perlu_ditinjau',{alasan:ringan.join(' '),jurnal:j.noBukti});
  return setStatus(tx, p.id, 'gagal_validasi', { jurnalId: j.id, alasan: ringan.join(' ') });
}

/**
 * Alokasi ke jadwal angsuran aktif, terlama lebih dulu (ERD Alur 2). Booking
 * fee, pencairan KPR, dan lebih bayar disimpan dengan jadwal_id kosong.
 */
export async function alokasikan(tx, actor, p) {
  if (p.siJadwalId) {
    const bill=await validateSelectedBill(tx,p);
    await tx.delete(alokasiPembayaran).where(eq(alokasiPembayaran.paymentId,p.id));
    await tx.insert(alokasiPembayaran).values({paymentId:p.id,penjualanId:bill.penjualanId,jadwalId:bill.id,nominal:p.nominal,diubahOleh:actor.userId ?? null});
    await enqueueBill(tx,bill.id);
    return;
  }
  const pj = await penjualanOf(tx, p.assignmentId);
  if (!pj) return;
  await tx.delete(alokasiPembayaran).where(and(eq(alokasiPembayaran.paymentId, p.id), eq(alokasiPembayaran.manual, false)));
  let sisa = toCents(p.nominal);
  const rows = [];
  if (['uang_muka', 'angsuran'].includes(jenisPembayaran(p))) {
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

registerPostingGuard(REF,async(tx,j,errors)=>{
  const [p]=await tx.select().from(trkPayments).where(eq(trkPayments.id,j.refId)).for('update');
  if(!p?.siJadwalId) return;
  const [s]=await tx.select().from(statusPembayaranSi).where(eq(statusPembayaranSi.paymentId,p.id));
  if(!env.billingEnabled || s?.keputusan!=='terima' || s.verificationHash!==verificationHash(p)) {
    errors.push('Pembayaran tagihan harus diverifikasi SI terhadap isi pembayaran terkini sebelum posting.');return;
  }
  try {await validateSelectedBill(tx,p);} catch(error) {if(!(error instanceof AppError)) throw error;errors.push(error.message);}
});

registerAfterPosting(REF, async (tx, actor, j) => {
  const [p] = await tx.select().from(trkPayments).where(eq(trkPayments.id, j.refId)).limit(1);
  if (!p) return;
  await alokasikan(tx, actor, p);
  await setStatus(tx, p.id, 'dijurnal', { jurnalId: j.id });
  if (p.siJadwalId) {
    await enqueuePaymentResult(tx,p,'dijurnal',{jurnal:j.noBukti});
    return;
  }
  // Track mengunci pembayaran ini supaya tidak diubah setelah dibukukan
  await tx.insert(outboxTrack).values({
    jenis: 'kunci_pembayaran', refId: p.id, payload: { trackPaymentId: p.trackId, jurnal: j.noBukti, terkunci: true },
  });
});

// Jurnal pembayaran dibalik Keuangan: alokasinya dilepas dan pembayaran
// menunggu ditinjau / diproses ulang.
registerAfterReverse(REF, async (tx, _actor, j) => {
  const [p]=await tx.select().from(trkPayments).where(eq(trkPayments.id,j.refId)).for('update');
  await tx.delete(alokasiPembayaran).where(eq(alokasiPembayaran.paymentId, j.refId));
  await setStatus(tx, j.refId, 'perlu_ditinjau', { jurnalId: j.id, alasan: 'Jurnal pembayaran dibalik. Proses ulang setelah data benar.' });
  if (p?.siJadwalId) {
    await tx.update(statusPembayaranSi).set({keputusan:'dikoreksi',verificationHash:null}).where(eq(statusPembayaranSi.paymentId,p.id));
    await enqueueBill(tx,p.siJadwalId);
    await enqueuePaymentResult(tx,p,'dikoreksi',{alasan:'Jurnal pembayaran dibalik. Proses ulang setelah data benar.',jurnal:j.noBukti});
  }
});

/**
 * Catat penolakan dari prosesPembayaranTx (yang sudah di-rollback) pada status
 * pembayaran. Jurnal yang sudah ada tetap ditautkan; pembayaran yang sudah
 * dijurnal menjadi perlu_ditinjau, bukan gagal_validasi, karena pembukuannya ada.
 */
async function tandaiGagal(paymentId, err) {
  const alasan = (err.errors?.length ? err.errors : [err.message]).join(' ');
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(trkPayments).where(eq(trkPayments.id, paymentId)).for('update').limit(1);
    const [s] = await tx.select().from(statusPembayaranSi).where(eq(statusPembayaranSi.paymentId, paymentId)).limit(1);
    const statusProses = s?.statusProses === 'dijurnal' ? 'perlu_ditinjau' : 'gagal_validasi';
    if (p?.siJadwalId) await enqueuePaymentResult(tx, p, 'perlu_ditinjau', { alasan });
    return setStatus(tx, paymentId, statusProses, { jurnalId: s?.jurnalId ?? null, alasan });
  });
}

/**
 * Penolakan bisnis satu pembayaran (mis. tanggal sebelum saldo awal, periode terkunci,
 * akun sistem belum diatur) dicatat pada pembayaran itu, sehingga prosesSemua lanjut ke
 * pembayaran berikutnya. Galat lain (database/jaringan) tetap dilempar agar putaran diulang.
 */
export async function proses(actor, paymentId) {
  return db.transaction((tx) => prosesPembayaranTx(tx, actor, paymentId)).catch((err) => {
    if (!(err instanceof AppError) || err.statusCode === 404 || err.hold) throw err;
    return tandaiGagal(paymentId, err);
  });
}

/**
 * Proses semua yang perlu: belum pernah diproses, atau menunggu / sudah
 * dijurnal tetapi barisnya disinkron ulang dari Track sejak terakhir diproses.
 * Tanpa perubahan di Track, status menunggu tidak akan berubah, jadi tidak
 * diproses ulang setiap putaran.
 */
export async function prosesSemua(actor) {
  // Pembayaran tanpa tagihan hanya dipilih bila cutover siap (Opsi A); sisanya tetap
  // belum_diproses dan otomatis dipilih begitu konfigurasi/saldo awal lengkap.
  const legacyBoleh = legacyHeld() ? sql`false`
    : env.legacyCutoverAt ? eq(saldoAwalPeriode.status, 'terkunci') : sql`true`;
  const rows = await db.select({ id: trkPayments.id }).from(trkPayments)
    .leftJoin(statusPembayaranSi, eq(statusPembayaranSi.paymentId, trkPayments.id))
    .leftJoin(trkAssignments, eq(trkAssignments.id, trkPayments.assignmentId))
    .leftJoin(trkUnits, eq(trkUnits.id, trkAssignments.unitId))
    .leftJoin(saldoAwalPeriode, eq(saldoAwalPeriode.proyekId, trkUnits.projectId))
    .where(and(or(
      isNull(statusPembayaranSi.paymentId),
      and(inArray(statusPembayaranSi.statusProses, ['menunggu', 'dijurnal', 'historis']), sql`${trkPayments.syncedAt} > ${statusPembayaranSi.updatedAt}`),
    ), or(isNotNull(trkPayments.siJadwalId), legacyBoleh)))
    .orderBy(asc(trkPayments.tanggal));
  const hasil = { diproses: 0, dijurnal: 0, historis: 0, menunggu: 0, gagal_validasi: 0, perlu_ditinjau: 0, ditolak: 0, ditahan: 0 };
  for (const { id } of rows) {
    let s;
    try {
      s = await proses(actor, id);
    } catch (err) {
      // Kondisi tahan berubah di tengah putaran: lewati, coba lagi putaran berikutnya.
      if (!err.hold) throw err;
      hasil.ditahan += 1;
      continue;
    }
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
  const tagihan = await tagihanPembayaran(rows.map(({ p }) => p));
  return rows.map(({ p, s, noBukti, jurnalStatus }) => ({
    id: p.id, trackId: p.trackId, assignmentId: p.assignmentId, tanggal: p.tanggal, nominal: toNumber(p.nominal), jenis: p.jenis,
    statusVerifikasi: p.statusVerifikasi, keputusanSi:s?.keputusan ?? null, siJadwalId:p.siJadwalId, rekeningTujuan: p.rekeningTujuan, buktiUrl: p.buktiUrl, isAutoInject: p.isAutoInject,
    isDeleted: p.isDeleted, statusProses: s?.statusProses ?? 'belum_diproses', alasan: s?.alasan ?? null,
    jurnalId: s?.jurnalId ?? null, nomorJurnal: noBukti ?? null, jurnalStatus: jurnalStatus ?? null,
    tagihan: tagihan.get(p.id) ?? null,
  }));
}

/**
 * Tagihan pilihan tiap pembayaran beserta sisanya. Sisa dihitung tanpa alokasi
 * pembayaran itu sendiri, sama dengan pemeriksaan validateSelectedBill saat terima.
 */
async function tagihanPembayaran(payments) {
  const withBill = payments.filter((p) => p.siJadwalId);
  const hasil = new Map();
  if (!withBill.length) return hasil;
  const billIds = [...new Set(withBill.map((p) => p.siJadwalId))];
  const bills = await db.select().from(jadwalAngsuran).where(inArray(jadwalAngsuran.id, billIds));
  const alokasi = await db.select({ jadwalId: alokasiPembayaran.jadwalId, paymentId: alokasiPembayaran.paymentId, nominal: alokasiPembayaran.nominal })
    .from(alokasiPembayaran).where(inArray(alokasiPembayaran.jadwalId, billIds));
  const billById = new Map(bills.map((b) => [b.id, b]));
  for (const p of withBill) {
    const bill = billById.get(p.siJadwalId);
    if (!bill) continue;
    const terpakai = alokasi.filter((a) => a.jadwalId === bill.id && a.paymentId !== p.id).reduce((sum, a) => sum + toCents(a.nominal), 0n);
    hasil.set(p.id, {
      id: bill.id, noUrut: bill.noUrut, tanggal: bill.tanggal, jenis: bill.jenis, keterangan: bill.keterangan, aktif: bill.aktif,
      jumlah: toNumber(bill.jumlah), terpakai: toNumber(centsToString(terpakai)), sisa: toNumber(centsToString(toCents(bill.jumlah) - terpakai)),
      milikPenjualan: bill.assignmentId === p.assignmentId,
    });
  }
  return hasil;
}

/**
 * Alokasi ulang semua pembayaran terjurnal satu penjualan ke jadwal yang
 * aktif sekarang, urut tanggal bayar (dipakai setelah adendum mengganti
 * jadwal). Koreksi manual atas jadwal lama ikut dilepas.
 */
export async function realokasiPenjualan(tx, actor, penjualanId, assignmentId) {
  const rows = await tx.select({ p: trkPayments }).from(trkPayments)
    .innerJoin(statusPembayaranSi, eq(statusPembayaranSi.paymentId, trkPayments.id))
    .where(and(eq(trkPayments.assignmentId, assignmentId), inArray(statusPembayaranSi.statusProses, ['dijurnal', 'historis'])))
    .orderBy(asc(trkPayments.tanggal), asc(trkPayments.syncedAt));
  const legacy=rows.filter(({p})=>!p.siJadwalId);
  for (const { p } of legacy) {
    await tx.delete(alokasiPembayaran).where(eq(alokasiPembayaran.paymentId,p.id));
    await alokasikan(tx, actor, p);
  }
  return legacy.length;
}
