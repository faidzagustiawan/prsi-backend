// src/modules/saldo-awal/saldo-awal.routes.js
//
// Saldo awal per proyek (FE: src/store/saldoAwalStore.ts). Satu set per
// proyek; setelah dikunci tidak bisa diubah. Selama belum pernah disimpan,
// GET mengembalikan set kosong yang belum tersimpan (id = null).
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../config/database.js';
import { saldoAwalPeriode, saldoAwal, akun, kodePembantu, jurnal } from '../../shared/schemas/akuntansi.schema.js';
import { trkProjects } from '../../shared/schemas/track.schema.js';
import { validate } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { uuidSchema, isoDate, nominal } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { toCents, centsToString, toNumber } from '../../shared/utils/money.js';

const tags = ['Saldo Awal'];
const proyekParams = z.object({ proyekId: uuidSchema });

const saldoRow = z.object({
  akunId: uuidSchema,
  kodePembantuId: uuidSchema.optional().nullable(),
  debit: nominal.default(0),
  kredit: nominal.default(0),
});

const toDto = (p, rows, proyekId) => ({
  id: p?.id ?? null,
  proyekId,
  tanggalMulai: p?.tanggalMulai ?? `${new Date().getFullYear()}-01-01`,
  status: p?.status ?? 'terbuka',
  dikunciPada: p?.dikunciPada ?? null,
  saldo: rows.map((r) => ({ akunId: r.akunId, kodePembantuId: r.kodePembantuId, debit: toNumber(r.debit), kredit: toNumber(r.kredit) })),
  totalDebit: Number(centsToString(rows.reduce((s, r) => s + toCents(r.debit), 0n))),
  totalKredit: Number(centsToString(rows.reduce((s, r) => s + toCents(r.kredit), 0n))),
});

async function load(tx, proyekId) {
  const [p] = await tx.select().from(saldoAwalPeriode).where(eq(saldoAwalPeriode.proyekId, proyekId)).limit(1);
  const rows = p ? await tx.select().from(saldoAwal).where(eq(saldoAwal.periodeId, p.id)) : [];
  return { p, rows };
}

async function assertProyek(tx, proyekId) {
  const [p] = await tx.select({ id: trkProjects.id }).from(trkProjects)
    .where(and(eq(trkProjects.id, proyekId), eq(trkProjects.isDeleted, false))).limit(1);
  if (!p) throw new AppError('Proyek tidak ditemukan.', 404);
}

/** Ambil atau buat set saldo awal yang masih terbuka, terkunci untuk transaksi ini. */
async function openPeriode(tx, proyekId, tanggalMulai) {
  await assertProyek(tx, proyekId);
  await tx.insert(saldoAwalPeriode)
    .values({ proyekId, tanggalMulai: tanggalMulai ?? `${new Date().getFullYear()}-01-01` })
    .onConflictDoNothing({ target: saldoAwalPeriode.proyekId });
  const [p] = await tx.select().from(saldoAwalPeriode).where(eq(saldoAwalPeriode.proyekId, proyekId)).for('update').limit(1);
  if (p.status === 'terkunci') throw new AppError('Saldo awal proyek ini sudah dikunci.', 409);

  if (tanggalMulai && tanggalMulai !== p.tanggalMulai) {
    const [lebihAwal] = await tx.select({ id: jurnal.id }).from(jurnal)
      .where(and(eq(jurnal.proyekId, proyekId), lt(jurnal.tanggal, tanggalMulai))).limit(1);
    if (lebihAwal) throw new AppError('Sudah ada jurnal sebelum tanggal mulai tersebut.', 409);
    await tx.update(saldoAwalPeriode).set({ tanggalMulai, updatedAt: new Date() }).where(eq(saldoAwalPeriode.id, p.id));
  }
  return p;
}

async function validateRows(tx, rows) {
  const errors = [];
  const akunIds = [...new Set(rows.map((r) => r.akunId))];
  const akuns = akunIds.length
    ? await tx.select({ id: akun.id, kode: akun.kode, wajibKodePembantu: akun.wajibKodePembantu,
      punyaAnak: sql`EXISTS (SELECT 1 FROM finance.akun c WHERE c.induk_id = ${akun.id})`.mapWith(Boolean) })
      .from(akun).where(inArray(akun.id, akunIds))
    : [];
  const map = new Map(akuns.map((a) => [a.id, a]));
  const kpIds = [...new Set(rows.map((r) => r.kodePembantuId).filter(Boolean))];
  const kps = kpIds.length ? await tx.select({ id: kodePembantu.id }).from(kodePembantu).where(inArray(kodePembantu.id, kpIds)) : [];
  const kpSet = new Set(kps.map((k) => k.id));
  const seen = new Set();

  rows.forEach((r, i) => {
    const a = map.get(r.akunId);
    if (!a) return errors.push(`Baris ${i + 1}: akun tidak ditemukan.`);
    if (a.punyaAnak) errors.push(`Baris ${i + 1}: akun ${a.kode} adalah akun induk.`);
    if (a.wajibKodePembantu && !r.kodePembantuId) errors.push(`Baris ${i + 1}: akun ${a.kode} wajib kode pembantu.`);
    if (r.kodePembantuId && !kpSet.has(r.kodePembantuId)) errors.push(`Baris ${i + 1}: kode pembantu tidak ditemukan.`);
    if (r.debit > 0 && r.kredit > 0) errors.push(`Baris ${i + 1}: isi debit atau kredit, salah satu saja.`);
    const key = `${r.akunId}|${r.kodePembantuId ?? ''}`;
    if (seen.has(key)) errors.push(`Baris ${i + 1}: akun dan kode pembantu yang sama muncul dua kali.`);
    seen.add(key);
  });
  if (errors.length) throw new AppError(errors.length === 1 ? errors[0] : 'Saldo awal tidak valid.', 422, errors);
}

