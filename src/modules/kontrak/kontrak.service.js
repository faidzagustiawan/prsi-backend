// src/modules/kontrak/kontrak.service.js
//
// Kontrak kontraktor per kavling (FE: kontrakStore). Jurnal sumber 'kontraktor':
//   SPK disimpan     : D Persediaan kavling   K Hutang kontraktor (nilai kontrak)
//   Adendum naik     : D Persediaan kavling   K Hutang kontraktor (selisih)
//   Adendum turun    : D Hutang kontraktor    K Persediaan kavling (selisih)
//   Bayar kontraktor : D Hutang kontraktor    K Kas/bank (draft sampai bukti diunggah)
//   Kontrak batal    : D Hutang kontraktor    K Persediaan kavling (sisa yang belum dibayar)
// Nilai kontrak terkini, total dibayar, dan sisa hutang dihitung dari baris
// kontrak, adendum, dan pembayaran yang jurnalnya terposting.
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { kontrakKontraktor, adendumKontrak, pembayaranKontrak } from '../../shared/schemas/hutang.schema.js';
import { kodePembantu } from '../../shared/schemas/akuntansi.schema.js';
import { trkUnits } from '../../shared/schemas/track.schema.js';
import { AppError } from '../../shared/utils/AppError.js';
import { toCents, centsToString, toNumber } from '../../shared/utils/money.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { buatJurnal, buatJurnalOtomatis, hapusJurnalModulTx, ringkasJurnal } from '../jurnal/jurnal.service.js';
import * as h from '../hutang/hutang.helpers.js';

const today = () => new Date().toISOString().slice(0, 10);
const num = (cents) => Number(centsToString(cents));
const str = (n) => centsToString(toCents(n));

const selectKontrak = () => db
  .select({ k: kontrakKontraktor, kavling: trkUnits.kode, namaKontraktor: kodePembantu.nama })
  .from(kontrakKontraktor)
  .innerJoin(trkUnits, eq(trkUnits.id, kontrakKontraktor.unitId))
  .innerJoin(kodePembantu, eq(kodePembantu.id, kontrakKontraktor.kodePembantuId));

async function loadChildren(ids, tx = db) {
  if (!ids.length) return { adendums: [], pembayarans: [], info: new Map() };
  const [adendums, pembayarans] = await Promise.all([
    tx.select().from(adendumKontrak).where(inArray(adendumKontrak.kontrakId, ids)).orderBy(asc(adendumKontrak.tanggal), asc(adendumKontrak.createdAt)),
    tx.select().from(pembayaranKontrak).where(inArray(pembayaranKontrak.kontrakId, ids)).orderBy(asc(pembayaranKontrak.tanggal), asc(pembayaranKontrak.createdAt)),
  ]);
  const info = await ringkasJurnal([...adendums, ...pembayarans].map((x) => x.jurnalId), tx);
  return { adendums, pembayarans, info };
}

/** Nilai kontrak terkini = nilai baru adendum terakhir; dibayar = pembayaran terposting. */
function hitung(k, adendums, pembayarans, info) {
  const nilai = adendums.length ? toCents(adendums.at(-1).nilaiBaru) : toCents(k.nilaiKontrak);
  let dibayar = 0n;
  let dibayarTermasukDraft = 0n;
  for (const p of pembayarans) {
    const status = info.get(p.jurnalId)?.status;
    dibayarTermasukDraft += toCents(p.nominal);
    if (status === 'diposting') dibayar += toCents(p.nominal);
  }
  return { nilai, dibayar, dibayarTermasukDraft };
}

const toAdendumDto = (a, info) => ({
  id: a.id, kontrakId: a.kontrakId, noAdendum: a.noAdendum, tanggal: a.tanggal,
  nilaiLama: toNumber(a.nilaiLama), nilaiBaru: toNumber(a.nilaiBaru), alasan: a.alasan,
  ...h.jurnalInfo(info, a.jurnalId), createdAt: a.createdAt,
});

