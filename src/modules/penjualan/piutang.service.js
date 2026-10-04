// src/modules/penjualan/piutang.service.js
//
// Kartu tagihan per penjualan (FE: piutangStore.KavlingTagihan). Semua angka
// dihitung dari jadwal_angsuran, alokasi_pembayaran, dan pembayaran yang sudah
// dijurnal; tidak ada kolom "dibayar" yang disimpan.
//
// Jurnal (Alur 3, sumber 'penjualan'):
//   BAST   : D Uang muka (terkumpul) + D Titipan BF (sisa) + D Piutang (sisa harga)  K Penjualan (nilai SPPR)
//            D HPP  K Persediaan kavling (nilai HPP yang diisi Keuangan)
//   Batal  : D Uang muka + D Titipan BF (terkumpul)  K Pendapatan lain-lain (potongan)  K Hutang pengembalian (sisa)
//   KPR    : D Beban cashback/admin KPR  K Kas/bank (draft sampai bukti diunggah)
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { penjualanKeuangan, jadwalAngsuran, alokasiPembayaran, dokumen, outboxTrack } from '../../shared/schemas/penjualan.schema.js';
import { trkAssignments, trkUnits, trkCustomers, trkPayments, statusPembayaranSi } from '../../shared/schemas/track.schema.js';
import { auditLogs, users } from '../../shared/schemas/finance.schema.js';
import { AppError } from '../../shared/utils/AppError.js';
import { toCents, centsToString, toNumber } from '../../shared/utils/money.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { TIPE_DARI_TRACK } from '../../shared/constants.js';
import { buatJurnal, buatJurnalOtomatis, ringkasJurnal } from '../jurnal/jurnal.service.js';
import { akunPeran } from '../akun-sistem/akun-sistem.routes.js';
import { kodePembantuPembeli, saldoAkunKp } from './penjualan.helpers.js';
import * as h from '../hutang/hutang.helpers.js';

const num = (cents) => Number(centsToString(cents));
const today = () => new Date().toISOString().slice(0, 10);
const TIPE_LAINNYA = { booking_fee: 'booking_fee', uang_muka: 'dp', pencairan_kpr: 'pencairan_kpr', angsuran: 'lainnya' };

/** Status periode, sama dengan computeStatus di JadwalRealisasiModal FE. */
export function statusPeriode({ tanggalJatuhTempo, tagihan, dibayar, tanggalBayar }, hariIni = today()) {
  const lunas = toCents(tagihan) - toCents(dibayar) <= 0n;
  const lewat = tanggalJatuhTempo < hariIni;
  if (!lewat && lunas) return 'dibayar_dimuka';
  if (lunas && tanggalBayar) {
    if (tanggalBayar < tanggalJatuhTempo) return 'bayar_awal';
    if (tanggalBayar > tanggalJatuhTempo) return 'terlambat';
    return 'lunas';
  }
  if (toCents(dibayar) > 0n && !lunas) return 'sebagian';
  if (lewat && toCents(dibayar) === 0n) return 'belum_bayar';
  return 'belum_jatuh_tempo';
}

const base = () => db
  .select({ pj: penjualanKeuangan, a: trkAssignments, unit: trkUnits, customer: trkCustomers, noDokumen: dokumen.noDokumen })
  .from(penjualanKeuangan)
  .innerJoin(trkAssignments, eq(trkAssignments.id, penjualanKeuangan.assignmentId))
  .innerJoin(trkUnits, eq(trkUnits.id, trkAssignments.unitId))
  .innerJoin(trkCustomers, eq(trkCustomers.id, trkAssignments.customerId))
  .leftJoin(dokumen, eq(dokumen.id, penjualanKeuangan.dokumenId));

