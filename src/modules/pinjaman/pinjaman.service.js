// src/modules/pinjaman/pinjaman.service.js
//
// Pinjaman bank (FE: pinjamanBankStore). Setiap pencairan, top up, dan
// pembayaran membuat jurnal sumber 'pinjaman'. totalPencairan, sisaPokok, dan
// penebusan dihitung dari transaksi yang jurnalnya sudah diposting.
//
// Jurnal per jenis:
//   pencairan / top_up : D Kas/bank          K Hutang bank (kode pembantu bank)
//   pokok              : D Hutang bank       K Kas/bank
//   bunga              : D Beban bunga       K Kas/bank
//   gabungan           : D Hutang bank, D Beban bunga   K Kas/bank
// Gabungan tanpa rincian (menunggu_rincian) disimpan sebagai draft dan tidak
// bisa diposting sampai porsi pokok dan bunganya diisi.
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { pinjaman, pinjamanTransaksi } from '../../shared/schemas/hutang.schema.js';
import { akun, kodePembantu } from '../../shared/schemas/akuntansi.schema.js';
import { AppError } from '../../shared/utils/AppError.js';
import { toCents, centsToString, toNumber } from '../../shared/utils/money.js';
import { recordAuditTx, recordFieldChanges, AuditAction } from '../../shared/utils/audit.js';
import {
  buatJurnalOtomatis, gantiDraftTx, hapusJurnalModulTx, ringkasJurnal, registerPostingGuard,
} from '../jurnal/jurnal.service.js';
import * as h from '../hutang/hutang.helpers.js';

const REF = 'pinjaman_transaksi';
const MENAMBAH = ['pencairan', 'top_up'];

registerPostingGuard(REF, async (tx, j, errors) => {
  const [t] = await tx.select({ statusRincian: pinjamanTransaksi.statusRincian }).from(pinjamanTransaksi)
    .where(eq(pinjamanTransaksi.id, j.refId)).limit(1);
  if (t?.statusRincian === 'menunggu_rincian') errors.push('Isi rincian pokok dan bunga transaksi pinjaman ini sebelum posting.');
});

const num = (cents) => Number(centsToString(cents));

/** Porsi pokok sebuah transaksi dalam sen (pencairan/top up positif, pembayaran negatif). */
const pokokCents = (t) => {
  if (MENAMBAH.includes(t.jenis)) return toCents(t.nominal);
  if (t.jenis === 'pokok') return -toCents(t.nominal);
  if (t.jenis === 'gabungan') return -toCents(t.nominalPokok ?? (t.statusRincian === 'menunggu_rincian' ? t.nominal : 0));
  return 0n;
};

function hitung(transaksi, info) {
  let total = 0n;
  let sisa = 0n;
  let sisaTermasukDraft = 0n;
  for (const t of transaksi) {
    const status = info.get(t.jurnalId)?.status;
    const p = pokokCents(t);
    if (status !== 'draft') sisaTermasukDraft += p;
    else if (p < 0n) sisaTermasukDraft += p; // pembayaran draft sudah mengurangi ruang bayar
    if (status !== 'diposting') continue;
    if (MENAMBAH.includes(t.jenis)) total += p;
    sisa += p;
  }
  return { total, sisa, sisaTermasukDraft };
}

const toTransaksiDto = (t, info) => ({
  id: t.id,
  pinjamanId: t.pinjamanId,
  tanggal: t.tanggal,
  jenis: t.jenis,
  nominal: toNumber(t.nominal),
  nominalPokok: toNumber(t.nominalPokok) ?? undefined,
  nominalBunga: toNumber(t.nominalBunga) ?? undefined,
  periodeBunga: t.periodeBunga ?? undefined,
  keterangan: t.keterangan ?? undefined,
  noBukti: t.noBukti ?? undefined,
  akunKasId: t.akunKasId,
  statusRincian: t.statusRincian,
  ...h.jurnalInfo(info, t.jurnalId),
  createdAt: t.createdAt,
});