const toPembayaranDto = (p, info) => ({
  id: p.id, kontrakId: p.kontrakId, tanggal: p.tanggal, nominal: toNumber(p.nominal), akunKasId: p.akunKasId,
  noBukti: p.noBukti ?? '', keterangan: p.keterangan ?? undefined, ...h.jurnalInfo(info, p.jurnalId), createdAt: p.createdAt,
});

function toKontrakDto({ k, kavling, namaKontraktor }, adendums, pembayarans, info) {
  const { nilai, dibayar } = hitung(k, adendums, pembayarans, info);
  return {
    id: k.id,
    noSpk: k.noSpk,
    proyekId: k.proyekId,
    unitId: k.unitId,
    kavling,
    tipe: k.tipe ?? '',
    tanggalSpk: k.tanggalSpk,
    kontraktorId: k.kodePembantuId,
    namaKontraktor,
    rab: toNumber(k.nilaiRab),
    // FE: nilaiKontrak = nilai awal SPK; nilaiTerkini = setelah adendum
    nilaiKontrak: toNumber(k.nilaiKontrak),
    nilaiTerkini: num(nilai),
    totalDibayar: num(dibayar),
    sisaHutang: k.status === 'batal' ? 0 : num(nilai - dibayar),
    keterangan: k.keterangan ?? undefined,
    akunPersediaanId: k.akunPersediaanId,
    akunHutangId: k.akunHutangId,
    status: k.status,
    ...h.jurnalInfo(info, k.jurnalId),
    createdAt: k.createdAt,
  };
}

export async function list({ proyekId, status } = {}) {
  const filters = [];
  if (proyekId) filters.push(eq(kontrakKontraktor.proyekId, proyekId));
  if (status) filters.push(eq(kontrakKontraktor.status, status));
  const rows = await selectKontrak().where(filters.length ? and(...filters) : undefined).orderBy(desc(kontrakKontraktor.tanggalSpk));
  const { adendums, pembayarans, info } = await loadChildren(rows.map((r) => r.k.id));
  const jurnalSpk = await ringkasJurnal(rows.map((r) => r.k.jurnalId));
  for (const [key, value] of jurnalSpk) info.set(key, value);
  return rows.map((r) => toKontrakDto(
    r, adendums.filter((a) => a.kontrakId === r.k.id), pembayarans.filter((p) => p.kontrakId === r.k.id), info,
  ));
}

export async function get(id) {
  const [r] = await selectKontrak().where(eq(kontrakKontraktor.id, id)).limit(1);
  if (!r) throw new AppError('Kontrak tidak ditemukan.', 404);
  const { adendums, pembayarans, info } = await loadChildren([id]);
  for (const [key, value] of await ringkasJurnal([r.k.jurnalId])) info.set(key, value);
  return {
    ...toKontrakDto(r, adendums, pembayarans, info),
    adendums: adendums.map((a) => toAdendumDto(a, info)),
    pembayarans: pembayarans.map((p) => toPembayaranDto(p, info)),
  };
}

async function lockKontrak(tx, id) {
  const [k] = await tx.select().from(kontrakKontraktor).where(eq(kontrakKontraktor.id, id)).for('update').limit(1);
  if (!k) throw new AppError('Kontrak tidak ditemukan.', 404);
  return k;
}

const jurnalKontrak = (tx, actor, k, { tanggal, uraian, refType, refId, noReferensi, debitAkun, kreditAkun, nilai, posting }) => {
  const kpOn = (akunId) => (akunId === k.akunHutangId ? k.kodePembantuId : null);
  const input = {
    tanggal, uraian, proyekId: k.proyekId, sumber: 'kontraktor', refType, refId, noReferensi,
    rows: [
      { akunId: debitAkun, kodePembantuId: kpOn(debitAkun), debit: nilai, kredit: 0 },
      { akunId: kreditAkun, kodePembantuId: kpOn(kreditAkun), debit: 0, kredit: nilai },
    ],
  };
  return posting ? buatJurnal(tx, actor, { ...input, status: 'diposting' }) : buatJurnalOtomatis(tx, actor, input);
};