async function loadDetail(rows) {
  const pjIds = rows.map((r) => r.pj.id);
  const asgIds = rows.map((r) => r.a.id);
  if (!pjIds.length) return { jadwal: [], alokasi: [], payments: [], riwayat: [] };
  const [jadwal, alokasi, payments, riwayat] = await Promise.all([
    db.select().from(jadwalAngsuran).where(and(inArray(jadwalAngsuran.penjualanId, pjIds), eq(jadwalAngsuran.aktif, true)))
      .orderBy(asc(jadwalAngsuran.tanggal), asc(jadwalAngsuran.noUrut)),
    db.select({ al: alokasiPembayaran, tanggal: trkPayments.tanggal, trackId: trkPayments.trackId }).from(alokasiPembayaran)
      .innerJoin(trkPayments, eq(trkPayments.id, alokasiPembayaran.paymentId))
      .innerJoin(statusPembayaranSi, eq(statusPembayaranSi.paymentId, trkPayments.id))
      .where(and(inArray(alokasiPembayaran.penjualanId, pjIds), eq(statusPembayaranSi.statusProses, 'dijurnal'))),
    db.select({ p: trkPayments, s: statusPembayaranSi }).from(trkPayments)
      .leftJoin(statusPembayaranSi, eq(statusPembayaranSi.paymentId, trkPayments.id))
      .where(and(inArray(trkPayments.assignmentId, asgIds), eq(trkPayments.isDeleted, false))).orderBy(asc(trkPayments.tanggal)),
    db.select({ log: auditLogs, oleh: users.nama }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.userId))
      .where(and(eq(auditLogs.entity, 'alokasi'), inArray(auditLogs.entityId, pjIds))).orderBy(desc(auditLogs.createdAt)),
  ]);
  return { jadwal, alokasi, payments, riwayat };
}

function toTagihanDto(r, d) {
  const { pj, a, unit, customer } = r;
  const jadwal = d.jadwal.filter((j) => j.penjualanId === pj.id);
  const alokasi = d.alokasi.filter((x) => x.al.penjualanId === pj.id);
  const payments = d.payments.filter((x) => x.p.assignmentId === a.id);

  const periodeAngsuran = jadwal.map((j) => {
    const mine = alokasi.filter((x) => x.al.jadwalId === j.id);
    const dibayar = mine.reduce((s, x) => s + toCents(x.al.nominal), 0n);
    const tanggalBayar = mine.length ? mine.map((x) => x.tanggal).sort().at(-1) : null;
    const row = {
      jadwalId: j.id, periode: j.tanggal.slice(0, 7), tanggalJatuhTempo: j.tanggal, tagihan: toNumber(j.jumlah),
      dibayar: num(dibayar), tanggalBayar, keterangan: j.keterangan, prTrackPaymentId: mine.at(-1)?.trackId,
      isDuplicateSuspect: false,
    };
    return { ...row, status: statusPeriode(row) };
  });

  const dijurnal = payments.filter((x) => x.s?.statusProses === 'dijurnal');
  const totalDibayar = dijurnal.reduce((s, x) => s + toCents(x.p.nominal), 0n);
  const keJadwal = new Set(alokasi.filter((x) => x.al.jadwalId).map((x) => x.al.paymentId));
  const nilai = toCents(pj.nilaiSppr);

  return {
    id: pj.id,
    assignmentId: a.id,
    proyekId: unit.projectId,
    unitId: unit.id,
    nomorKavling: unit.kode,
    namaUser: customer.nama,
    tipeTransaksi: TIPE_DARI_TRACK[a.tipePembayaran] ?? 'cash',
    statusBast: pj.tanggalBast ? 'sudah_bast' : 'belum_bast',
    tanggalBast: pj.tanggalBast,
    status: pj.status,
    dokumenId: pj.dokumenId,
    nomorSppr: r.noDokumen,
    nilaiSppr: num(nilai),
    totalDibayar: num(totalDibayar),
    sisa: pj.status === 'batal' ? 0 : num(nilai - totalDibayar),
    tanggalAcuanAngsuran: jadwal.length ? Number(jadwal[0].tanggal.slice(8)) : null,
    periodeAwal: jadwal[0]?.tanggal.slice(0, 7) ?? '',
    totalBulanAngsuran: jadwal.length,
    periodeAngsuran,
    // Semua pembayaran Track beserta status prosesnya
    pembayaran: payments.map(({ p, s }) => ({
      id: p.id, jenis: p.jenis, tanggal: p.tanggal, nominal: toNumber(p.nominal), statusProses: s?.statusProses ?? 'belum_diproses',
      alasan: s?.alasan ?? null, jurnalId: s?.jurnalId ?? null,
    })),
    // FE: pembayaranLainnya = yang tidak masuk jadwal (booking fee, pencairan KPR, lebih bayar)
    pembayaranLainnya: dijurnal.filter(({ p }) => !keJadwal.has(p.id)).map(({ p }) => ({
      id: p.id, tipe: TIPE_LAINNYA[p.jenis] ?? 'lainnya', tanggal: p.tanggal, nominal: toNumber(p.nominal), keterangan: p.catatan ?? undefined,
    })),
    riwayatAlokasi: d.riwayat.filter((x) => x.log.entityId === pj.id).map(({ log, oleh }) => ({
      id: log.id, tanggal: log.createdAt, periodeAsal: log.metadata?.periodeAsal, periodeTujuan: log.metadata?.periodeTujuan,
      nominal: log.metadata?.nominal, oleh: oleh ?? 'Sistem',
    })),
    nilaiCashbackKpr: toNumber(pj.nilaiCashbackKpr) ?? 0,
    nilaiAdminKpr: toNumber(pj.nilaiAdminKpr) ?? 0,
  };
}