function toPinjamanDto(p, transaksi, info) {
  const { total, sisa } = hitung(transaksi, info);
  const awal = transaksi.find((t) => t.jenis === 'pencairan');
  return {
    id: p.id,
    proyekId: p.proyekId,
    kodePembantuId: p.kodePembantuId,
    namaBank: p.namaBank,
    noAkad: p.noAkad ?? undefined,
    pola: p.pola,
    tanggalPencairanAwal: awal?.tanggal ?? null,
    nominalPencairanAwal: awal ? toNumber(awal.nominal) : 0,
    pencairanAwal: awal ? toTransaksiDto(awal, info) : null,
    topUps: transaksi.filter((t) => t.jenis === 'top_up').map((t) => toTransaksiDto(t, info)),
    totalPencairan: num(total),
    sisaPokok: num(sisa),
    penebusan: num(total - sisa),
    tanggalAcuanBunga: p.tanggalAcuanBunga,
    tanggalJatuhTempoPokok: p.jatuhTempoPokok,
    akunHutangId: p.akunHutangId,
    akunBebanBungaId: p.akunBebanBungaId,
    status: total > 0n && sisa <= 0n ? 'lunas' : 'aktif',
    keterangan: p.keterangan ?? undefined,
    createdAt: p.createdAt,
  };
}

const selectPinjaman = () => db
  .select({
    id: pinjaman.id, proyekId: pinjaman.proyekId, kodePembantuId: pinjaman.kodePembantuId, namaBank: kodePembantu.nama,
    noAkad: pinjaman.noAkad, pola: pinjaman.pola, tanggalAcuanBunga: pinjaman.tanggalAcuanBunga,
    jatuhTempoPokok: pinjaman.jatuhTempoPokok, akunHutangId: pinjaman.akunHutangId, akunBebanBungaId: pinjaman.akunBebanBungaId,
    keterangan: pinjaman.keterangan, createdAt: pinjaman.createdAt,
  })
  .from(pinjaman)
  .innerJoin(kodePembantu, eq(kodePembantu.id, pinjaman.kodePembantuId));

async function loadMany(rows) {
  const ids = rows.map((p) => p.id);
  const transaksi = ids.length
    ? await db.select().from(pinjamanTransaksi).where(inArray(pinjamanTransaksi.pinjamanId, ids))
      .orderBy(asc(pinjamanTransaksi.tanggal), asc(pinjamanTransaksi.createdAt))
    : [];
  const info = await ringkasJurnal(transaksi.map((t) => t.jurnalId));
  const byPinjaman = new Map(ids.map((id) => [id, []]));
  for (const t of transaksi) byPinjaman.get(t.pinjamanId).push(t);
  return { byPinjaman, info };
}

export async function list({ proyekId, status } = {}) {
  const rows = await selectPinjaman().where(proyekId ? eq(pinjaman.proyekId, proyekId) : undefined).orderBy(desc(pinjaman.createdAt));
  const { byPinjaman, info } = await loadMany(rows);
  const items = rows.map((p) => toPinjamanDto(p, byPinjaman.get(p.id), info));
  return status ? items.filter((p) => p.status === status) : items;
}

export async function get(id) {
  const [p] = await selectPinjaman().where(eq(pinjaman.id, id)).limit(1);
  if (!p) throw new AppError('Pinjaman tidak ditemukan.', 404);
  const { byPinjaman, info } = await loadMany([p]);
  const transaksi = byPinjaman.get(p.id);
  return {
    ...toPinjamanDto(p, transaksi, info),
    // FE: entries = pembayaran pokok/bunga/gabungan
    entries: transaksi.filter((t) => !MENAMBAH.includes(t.jenis)).map((t) => toTransaksiDto(t, info)),
  };
}

// ── Jurnal per transaksi ────────────────────────────────────

