// src/modules/kode-pembantu/kode-pembantu.routes.js
//
// Kode pembantu = pihak lawan transaksi (pemilik lahan, bank, investor,
// kontraktor, pembeli, ...). Bentuk mengikuti KodePembantu di frontend
// (src/store/hutangStore.ts) ditambah `kode` dan `aktif`.
import { and, asc, eq, ilike, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../config/database.js';
import { kodePembantu, jurnalDetail, saldoAwal } from '../../shared/schemas/akuntansi.schema.js';
import { findKategoriByKode } from '../kategori-hp/kategori-hp.routes.js';
import { trkProjects } from '../../shared/schemas/track.schema.js';
import { validate, validatePatch } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { idParams, uuidSchema } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordFieldChanges, recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { nextNumber, pad } from '../../shared/utils/penomoran.js';

const tags = ['Kode Pembantu'];

export const toKodePembantuDto = (r) => ({
  id: r.id,
  kode: r.kode,
  nama: r.nama,
  kategori: r.kategori,
  proyekId: r.proyekId,
  customerId: r.customerId,
  aktif: r.aktif,
});

async function assertProyek(tx, proyekId) {
  if (!proyekId) return;
  const [p] = await tx.select({ id: trkProjects.id }).from(trkProjects).where(eq(trkProjects.id, proyekId)).limit(1);
  if (!p) throw new AppError('Proyek tidak ditemukan.', 400);
}

/**
 * Kode otomatis per kategori, mis. LH-0008, dengan prefix dari tabel kategori.
 * Kategori harus ada dan aktif. Dipakai juga oleh worker untuk pembeli baru.
 */
export async function generateKode(tx, kategori) {
  const { prefixKodePembantu: prefix } = await findKategoriByKode(tx, kategori);
  const n = await nextNumber(tx, { jenis: 'kode_pembantu', scope: prefix, tahun: 0 });
  return `${prefix}-${pad(n)}`;
}

async function findKp(tx, id) {
  const [row] = await tx.select().from(kodePembantu).where(eq(kodePembantu.id, id)).limit(1);
  if (!row) throw new AppError('Kode pembantu tidak ditemukan.', 404);
  return row;
}

const LABELS = { nama: 'Nama', kategori: 'Kategori', proyekId: 'Proyek', aktif: 'Status' };

export default async function kodePembantuRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate({
      query: z.object({
        proyekId: uuidSchema.optional(),
        kategori: z.string().trim().max(20).optional(),
        aktif: z.enum(['true', 'false']).optional(),
        q: z.string().trim().max(100).optional(),
      }),
    })],
    schema: { tags, description: 'Daftar kode pembantu (filter proyekId, kategori, aktif, q)' },
  }, async (request) => {
    const { proyekId, kategori, aktif, q } = request.query;
    const filters = [];
    if (proyekId) filters.push(eq(kodePembantu.proyekId, proyekId));
    if (kategori) filters.push(eq(kodePembantu.kategori, kategori));
    if (aktif) filters.push(eq(kodePembantu.aktif, aktif === 'true'));
    if (q) filters.push(or(ilike(kodePembantu.nama, `%${q}%`), ilike(kodePembantu.kode, `%${q}%`)));
    const rows = await db.select().from(kodePembantu).where(filters.length ? and(...filters) : undefined).orderBy(asc(kodePembantu.kode));
    return { success: true, message: 'Success', data: rows.map(toKodePembantuDto) };
  });

  fastify.post('/', {
    preHandler: [...guard, validate({
      body: z.object({
        nama: z.string().trim().min(1, 'Nama wajib diisi').max(150),
        kategori: z.string().trim().min(1, 'Kategori wajib diisi').max(20),
        proyekId: uuidSchema.optional().nullable(),
      }),
    })],
    schema: { tags, description: 'Tambah kode pembantu; kode dibuat otomatis per kategori' },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      await assertProyek(tx, request.body.proyekId);
      const [created] = await tx.insert(kodePembantu).values({
        kode: await generateKode(tx, request.body.kategori),
        nama: request.body.nama,
        kategori: request.body.kategori,
        proyekId: request.body.proyekId ?? null,
      }).returning();
      await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'kode_pembantu', entityId: created.id, summary: `${created.kode} ${created.nama}` });
      return created;
    });
    return reply.code(201).send({ success: true, message: 'Kode pembantu ditambahkan', data: toKodePembantuDto(row) });
  });

  fastify.patch('/:id', {
    preHandler: [...guard, validatePatch({
      params: idParams,
      body: z.object({
        nama: z.string().trim().min(1).max(150),
        proyekId: uuidSchema.nullable(),
        aktif: z.boolean(),
      }).partial(),
    })],
    schema: { tags, description: 'Ubah nama, proyek, atau status aktif. Kategori tidak bisa diubah.' },
  }, async (request) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      const before = await findKp(tx, request.params.id);
      if ('proyekId' in request.body) await assertProyek(tx, request.body.proyekId);
      const [updated] = await tx.update(kodePembantu).set({ ...request.body, updatedAt: new Date() })
        .where(eq(kodePembantu.id, before.id)).returning();
      await recordFieldChanges(tx, {
        ...actor, entity: 'kode_pembantu', entityId: before.id, before, after: request.body, labels: LABELS,
        format: { aktif: (v) => (v ? 'Aktif' : 'Nonaktif') },
      });
      return updated;
    });
    return { success: true, message: 'Kode pembantu diperbarui', data: toKodePembantuDto(row) };
  });

  fastify.delete('/:id', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Hapus kode pembantu yang belum dipakai; yang sudah dipakai cukup dinonaktifkan' },
  }, async (request) => {
    const actor = actorOf(request);
    await db.transaction(async (tx) => {
      const before = await findKp(tx, request.params.id);
      const [jd] = await tx.select({ id: jurnalDetail.id }).from(jurnalDetail).where(eq(jurnalDetail.kodePembantuId, before.id)).limit(1);
      const [sa] = await tx.select({ id: saldoAwal.id }).from(saldoAwal).where(eq(saldoAwal.kodePembantuId, before.id)).limit(1);
      if (jd || sa) throw new AppError('Kode pembantu sudah dipakai jurnal atau saldo awal. Nonaktifkan saja.', 409);
      await tx.delete(kodePembantu).where(eq(kodePembantu.id, before.id));
      await recordAuditTx(tx, { ...actor, action: AuditAction.DELETE, entity: 'kode_pembantu', entityId: before.id, summary: `${before.kode} ${before.nama}` });
    });
    return { success: true, message: 'Kode pembantu dihapus' };
  });
}