export async function create(actor, b) {
  const id = await db.transaction(async (tx) => {
    await h.findProyekAktif(tx, b.proyekId);
    const unit = await h.findUnitDiProyek(tx, b.unitId, b.proyekId);
    const kp = await h.resolveKodePembantu(tx, {
      id: b.kontraktorId, namaBaru: b.namaKontraktor, kategori: 'kontraktor', proyekId: b.proyekId,
    });
    const akunHutang = b.akunHutangId ? await h.findAkunAktif(tx, b.akunHutangId, 'Akun hutang') : await h.akunUntukKategori(tx, 'kontraktor', 'hutang');
    if (!b.akunPersediaanId) throw new AppError('Pilih akun persediaan kavling (akunPersediaanId).', 422);
    const akunPersediaan = await h.findAkunAktif(tx, b.akunPersediaanId, 'Akun persediaan');

    const [k] = await tx.insert(kontrakKontraktor).values({
      noSpk: b.noSpk, proyekId: b.proyekId, unitId: unit.id, tipe: b.tipe ?? unit.tipe, tanggalSpk: b.tanggalSpk,
      kodePembantuId: kp.id, nilaiRab: str(b.rab), nilaiKontrak: str(b.nilaiKontrak), keterangan: b.keterangan ?? null,
      akunPersediaanId: akunPersediaan.id, akunHutangId: akunHutang.id,
    }).returning();

    const j = await jurnalKontrak(tx, actor, k, {
      tanggal: b.tanggalSpk, uraian: `SPK ${b.noSpk} kavling ${unit.kode} - ${kp.nama}`, refType: 'kontrak_kontraktor', refId: k.id,
      noReferensi: b.noSpk, debitAkun: akunPersediaan.id, kreditAkun: akunHutang.id, nilai: b.nilaiKontrak, posting: true,
    });
    await tx.update(kontrakKontraktor).set({ jurnalId: j.id }).where(eq(kontrakKontraktor.id, k.id));
    await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'kontrak_kontraktor', entityId: k.id, summary: b.noSpk });
    return k.id;
  });
  return get(id);
}

export async function adendum(actor, id, b) {
  await db.transaction(async (tx) => {
    const k = await lockKontrak(tx, id);
    if (k.status !== 'aktif') throw new AppError('Kontrak sudah dibatalkan.', 409);
    const { adendums, pembayarans, info } = await loadChildren([id], tx);
    const { nilai, dibayarTermasukDraft } = hitung(k, adendums, pembayarans, info);
    const baru = toCents(b.nilaiBaru);
    if (baru === nilai) throw new AppError('Nilai baru sama dengan nilai kontrak sekarang.', 422);
    if (baru < dibayarTermasukDraft) throw new AppError(`Nilai baru lebih kecil dari yang sudah dibayar (${centsToString(dibayarTermasukDraft)}).`, 422);

    const [a] = await tx.insert(adendumKontrak).values({
      kontrakId: id, noAdendum: b.noAdendum, tanggal: b.tanggal, nilaiLama: centsToString(nilai), nilaiBaru: centsToString(baru),
      alasan: b.alasan, dibuatOleh: actor.userId,
    }).returning();
    const naik = baru > nilai;
    const selisih = num(naik ? baru - nilai : nilai - baru);
    const j = await jurnalKontrak(tx, actor, k, {
      tanggal: b.tanggal, uraian: `Adendum ${b.noAdendum} SPK ${k.noSpk}: ${b.alasan}`, refType: 'adendum_kontrak', refId: a.id,
      noReferensi: b.noAdendum, debitAkun: naik ? k.akunPersediaanId : k.akunHutangId, kreditAkun: naik ? k.akunHutangId : k.akunPersediaanId,
      nilai: selisih, posting: true,
    });
    await tx.update(adendumKontrak).set({ jurnalId: j.id }).where(eq(adendumKontrak.id, a.id));
  });
  return get(id);
}

