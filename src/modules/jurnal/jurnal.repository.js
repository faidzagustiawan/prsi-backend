// src/modules/jurnal/jurnal.repository.js
import { and, eq, inArray, sql, desc, ilike, or, gte, lt, count } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { jurnal, jurnalDetail, lampiran, akun, kodePembantu, masterPt, periode, saldoAwalPeriode } from '../../shared/schemas/akuntansi.schema.js';
import { trkProjects } from '../../shared/schemas/track.schema.js';

// Status yang memengaruhi saldo: jurnal asal yang sudah dibalik tetap
// dihitung, dan jurnal baliknya meniadakan efeknya.
export const STATUS_TERBUKU = ['diposting', 'dikoreksi', 'balik'];

const bulanRange = (bulan) => {
  const [y, m] = bulan.split('-').map(Number);
  const start = `${bulan}-01`;
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { start, end };
};

export async function listJurnal({ page, limit, proyekId, status, sumber, bulan, q }) {
  const filters = [];
  if (proyekId) filters.push(eq(jurnal.proyekId, proyekId));
  if (status) filters.push(eq(jurnal.status, status));
  if (sumber) filters.push(eq(jurnal.sumber, sumber));
  if (bulan) {
    const { start, end } = bulanRange(bulan);
    filters.push(gte(jurnal.tanggal, start), lt(jurnal.tanggal, end));
  }
  if (q) filters.push(or(ilike(jurnal.uraian, `%${q}%`), ilike(jurnal.noBukti, `%${q}%`)));
  const where = filters.length ? and(...filters) : undefined;

  const [{ total }] = await db.select({ total: count() }).from(jurnal).where(where);
  const headers = await db
    .select()
    .from(jurnal)
    .where(where)
    .orderBy(desc(jurnal.tanggal), desc(jurnal.createdAt))
    .limit(limit)
    .offset((page - 1) * limit);

  return { total: Number(total), headers };
}

export async function findJurnal(id, tx = db) {
  const [row] = await tx.select().from(jurnal).where(eq(jurnal.id, id)).limit(1);
  return row ?? null;
}

/** Baris detail dan lampiran untuk sekumpulan jurnal, dikelompokkan per jurnal. */
export async function loadChildren(jurnalIds, tx = db) {
  if (!jurnalIds.length) return { rowsByJurnal: new Map(), lampiranByJurnal: new Map() };
  const [rows, files] = await Promise.all([
    tx.select().from(jurnalDetail).where(inArray(jurnalDetail.jurnalId, jurnalIds)).orderBy(jurnalDetail.urutan),
    tx.select().from(lampiran)
      .where(and(eq(lampiran.entityType, 'jurnal'), inArray(lampiran.entityId, jurnalIds)))
      .orderBy(lampiran.createdAt),
  ]);
  const group = (items, key) => items.reduce((map, item) => {
    const list = map.get(item[key]) ?? [];
    list.push(item);
    map.set(item[key], list);
    return map;
  }, new Map());
  return { rowsByJurnal: group(rows, 'jurnalId'), lampiranByJurnal: group(files, 'entityId') };
}

export async function findAkunByIds(ids, tx = db) {
  if (!ids.length) return [];
  return tx
    .select({
      id: akun.id,
      kode: akun.kode,
      nama: akun.nama,
      aktif: akun.aktif,
      wajibKodePembantu: akun.wajibKodePembantu,
      wajibProyek: akun.wajibProyek,
      isKasBank: akun.isKasBank,
      // Akun induk tidak boleh dijurnal; hanya akun detail (tanpa anak)
      punyaAnak: sql`EXISTS (SELECT 1 FROM finance.akun c WHERE c.induk_id = ${akun.id})`.mapWith(Boolean),
    })
    .from(akun)
    .where(inArray(akun.id, ids));
}

export async function findKodePembantuByIds(ids, tx = db) {
  if (!ids.length) return [];
  return tx.select({ id: kodePembantu.id, aktif: kodePembantu.aktif, nama: kodePembantu.nama })
    .from(kodePembantu).where(inArray(kodePembantu.id, ids));
}

export async function findProyek(id, tx = db) {
  const [row] = await tx.select({ id: trkProjects.id, kode: trkProjects.kode, isDeleted: trkProjects.isDeleted })
    .from(trkProjects).where(eq(trkProjects.id, id)).limit(1);
  return row ?? null;
}

export async function findPtByProyek(proyekId, tx = db) {
  const [row] = await tx.select({ id: masterPt.id }).from(masterPt)
    .where(and(eq(masterPt.proyekId, proyekId), sql`${masterPt.deletedAt} IS NULL`)).limit(1);
  return row?.id ?? null;
}

export async function isPeriodeTerkunci(ptId, tanggal, tx = db) {
  const [y, m] = tanggal.split('-').map(Number);
  const [row] = await tx.select({ status: periode.status }).from(periode)
    .where(and(eq(periode.ptId, ptId), eq(periode.tahun, y), eq(periode.bulan, m))).limit(1);
  return row?.status === 'terkunci';
}

export async function findSaldoAwalPeriode(proyekId, tx = db) {
  const [row] = await tx.select().from(saldoAwalPeriode).where(eq(saldoAwalPeriode.proyekId, proyekId)).limit(1);
  return row ?? null;
}

export async function countLampiran(jurnalId, tx = db) {
  const [{ n }] = await tx.select({ n: count() }).from(lampiran)
    .where(and(eq(lampiran.entityType, 'jurnal'), eq(lampiran.entityId, jurnalId)));
  return Number(n);
}

export async function insertJurnal(tx, header, rows) {
  const [created] = await tx.insert(jurnal).values(header).returning();
  await insertRows(tx, created.id, rows);
  return created;
}

export async function insertRows(tx, jurnalId, rows) {
  if (!rows.length) return;
  await tx.insert(jurnalDetail).values(rows.map((r, i) => ({ ...r, jurnalId, urutan: i + 1 })));
}

export async function replaceRows(tx, jurnalId, rows) {
  await tx.delete(jurnalDetail).where(eq(jurnalDetail.jurnalId, jurnalId));
  await insertRows(tx, jurnalId, rows);
}

export async function updateJurnal(tx, id, values) {
  const [row] = await tx.update(jurnal).set({ ...values, updatedAt: new Date() }).where(eq(jurnal.id, id)).returning();
  return row;
}

export async function deleteJurnal(tx, id) {
  await tx.delete(jurnal).where(eq(jurnal.id, id));
}

/** Kunci baris jurnal selama transaksi supaya posting/edit paralel tidak saling menimpa. */
export async function lockJurnal(tx, id) {
  const [row] = await tx.select().from(jurnal).where(eq(jurnal.id, id)).for('update').limit(1);
  return row ?? null;
}

export async function findJurnalByIds(ids, tx = db) {
  if (!ids.length) return [];
  return tx.select().from(jurnal).where(inArray(jurnal.id, ids));
}