function rowsFor(p, t) {
  const kas = { akunId: t.akunKasId };
  const hutang = { akunId: p.akunHutangId, kodePembantuId: p.kodePembantuId };
  const n = Number(t.nominal);
  switch (t.jenis) {
    case 'pencairan':
    case 'top_up':
      return [{ ...kas, debit: n, kredit: 0 }, { ...hutang, debit: 0, kredit: n }];
    case 'pokok':
      return [{ ...hutang, debit: n, kredit: 0 }, { ...kas, debit: 0, kredit: n }];
    case 'bunga':
      return [{ akunId: p.akunBebanBungaId, debit: n, kredit: 0 }, { ...kas, debit: 0, kredit: n }];
    default: {
      // gabungan; selama menunggu rincian seluruhnya sementara ke hutang
      const pokok = t.nominalPokok === null || t.nominalPokok === undefined ? n : Number(t.nominalPokok);
      const bunga = t.nominalBunga === null || t.nominalBunga === undefined ? 0 : Number(t.nominalBunga);
      const rows = [{ ...hutang, debit: pokok, kredit: 0 }];
      if (bunga > 0) rows.push({ akunId: p.akunBebanBungaId, debit: bunga, kredit: 0 });
      rows.push({ ...kas, debit: 0, kredit: n });
      return rows.filter((r) => r.debit > 0 || r.kredit > 0);
    }
  }
}

const URAIAN = {
  pencairan: 'Pencairan pinjaman', top_up: 'Top up pinjaman', pokok: 'Bayar pokok pinjaman',
  bunga: 'Bayar bunga pinjaman', gabungan: 'Bayar pokok dan bunga pinjaman',
};

async function catatTransaksi(tx, actor, p, data) {
  await h.assertKasBank(tx, data.akunKasId);
  const [t] = await tx.insert(pinjamanTransaksi).values({
    pinjamanId: p.id,
    jenis: data.jenis,
    tanggal: data.tanggal,
    nominal: centsToString(toCents(data.nominal)),
    nominalPokok: data.nominalPokok === undefined || data.nominalPokok === null ? null : centsToString(toCents(data.nominalPokok)),
    nominalBunga: data.nominalBunga === undefined || data.nominalBunga === null ? null : centsToString(toCents(data.nominalBunga)),
    periodeBunga: data.periodeBunga ?? null,
    noBukti: data.noBukti ?? null,
    akunKasId: data.akunKasId,
    keterangan: data.keterangan ?? null,
    statusRincian: data.statusRincian ?? 'lengkap',
    dibuatOleh: actor.userId,
  }).returning();

  const periode = data.periodeBunga ? ` ${data.periodeBunga}` : '';
  const j = await buatJurnalOtomatis(tx, actor, {
    tanggal: t.tanggal,
    uraian: data.keterangan || `${URAIAN[t.jenis]}${periode} ${p.namaBank}`,
    proyekId: p.proyekId,
    sumber: 'pinjaman',
    refType: REF,
    refId: t.id,
    noReferensi: t.noBukti,
    rows: rowsFor(p, t),
  });
  await tx.update(pinjamanTransaksi).set({ jurnalId: j.id }).where(eq(pinjamanTransaksi.id, t.id));
  return t;
}

async function lockPinjaman(tx, id) {
  const [row] = await tx.select().from(pinjaman).where(eq(pinjaman.id, id)).for('update').limit(1);
  if (!row) throw new AppError('Pinjaman tidak ditemukan.', 404);
  const [kp] = await tx.select({ nama: kodePembantu.nama }).from(kodePembantu).where(eq(kodePembantu.id, row.kodePembantuId)).limit(1);
  return { ...row, namaBank: kp?.nama ?? '' };
}

async function defaultAkunBebanBunga(tx) {
  const rows = await tx.select().from(akun).where(and(eq(akun.kategori, 'beban'), eq(akun.aktif, true))).orderBy(asc(akun.kode));
  const found = rows.find((a) => /bunga/i.test(a.nama));
  if (!found) throw new AppError('Pilih akun beban bunga (akunBebanBungaId).', 422);
  return found;
}

// ── Operasi ─────────────────────────────────────────────────

