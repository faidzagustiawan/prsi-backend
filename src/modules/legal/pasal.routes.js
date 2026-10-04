// src/modules/legal/pasal.routes.js
//
// Pustaka pasal (FE: pustakaPasalStore). Pasal yang sudah dipakai template atau
// dokumen tidak bisa dihapus; cukup dinonaktifkan. Dokumen menyimpan salinan
// teks pasal, jadi mengubah pustaka tidak mengubah dokumen yang sudah dibuat.
import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db } from '../../config/database.js';
import { pasal, templatePasal, dokumenPasal } from '../../shared/schemas/penjualan.schema.js';
import { validate, validatePatch } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { idParams, uuidSchema } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { BERLAKU_PASAL } from '../../shared/constants.js';

const tags = ['Legal - Pustaka Pasal'];

export const fieldSchema = z.object({
  id: z.string().max(60).optional(),
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Key field huruf kecil, angka, garis bawah'),
  label: z.string().trim().min(1).max(80),
  tipe: z.enum(['teks', 'angka', 'tanggal']),
});

export const toPasalDto = (p) => ({
  id: p.id, judul: p.judul, isi: p.isi, berlaku: p.berlakuUntuk, ptId: p.ptId, fields: p.fields, aktif: p.aktif, createdAt: p.createdAt,
});

const body = z.object({
  judul: z.string().trim().min(1, 'Judul wajib diisi').max(150),
  isi: z.string().trim().min(1, 'Isi pasal wajib diisi').max(20000),
  berlaku: z.enum(BERLAKU_PASAL).default('semua'),
  ptId: uuidSchema.optional().nullable(),
  fields: z.array(fieldSchema).max(40).default([]),
  aktif: z.boolean().default(true),
});

const toColumns = (b) => {
  const out = {};
  for (const k of ['judul', 'isi', 'ptId', 'aktif']) if (k in b) out[k] = b[k];
  if ('berlaku' in b) out.berlakuUntuk = b.berlaku;
  if ('fields' in b) {
    const keys = new Set();
    for (const f of b.fields) {
      if (keys.has(f.key)) throw new AppError(`Key field "${f.key}" dipakai dua kali.`, 422);
      keys.add(f.key);
    }
    out.fields = b.fields.map((f) => ({ ...f, id: f.id ?? randomUUID() }));
  }
  return out;
};

async function dipakai(tx, id) {
  const [[{ t }], [{ d }]] = await Promise.all([
    tx.select({ t: count() }).from(templatePasal).where(eq(templatePasal.pasalId, id)),
    tx.select({ d: count() }).from(dokumenPasal).where(eq(dokumenPasal.pustakaId, id)),
  ]);
  return { template: Number(t), dokumen: Number(d) };
}

export default async function pasalRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate({ query: z.object({ berlaku: z.enum(BERLAKU_PASAL).optional(), aktif: z.enum(['true', 'false']).optional() }) })],
    schema: { tags, description: 'Daftar pasal' },
  }, async (request) => {
    const f = [];
    if (request.query.berlaku) f.push(eq(pasal.berlakuUntuk, request.query.berlaku));
    if (request.query.aktif) f.push(eq(pasal.aktif, request.query.aktif === 'true'));
    const rows = await db.select().from(pasal).where(f.length ? and(...f) : undefined).orderBy(asc(pasal.judul));
    return { success: true, message: 'Success', data: rows.map(toPasalDto) };
  });

  fastify.get('/:id/dipakai', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Jumlah template dan dokumen yang memakai pasal ini (FE: hitungDipakai)' },
  }, async (request) => ({ success: true, message: 'Success', data: await dipakai(db, request.params.id) }));

  fastify.post('/', {
    preHandler: [...guard, validate({ body })], schema: { tags, description: 'Tambah pasal' },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(pasal).values(toColumns(request.body)).returning();
      await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'pasal', entityId: created.id, summary: created.judul });
      return created;
    });
    return reply.code(201).send({ success: true, message: 'Pasal ditambahkan', data: toPasalDto(row) });
  });

  fastify.patch('/:id', {
    preHandler: [...guard, validatePatch({ params: idParams, body: body.partial() })],
    schema: { tags, description: 'Ubah pasal (termasuk aktif/nonaktif). Dokumen yang sudah dibuat tidak ikut berubah.' },
  }, async (request) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(pasal).set({ ...toColumns(request.body), updatedAt: new Date() })
        .where(eq(pasal.id, request.params.id)).returning();
      if (!updated) throw new AppError('Pasal tidak ditemukan.', 404);
      await recordAuditTx(tx, { ...actor, action: AuditAction.UPDATE, entity: 'pasal', entityId: updated.id, summary: updated.judul });
      return updated;
    });
    return { success: true, message: 'Pasal diperbarui', data: toPasalDto(row) };
  });

  fastify.delete('/:id', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Hapus pasal yang belum dipakai template atau dokumen' },
  }, async (request) => {
    const actor = actorOf(request);
    await db.transaction(async (tx) => {
      const pakai = await dipakai(tx, request.params.id);
      if (pakai.template || pakai.dokumen) {
        throw new AppError(`Pasal dipakai ${pakai.template} template dan ${pakai.dokumen} dokumen. Nonaktifkan saja.`, 409);
      }
      const [deleted] = await tx.delete(pasal).where(eq(pasal.id, request.params.id)).returning();
      if (!deleted) throw new AppError('Pasal tidak ditemukan.', 404);
      await recordAuditTx(tx, { ...actor, action: AuditAction.DELETE, entity: 'pasal', entityId: deleted.id, summary: deleted.judul });
    });
    return { success: true, message: 'Pasal dihapus' };
  });
}
