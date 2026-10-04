// src/modules/legal/template.routes.js
//
// Template dokumen per PT dan tipe transaksi (FE: templateDokumenStore).
// pasalIds = urutan pasal yang disalin ke dokumen baru.
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../config/database.js';
import { templateDokumen, templatePasal, pasal, dokumen } from '../../shared/schemas/penjualan.schema.js';
import { masterPt } from '../../shared/schemas/akuntansi.schema.js';
import { validate, validatePatch } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { idParams, uuidSchema, optionalText } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { TIPE_TRANSAKSI_LABEL, tipeDariLabel } from '../../shared/constants.js';

const tags = ['Legal - Template'];

const tipeSchema = z.string().transform((v, ctx) => {
  const t = tipeDariLabel(v);
  if (!t) ctx.addIssue({ code: 'custom', message: 'Tipe transaksi harus Cash, KPR, atau In House' });
  return t;
});

const toDto = (t, pasalIds) => ({
  id: t.id, ptId: t.ptId, jenis: t.jenis, tipeTransaksi: TIPE_TRANSAKSI_LABEL[t.tipeTransaksi], nama: t.nama ?? undefined,
  polaNomor: t.polaNomor, pasalIds, aktif: t.aktif, createdAt: t.createdAt,
});

async function pasalIdsOf(ids) {
  if (!ids.length) return new Map();
  const rows = await db.select().from(templatePasal).where(inArray(templatePasal.templateId, ids)).orderBy(asc(templatePasal.urutan));
  const map = new Map(ids.map((id) => [id, []]));
  for (const r of rows) map.get(r.templateId).push(r.pasalId);
  return map;
}

async function getOne(id) {
  const [t] = await db.select().from(templateDokumen).where(eq(templateDokumen.id, id)).limit(1);
  if (!t) throw new AppError('Template tidak ditemukan.', 404);
  return toDto(t, (await pasalIdsOf([id])).get(id));
}

async function setPasal(tx, templateId, pasalIds) {
  if (new Set(pasalIds).size !== pasalIds.length) throw new AppError('Pasal yang sama dipilih dua kali.', 422);
  if (pasalIds.length) {
    const found = await tx.select({ id: pasal.id }).from(pasal).where(inArray(pasal.id, pasalIds));
    if (found.length !== pasalIds.length) throw new AppError('Ada pasal yang tidak ditemukan.', 422);
  }
  await tx.delete(templatePasal).where(eq(templatePasal.templateId, templateId));
  if (pasalIds.length) await tx.insert(templatePasal).values(pasalIds.map((pasalId, i) => ({ templateId, pasalId, urutan: i + 1 })));
}

const body = z.object({
  ptId: uuidSchema,
  tipeTransaksi: tipeSchema,
  nama: optionalText(100),
  polaNomor: z.string().trim().min(1).max(60).refine((v) => v.includes('{NO}'), 'Pola nomor wajib memuat {NO}'),
  pasalIds: z.array(uuidSchema).max(100).default([]),
  aktif: z.boolean().default(true),
});

export default async function templateRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate({ query: z.object({ ptId: uuidSchema.optional() }) })],
    schema: { tags, description: 'Daftar template; pola nomor memakai token {PT} {TAHUN} {BULAN} {TIPE} {NO}' },
  }, async (request) => {
    const rows = await db.select().from(templateDokumen)
      .where(request.query.ptId ? eq(templateDokumen.ptId, request.query.ptId) : undefined).orderBy(asc(templateDokumen.createdAt));
    const ids = await pasalIdsOf(rows.map((r) => r.id));
    return { success: true, message: 'Success', data: rows.map((r) => toDto(r, ids.get(r.id))) };
  });

  fastify.get('/:id', { preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Detail template' } },
    async (request) => ({ success: true, message: 'Success', data: await getOne(request.params.id) }));

  fastify.post('/', {
    preHandler: [...guard, validate({ body })], schema: { tags, description: 'Tambah template' },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const { pasalIds, ...b } = request.body;
    const id = await db.transaction(async (tx) => {
      const [pt] = await tx.select({ id: masterPt.id }).from(masterPt).where(eq(masterPt.id, b.ptId)).limit(1);
      if (!pt) throw new AppError('PT tidak ditemukan.', 422);
      const [t] = await tx.insert(templateDokumen).values(b).returning();
      await setPasal(tx, t.id, pasalIds);
      await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'template_dokumen', entityId: t.id, summary: t.polaNomor });
      return t.id;
    });
    return reply.code(201).send({ success: true, message: 'Template ditambahkan', data: await getOne(id) });
  });

  fastify.patch('/:id', {
    preHandler: [...guard, validatePatch({ params: idParams, body: body.partial() })],
    schema: { tags, description: 'Ubah template (pasalIds = urutan baru). Dokumen yang sudah dibuat tidak ikut berubah.' },
  }, async (request) => {
    const actor = actorOf(request);
    const { pasalIds, ...b } = request.body;
    await db.transaction(async (tx) => {
      const [t] = await tx.update(templateDokumen).set({ ...b, updatedAt: new Date() }).where(eq(templateDokumen.id, request.params.id)).returning();
      if (!t) throw new AppError('Template tidak ditemukan.', 404);
      if (pasalIds) await setPasal(tx, t.id, pasalIds);
      await recordAuditTx(tx, { ...actor, action: AuditAction.UPDATE, entity: 'template_dokumen', entityId: t.id, summary: t.polaNomor });
    });
    return { success: true, message: 'Template diperbarui', data: await getOne(request.params.id) };
  });

  fastify.post('/:id/duplikat', {
    preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Salin template' },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const src = await getOne(request.params.id);
    const id = await db.transaction(async (tx) => {
      const [t] = await tx.insert(templateDokumen).values({
        ptId: src.ptId, jenis: src.jenis, tipeTransaksi: tipeDariLabel(src.tipeTransaksi), nama: src.nama ? `${src.nama} (salinan)` : null,
        polaNomor: src.polaNomor, aktif: false,
      }).returning();
      await setPasal(tx, t.id, src.pasalIds);
      await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'template_dokumen', entityId: t.id, summary: `Salinan ${src.id}` });
      return t.id;
    });
    return reply.code(201).send({ success: true, message: 'Template disalin (nonaktif)', data: await getOne(id) });
  });

  fastify.delete('/:id', {
    preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Hapus template yang belum dipakai dokumen' },
  }, async (request) => {
    const actor = actorOf(request);
    await db.transaction(async (tx) => {
      const [used] = await tx.select({ id: dokumen.id }).from(dokumen).where(eq(dokumen.templateId, request.params.id)).limit(1);
      if (used) throw new AppError('Template sudah dipakai dokumen. Nonaktifkan saja.', 409);
      const [t] = await tx.delete(templateDokumen).where(eq(templateDokumen.id, request.params.id)).returning();
      if (!t) throw new AppError('Template tidak ditemukan.', 404);
      await recordAuditTx(tx, { ...actor, action: AuditAction.DELETE, entity: 'template_dokumen', entityId: t.id, summary: t.polaNomor });
    });
    return { success: true, message: 'Template dihapus' };
  });
}