export async function list({ proyekId, statusBast } = {}) {
  const f = [];
  if (proyekId) f.push(eq(trkUnits.projectId, proyekId));
  if (statusBast === 'sudah_bast') f.push(sql`${penjualanKeuangan.tanggalBast} IS NOT NULL`);
  if (statusBast === 'belum_bast') f.push(sql`${penjualanKeuangan.tanggalBast} IS NULL`);
  const rows = await base().where(f.length ? and(...f) : undefined).orderBy(asc(trkUnits.kode));
  const d = await loadDetail(rows);
  return rows.map((r) => toTagihanDto(r, d));
}

export async function get(id) {
  const rows = await base().where(eq(penjualanKeuangan.id, id)).limit(1);
  if (!rows.length) throw new AppError('Data piutang tidak ditemukan.', 404);
  return toTagihanDto(rows[0], await loadDetail(rows));
}

export async function ringkasan({ proyekId } = {}) {
  const items = (await list({ proyekId })).filter((x) => x.status === 'aktif');
  const sum = (key) => Number(centsToString(items.reduce((s, x) => s + toCents(x[key]), 0n)));
  return { jumlah: items.length, totalNilaiKontrak: sum('nilaiSppr'), totalDibayar: sum('totalDibayar'), totalSisa: sum('sisa') };
}

// ── Aksi ────────────────────────────────────────────────────

async function lockPenjualan(tx, id) {
  const [pj] = await tx.select().from(penjualanKeuangan).where(eq(penjualanKeuangan.id, id)).for('update').limit(1);
  if (!pj) throw new AppError('Data piutang tidak ditemukan.', 404);
  const [ctx] = await tx.select({ a: trkAssignments, unit: trkUnits, customer: trkCustomers }).from(trkAssignments)
    .innerJoin(trkUnits, eq(trkUnits.id, trkAssignments.unitId)).innerJoin(trkCustomers, eq(trkCustomers.id, trkAssignments.customerId))
    .where(eq(trkAssignments.id, pj.assignmentId)).limit(1);
  const kp = await kodePembantuPembeli(tx, ctx.customer, ctx.unit.projectId);
  return { pj, ...ctx, kp, proyekId: ctx.unit.projectId };
}

async function assertTidakAdaAntrean(tx, assignmentId) {
  const [pending] = await tx.select({ id: trkPayments.id }).from(trkPayments)
    .innerJoin(statusPembayaranSi, eq(statusPembayaranSi.paymentId, trkPayments.id))
    .where(and(eq(trkPayments.assignmentId, assignmentId), inArray(statusPembayaranSi.statusProses, ['gagal_validasi', 'perlu_ditinjau'])))
    .limit(1);
  if (pending) throw new AppError('Masih ada pembayaran Gagal validasi / Perlu ditinjau untuk penjualan ini. Selesaikan dulu.', 409);
}

/** Uang muka + titipan booking fee yang sudah terkumpul untuk pembeli ini. */
async function terkumpul(tx, c) {
  const um = await akunPeran(tx, 'uang_muka_penjualan');
  const bf = await akunPeran(tx, 'titipan_booking_fee');
  return {
    um, bf,
    saldoUm: await saldoAkunKp(tx, { akunId: um.id, kodePembantuId: c.kp.id, proyekId: c.proyekId }),
    saldoBf: await saldoAkunKp(tx, { akunId: bf.id, kodePembantuId: c.kp.id, proyekId: c.proyekId }),
  };
}