export async function bayar(actor, id, b) {
  await db.transaction(async (tx) => {
    const k = await lockKontrak(tx, id);
    if (k.status !== 'aktif') throw new AppError('Kontrak sudah dibatalkan.', 409);
    await h.assertKasBank(tx, b.akunKasId);
    const { adendums, pembayarans, info } = await loadChildren([id], tx);
    const { nilai, dibayarTermasukDraft } = hitung(k, adendums, pembayarans, info);
    if (toCents(b.nominal) > nilai - dibayarTermasukDraft) {
      throw new AppError(`Pembayaran melebihi sisa kontrak (${centsToString(nilai - dibayarTermasukDraft)}).`, 422);
    }
    const [p] = await tx.insert(pembayaranKontrak).values({
      kontrakId: id, tanggal: b.tanggal, nominal: str(b.nominal), akunKasId: b.akunKasId, noBukti: b.noBukti ?? null,
      keterangan: b.keterangan ?? null, dibuatOleh: actor.userId,
    }).returning();
    const j = await jurnalKontrak(tx, actor, k, {
      tanggal: b.tanggal, uraian: b.keterangan ? `Bayar SPK ${k.noSpk}: ${b.keterangan}` : `Bayar SPK ${k.noSpk}`,
      refType: 'pembayaran_kontrak', refId: p.id, noReferensi: b.noBukti, debitAkun: k.akunHutangId, kreditAkun: b.akunKasId,
      nilai: b.nominal, posting: false,
    });
    await tx.update(pembayaranKontrak).set({ jurnalId: j.id }).where(eq(pembayaranKontrak.id, p.id));
  });
  return get(id);
}

export async function hapusPembayaran(actor, pembayaranId) {
  const kontrakId = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(pembayaranKontrak).where(eq(pembayaranKontrak.id, pembayaranId)).for('update').limit(1);
    if (!p) throw new AppError('Pembayaran tidak ditemukan.', 404);
    await lockKontrak(tx, p.kontrakId);
    await tx.update(pembayaranKontrak).set({ jurnalId: null }).where(eq(pembayaranKontrak.id, p.id));
    await hapusJurnalModulTx(tx, actor, p.jurnalId);
    await tx.delete(pembayaranKontrak).where(eq(pembayaranKontrak.id, p.id));
    return p.kontrakId;
  });
  return get(kontrakId);
}

export async function batal(actor, id, { tanggal = today(), alasan }) {
  await db.transaction(async (tx) => {
    const k = await lockKontrak(tx, id);
    if (k.status !== 'aktif') throw new AppError('Kontrak sudah dibatalkan.', 409);
    const { adendums, pembayarans, info } = await loadChildren([id], tx);
    if (pembayarans.some((p) => info.get(p.jurnalId)?.status === 'draft')) {
      throw new AppError('Masih ada pembayaran draft. Posting atau hapus dulu.', 409);
    }
    const { nilai, dibayar } = hitung(k, adendums, pembayarans, info);
    const sisa = nilai - dibayar;
    let jurnalBatalId = null;
    if (sisa > 0n) {
      const j = await jurnalKontrak(tx, actor, k, {
        tanggal, uraian: `Batal SPK ${k.noSpk}${alasan ? `: ${alasan}` : ''}`, refType: 'kontrak_kontraktor', refId: k.id,
        noReferensi: k.noSpk, debitAkun: k.akunHutangId, kreditAkun: k.akunPersediaanId, nilai: num(sisa), posting: true,
      });
      jurnalBatalId = j.id;
    }
    await tx.update(kontrakKontraktor).set({ status: 'batal', jurnalBatalId, dibatalkanPada: new Date(), updatedAt: new Date() })
      .where(eq(kontrakKontraktor.id, id));
    await recordAuditTx(tx, { ...actor, action: AuditAction.UPDATE, entity: 'kontrak_kontraktor', entityId: id, summary: `Batal: ${alasan ?? '-'}` });
  });
  return get(id);
}