export async function create(actor, b) {
  const id = await db.transaction(async (tx) => {
    await h.findProyekAktif(tx, b.proyekId);
    const kp = await h.resolveKodePembantu(tx, { id: b.kodePembantuId, namaBaru: b.namaBank, kategori: 'bank', proyekId: b.proyekId });
    const akunHutang = b.akunHutangId ? await h.findAkunAktif(tx, b.akunHutangId, 'Akun hutang') : await h.akunUntukKategori(tx, 'bank', 'hutang');
    const akunBunga = b.akunBebanBungaId ? await h.findAkunAktif(tx, b.akunBebanBungaId, 'Akun beban bunga') : await defaultAkunBebanBunga(tx);

    const [p] = await tx.insert(pinjaman).values({
      proyekId: b.proyekId, kodePembantuId: kp.id, noAkad: b.noAkad ?? null, pola: b.pola,
      tanggalAcuanBunga: b.tanggalAcuanBunga, jatuhTempoPokok: b.tanggalJatuhTempoPokok,
      akunHutangId: akunHutang.id, akunBebanBungaId: akunBunga.id, keterangan: b.keterangan ?? null,
    }).returning();
    await catatTransaksi(tx, actor, { ...p, namaBank: kp.nama }, {
      jenis: 'pencairan', tanggal: b.tanggalPencairanAwal, nominal: b.nominalPencairanAwal, akunKasId: b.akunKasId, noBukti: b.noBukti,
    });
    await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'pinjaman', entityId: p.id, summary: kp.nama });
    return p.id;
  });
  return get(id);
}

const LABELS = {
  tanggalAcuanBunga: 'Tanggal acuan bunga', jatuhTempoPokok: 'Jatuh tempo pokok', keterangan: 'Keterangan', pola: 'Pola pembayaran', noAkad: 'No. akad',
};

export async function update(actor, id, b) {
  await db.transaction(async (tx) => {
    const before = await lockPinjaman(tx, id);
    const values = { ...b };
    if ('tanggalJatuhTempoPokok' in values) {
      values.jatuhTempoPokok = values.tanggalJatuhTempoPokok;
      delete values.tanggalJatuhTempoPokok;
    }
    await tx.update(pinjaman).set({ ...values, updatedAt: new Date() }).where(eq(pinjaman.id, id));
    await recordFieldChanges(tx, { ...actor, entity: 'pinjaman', entityId: id, before, after: values, labels: LABELS });
  });
  return get(id);
}

export async function remove(actor, id) {
  await db.transaction(async (tx) => {
    await lockPinjaman(tx, id);
    const transaksi = await tx.select().from(pinjamanTransaksi).where(eq(pinjamanTransaksi.pinjamanId, id));
    const info = await ringkasJurnal(transaksi.map((t) => t.jurnalId), tx);
    if (transaksi.some((t) => info.get(t.jurnalId)?.status !== 'draft')) {
      throw new AppError('Pinjaman sudah punya jurnal terposting. Hapus transaksinya satu per satu bila memang salah input.', 409);
    }
    for (const t of transaksi) {
      await tx.update(pinjamanTransaksi).set({ jurnalId: null }).where(eq(pinjamanTransaksi.id, t.id));
      await hapusJurnalModulTx(tx, actor, t.jurnalId);
    }
    await tx.delete(pinjamanTransaksi).where(eq(pinjamanTransaksi.pinjamanId, id));
    await tx.delete(pinjaman).where(eq(pinjaman.id, id));
    await recordAuditTx(tx, { ...actor, action: AuditAction.DELETE, entity: 'pinjaman', entityId: id, summary: 'Pinjaman dihapus' });
  });
}

export async function topUp(actor, id, b) {
  await db.transaction(async (tx) => {
    const p = await lockPinjaman(tx, id);
    await catatTransaksi(tx, actor, p, { ...b, jenis: 'top_up' });
  });
  return get(id);
}

export async function bayar(actor, id, b) {
  await db.transaction(async (tx) => {
    const p = await lockPinjaman(tx, id);
    const data = { ...b };
    if (b.jenis === 'gabungan') {
      const adaRincian = b.nominalPokok !== undefined && b.nominalBunga !== undefined;
      if (adaRincian && toCents(b.nominalPokok) + toCents(b.nominalBunga) !== toCents(b.nominal)) {
        throw new AppError('Pokok + bunga harus sama dengan nominal transfer.', 422);
      }
      data.statusRincian = adaRincian ? 'lengkap' : 'menunggu_rincian';
    }

    const transaksi = await tx.select().from(pinjamanTransaksi).where(eq(pinjamanTransaksi.pinjamanId, id));
    const info = await ringkasJurnal(transaksi.map((t) => t.jurnalId), tx);
    const { sisaTermasukDraft } = hitung(transaksi, info);
    const keluar = -pokokCents({ jenis: data.jenis, nominal: data.nominal, nominalPokok: data.nominalPokok, statusRincian: data.statusRincian });
    if (keluar > 0n && keluar > sisaTermasukDraft) {
      throw new AppError(`Pembayaran pokok melebihi sisa pokok (${centsToString(sisaTermasukDraft)}).`, 422);
    }
    await catatTransaksi(tx, actor, p, data);
  });
  return get(id);
}