export async function bast(actor, id, { tanggal, nilaiHpp = 0 }) {
  await db.transaction(async (tx) => {
    const c = await lockPenjualan(tx, id);
    if (c.pj.status !== 'aktif') throw new AppError('Penjualan sudah dibatalkan.', 409);
    if (c.pj.tanggalBast) throw new AppError('Penjualan ini sudah BAST.', 409);
    await assertTidakAdaAntrean(tx, c.a.id);

    const { um, bf, saldoUm, saldoBf } = await terkumpul(tx, c);
    const nilai = toCents(c.pj.nilaiSppr);
    const piutangSisa = nilai - saldoUm - saldoBf;
    if (piutangSisa < 0n) throw new AppError('Uang yang terkumpul melebihi nilai SPPR. Periksa pembayaran sebelum BAST.', 422);

    const penjualan = await akunPeran(tx, 'penjualan');
    const rows = [];
    if (saldoUm > 0n) rows.push({ akunId: um.id, kodePembantuId: c.kp.id, debit: num(saldoUm), kredit: 0 });
    if (saldoBf > 0n) rows.push({ akunId: bf.id, kodePembantuId: c.kp.id, debit: num(saldoBf), kredit: 0 });
    if (piutangSisa > 0n) {
      const piutang = await akunPeran(tx, 'piutang_penjualan');
      rows.push({ akunId: piutang.id, kodePembantuId: c.kp.id, debit: num(piutangSisa), kredit: 0 });
    }
    rows.push({ akunId: penjualan.id, debit: 0, kredit: num(nilai) });
    if (toCents(nilaiHpp) > 0n) {
      const hpp = await akunPeran(tx, 'hpp');
      const persediaan = await akunPeran(tx, 'persediaan_kavling');
      rows.push({ akunId: hpp.id, debit: nilaiHpp, kredit: 0 }, { akunId: persediaan.id, debit: 0, kredit: nilaiHpp });
    }
    const j = await buatJurnal(tx, actor, {
      tanggal, uraian: `BAST kavling ${c.unit.kode} - ${c.customer.nama}`, proyekId: c.proyekId, status: 'diposting',
      sumber: 'penjualan', refType: 'penjualan_keuangan', refId: c.pj.id, rows,
    });
    await tx.update(penjualanKeuangan).set({ tanggalBast: tanggal, jurnalBastId: j.id, updatedAt: new Date() }).where(eq(penjualanKeuangan.id, id));
    await recordAuditTx(tx, { ...actor, action: AuditAction.UPDATE, entity: 'penjualan_keuangan', entityId: id, summary: `BAST ${tanggal}` });
  });
  return get(id);
}

export async function batal(actor, id, { tanggal, potongan, alasan }) {
  await db.transaction(async (tx) => {
    const c = await lockPenjualan(tx, id);
    if (c.pj.status !== 'aktif') throw new AppError('Penjualan sudah dibatalkan.', 409);
    if (c.pj.tanggalBast) throw new AppError('Penjualan yang sudah BAST tidak bisa dibatalkan dari sini.', 409);
    await assertTidakAdaAntrean(tx, c.a.id);

    const { um, bf, saldoUm, saldoBf } = await terkumpul(tx, c);
    const total = saldoUm + saldoBf;
    const pot = toCents(potongan);
    if (pot > total) throw new AppError(`Potongan melebihi uang yang terkumpul (${centsToString(total)}).`, 422);

    let jurnalBatalId = null;
    if (total > 0n) {
      const rows = [];
      if (saldoUm > 0n) rows.push({ akunId: um.id, kodePembantuId: c.kp.id, debit: num(saldoUm), kredit: 0 });
      if (saldoBf > 0n) rows.push({ akunId: bf.id, kodePembantuId: c.kp.id, debit: num(saldoBf), kredit: 0 });
      if (pot > 0n) rows.push({ akunId: (await akunPeran(tx, 'pendapatan_lain')).id, debit: 0, kredit: num(pot) });
      if (total - pot > 0n) {
        rows.push({ akunId: (await akunPeran(tx, 'hutang_pengembalian')).id, kodePembantuId: c.kp.id, debit: 0, kredit: num(total - pot) });
      }
      const j = await buatJurnal(tx, actor, {
        tanggal, uraian: `Batal penjualan kavling ${c.unit.kode} - ${c.customer.nama}${alasan ? `: ${alasan}` : ''}`,
        proyekId: c.proyekId, status: 'diposting', sumber: 'penjualan', refType: 'penjualan_keuangan', refId: c.pj.id, rows,
      });
      jurnalBatalId = j.id;
    }

    // Jadwal dinonaktifkan dan dikabarkan ke Track
    const aktif = await tx.update(jadwalAngsuran).set({ aktif: false, updatedAt: new Date() })
      .where(and(eq(jadwalAngsuran.penjualanId, id), eq(jadwalAngsuran.aktif, true))).returning();
    if (aktif.length) {
      await tx.insert(outboxTrack).values(aktif.map((j) => ({
        jenis: 'jadwal_angsuran', refId: j.id, payload: { siJadwalId: j.id, trackAssignmentId: c.a.trackId, aktif: false },
      })));
    }
    await tx.update(penjualanKeuangan).set({
      status: 'batal', tanggalBatal: tanggal, nominalPotongan: centsToString(pot), alasanBatal: alasan ?? null, jurnalBatalId, updatedAt: new Date(),
    }).where(eq(penjualanKeuangan.id, id));
    await recordAuditTx(tx, { ...actor, action: AuditAction.UPDATE, entity: 'penjualan_keuangan', entityId: id, summary: `Batal ${tanggal}` });
  });
  return get(id);
}