const toValues = (periodeId, r) => ({
  periodeId, akunId: r.akunId, kodePembantuId: r.kodePembantuId ?? null,
  debit: centsToString(toCents(r.debit)), kredit: centsToString(toCents(r.kredit)),
});

export default async function saldoAwalRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/:proyekId', {
    preHandler: [...guard, validate({ params: proyekParams })],
    schema: { tags, description: 'Saldo awal satu proyek' },
  }, async (request) => {
    await assertProyek(db, request.params.proyekId);
    const { p, rows } = await load(db, request.params.proyekId);
    return { success: true, message: 'Success', data: toDto(p, rows, request.params.proyekId) };
  });

  fastify.put('/:proyekId', {
    preHandler: [...guard, validate({
      params: proyekParams,
      body: z.object({ tanggalMulai: isoDate.optional(), saldo: z.array(saldoRow).max(2000) }),
    })],
    schema: { tags, description: 'Ganti seluruh saldo awal proyek (selama belum dikunci). Baris 0/0 diabaikan.' },
  }, async (request) => {
    const actor = actorOf(request);
    const { proyekId } = request.params;
    const rows = request.body.saldo.filter((r) => r.debit > 0 || r.kredit > 0);
    await db.transaction(async (tx) => {
      const p = await openPeriode(tx, proyekId, request.body.tanggalMulai);
      await validateRows(tx, rows);
      await tx.delete(saldoAwal).where(eq(saldoAwal.periodeId, p.id));
      if (rows.length) await tx.insert(saldoAwal).values(rows.map((r) => toValues(p.id, r)));
      await recordAuditTx(tx, { ...actor, action: AuditAction.UPDATE, entity: 'saldo_awal', entityId: p.id, summary: `${rows.length} baris` });
    });
    const { p, rows: saved } = await load(db, proyekId);
    return { success: true, message: 'Saldo awal disimpan', data: toDto(p, saved, proyekId) };
  });

  fastify.put('/:proyekId/akun/:akunId', {
    preHandler: [...guard, validate({
      params: z.object({ proyekId: uuidSchema, akunId: uuidSchema }),
      body: z.object({ kodePembantuId: uuidSchema.optional().nullable(), debit: nominal.default(0), kredit: nominal.default(0) }),
    })],
    schema: { tags, description: 'Isi saldo awal satu akun (dan kode pembantu). 0/0 menghapus barisnya.' },
  }, async (request) => {
    const actor = actorOf(request);
    const { proyekId, akunId } = request.params;
    const row = { akunId, ...request.body };
    await db.transaction(async (tx) => {
      const p = await openPeriode(tx, proyekId);
      const kpFilter = row.kodePembantuId ? eq(saldoAwal.kodePembantuId, row.kodePembantuId) : sql`${saldoAwal.kodePembantuId} IS NULL`;
      await tx.delete(saldoAwal).where(and(eq(saldoAwal.periodeId, p.id), eq(saldoAwal.akunId, akunId), kpFilter));
      if (row.debit > 0 || row.kredit > 0) {
        await validateRows(tx, [row]);
        await tx.insert(saldoAwal).values(toValues(p.id, row));
      }
      await recordAuditTx(tx, { ...actor, action: AuditAction.UPDATE, entity: 'saldo_awal', entityId: p.id, summary: `akun ${akunId}` });
    });
    const { p, rows } = await load(db, proyekId);
    return { success: true, message: 'Saldo awal disimpan', data: toDto(p, rows, proyekId) };
  });

  fastify.post('/:proyekId/kunci', {
    preHandler: [...guard, validate({ params: proyekParams })],
    schema: { tags, description: 'Kunci saldo awal. Total debit harus sama dengan total kredit.' },
  }, async (request) => {
    const actor = actorOf(request);
    const { proyekId } = request.params;
    await db.transaction(async (tx) => {
      const p = await openPeriode(tx, proyekId);
      const rows = await tx.select().from(saldoAwal).where(eq(saldoAwal.periodeId, p.id));
      const d = rows.reduce((s, r) => s + toCents(r.debit), 0n);
      const k = rows.reduce((s, r) => s + toCents(r.kredit), 0n);
      if (d !== k) {
        throw new AppError(`Saldo awal belum seimbang: debit ${centsToString(d)}, kredit ${centsToString(k)}.`, 422);
      }
      await tx.update(saldoAwalPeriode).set({ status: 'terkunci', dikunciOleh: actor.userId, dikunciPada: new Date(), updatedAt: new Date() })
        .where(eq(saldoAwalPeriode.id, p.id));
      await recordAuditTx(tx, { ...actor, action: AuditAction.LOCK, entity: 'saldo_awal', entityId: p.id, summary: 'Saldo awal dikunci' });
    });
    const { p, rows } = await load(db, proyekId);
    return { success: true, message: 'Saldo awal dikunci', data: toDto(p, rows, proyekId) };
  });
}