export async function isiRincian(actor, transaksiId, { nominalPokok, nominalBunga }) {
  const pinjamanId = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(pinjamanTransaksi).where(eq(pinjamanTransaksi.id, transaksiId)).for('update').limit(1);
    if (!t) throw new AppError('Transaksi tidak ditemukan.', 404);
    if (t.statusRincian !== 'menunggu_rincian') throw new AppError('Transaksi ini tidak menunggu rincian.', 409);
    if (toCents(nominalPokok) + toCents(nominalBunga) !== toCents(t.nominal)) {
      throw new AppError('Pokok + bunga harus sama dengan nominal transfer.', 422);
    }
    const p = await lockPinjaman(tx, t.pinjamanId);
    const [updated] = await tx.update(pinjamanTransaksi).set({
      nominalPokok: centsToString(toCents(nominalPokok)), nominalBunga: centsToString(toCents(nominalBunga)),
      statusRincian: 'lengkap', updatedAt: new Date(),
    }).where(eq(pinjamanTransaksi.id, t.id)).returning();
    await gantiDraftTx(tx, actor, t.jurnalId, { rows: rowsFor(p, updated) });
    return t.pinjamanId;
  });
  return get(pinjamanId);
}

export async function hapusTransaksi(actor, transaksiId) {
  const pinjamanId = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(pinjamanTransaksi).where(eq(pinjamanTransaksi.id, transaksiId)).for('update').limit(1);
    if (!t) throw new AppError('Transaksi tidak ditemukan.', 404);
    if (t.jenis === 'pencairan') throw new AppError('Pencairan awal tidak bisa dihapus sendiri; hapus pinjamannya.', 409);
    await tx.update(pinjamanTransaksi).set({ jurnalId: null }).where(eq(pinjamanTransaksi.id, t.id));
    await hapusJurnalModulTx(tx, actor, t.jurnalId);
    await tx.delete(pinjamanTransaksi).where(eq(pinjamanTransaksi.id, t.id));
    return t.pinjamanId;
  });
  return get(pinjamanId);
}

// ── Pengingat jatuh tempo (FE: getDueReminders) ─────────────

const fmt = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
const iso = (d) => d.toISOString().slice(0, 10);
const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
// Tanggal acuan 29-31 di bulan yang lebih pendek jatuh ke akhir bulan
const tanggalBunga = (y, m, acuan) => new Date(Date.UTC(y, m, Math.min(acuan, lastDay(y, m))));

export async function jatuhTempo({ hari = 14, hariIni = new Date() } = {}) {
  const today = new Date(Date.UTC(hariIni.getUTCFullYear(), hariIni.getUTCMonth(), hariIni.getUTCDate()));
  const items = (await list()).filter((p) => p.status === 'aktif' && p.totalPencairan > 0);
  const reminders = [];
  const diff = (d) => Math.round((d - today) / 86_400_000);

  for (const p of items) {
    const y = today.getUTCFullYear();
    const m = today.getUTCMonth();
    const ini = tanggalBunga(y, m, p.tanggalAcuanBunga);
    const bunga = ini >= today ? ini : tanggalBunga(y, m + 1, p.tanggalAcuanBunga);
    const pokok = new Date(`${p.tanggalJatuhTempoPokok}T00:00:00Z`);
    for (const [jenis, d] of [['bunga', bunga], ['pokok', pokok]]) {
      const hariLagi = diff(d);
      if (hariLagi < 0 || hariLagi > hari) continue;
      reminders.push({
        pinjaman: { id: p.id, proyekId: p.proyekId, namaBank: p.namaBank, sisaPokok: p.sisaPokok },
        jenis, tanggal: iso(d), tanggalFormatted: fmt(d),
        label: `${p.namaBank}, ${jenis} jatuh tempo ${fmt(d)}`, hariLagi,
      });
    }
  }
  return reminders.sort((a, b) => a.hariLagi - b.hariLagi);
}