export async function biayaKpr(actor, id, { jenis, tanggal, nominal, akunKasId, noBukti }) {
  const jurnalId = await db.transaction(async (tx) => {
    const c = await lockPenjualan(tx, id);
    if (c.pj.status !== 'aktif') throw new AppError('Penjualan sudah dibatalkan.', 409);
    await h.assertKasBank(tx, akunKasId);
    const beban = await akunPeran(tx, jenis === 'cashback' ? 'beban_cashback_kpr' : 'beban_admin_kpr');
    const j = await buatJurnalOtomatis(tx, actor, {
      tanggal, uraian: `${jenis === 'cashback' ? 'Cashback' : 'Admin'} KPR kavling ${c.unit.kode} - ${c.customer.nama}`,
      proyekId: c.proyekId, sumber: 'penjualan', refType: 'penjualan_keuangan', refId: c.pj.id, noReferensi: noBukti,
      rows: [{ akunId: beban.id, debit: nominal, kredit: 0 }, { akunId: akunKasId, debit: 0, kredit: nominal }],
    });
    const kolom = jenis === 'cashback' ? 'nilaiCashbackKpr' : 'nilaiAdminKpr';
    await tx.update(penjualanKeuangan)
      .set({ [kolom]: centsToString(toCents(c.pj[kolom] ?? 0) + toCents(nominal)), updatedAt: new Date() })
      .where(eq(penjualanKeuangan.id, id));
    return j.id;
  });
  const info = await ringkasJurnal([jurnalId]);
  return { piutang: await get(id), jurnal: h.jurnalInfo(info, jurnalId) };
}

/** Koreksi manual: pindahkan sebagian alokasi dari satu periode jadwal ke periode lain. */
export async function pindahAlokasi(actor, id, { dariJadwalId, keJadwalId, nominal }) {
  await db.transaction(async (tx) => {
    const c = await lockPenjualan(tx, id);
    if (dariJadwalId === keJadwalId) throw new AppError('Periode asal dan tujuan sama.', 422);
    const jadwal = await tx.select().from(jadwalAngsuran)
      .where(and(eq(jadwalAngsuran.penjualanId, id), inArray(jadwalAngsuran.id, [dariJadwalId, keJadwalId])));
    const dari = jadwal.find((j) => j.id === dariJadwalId);
    const ke = jadwal.find((j) => j.id === keJadwalId);
    if (!dari || !ke) throw new AppError('Periode jadwal tidak ditemukan di penjualan ini.', 404);

    const sumber = await tx.select().from(alokasiPembayaran).where(eq(alokasiPembayaran.jadwalId, dariJadwalId)).orderBy(desc(alokasiPembayaran.createdAt));
    let sisa = toCents(nominal);
    const tersedia = sumber.reduce((s, a) => s + toCents(a.nominal), 0n);
    if (sisa > tersedia) throw new AppError(`Alokasi di periode asal hanya ${centsToString(tersedia)}.`, 422);

    for (const a of sumber) {
      if (sisa <= 0n) break;
      const ambil = toCents(a.nominal) < sisa ? toCents(a.nominal) : sisa;
      const tinggal = toCents(a.nominal) - ambil;
      if (tinggal === 0n) await tx.delete(alokasiPembayaran).where(eq(alokasiPembayaran.id, a.id));
      else await tx.update(alokasiPembayaran).set({ nominal: centsToString(tinggal), manual: true, diubahOleh: actor.userId }).where(eq(alokasiPembayaran.id, a.id));
      await tx.insert(alokasiPembayaran).values({
        paymentId: a.paymentId, penjualanId: id, jadwalId: keJadwalId, nominal: centsToString(ambil), manual: true, diubahOleh: actor.userId,
      });
      sisa -= ambil;
    }
    await recordAuditTx(tx, {
      ...actor, action: AuditAction.UPDATE, entity: 'alokasi', entityId: c.pj.id, summary: 'Koreksi alokasi',
      metadata: { periodeAsal: dari.tanggal.slice(0, 7), periodeTujuan: ke.tanggal.slice(0, 7), nominal },
    });
  });
  return get(id);
}
