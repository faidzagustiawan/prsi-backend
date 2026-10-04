// src/modules/master-pt/master-pt.routes.js
//
// Badan hukum PT (pihak pertama di SPPR). Milik SI. Bentuk data mengikuti
// MasterPt di frontend (src/store/masterPtStore.ts); perumahanId = proyekId.
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../config/database.js';
import { masterPt, jurnal, periode } from '../../shared/schemas/akuntansi.schema.js';
import { trkProjects } from '../../shared/schemas/track.schema.js';
import { validate, validatePatch } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { idParams, uuidSchema, optionalText } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordFieldChanges, recordAuditTx, AuditAction } from '../../shared/utils/audit.js';

const tags = ['Master PT'];

const toDto = (r) => ({
  id: r.id,
  namaPt: r.namaPt,
  singkatan: r.singkatan,
  namaDirektur: r.namaDirektur,
  ttl: r.ttl ?? '',
  pekerjaan: r.pekerjaan ?? '',
  alamat: r.alamat ?? '',
  noKtp: r.noKtp ?? '',
  perumahanId: r.proyekId ?? undefined,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const fields = {
  namaPt: z.string().trim().min(1, 'Nama PT wajib diisi').max(150),
  singkatan: optionalText(20),
  namaDirektur: z.string().trim().min(1, 'Nama direktur wajib diisi').max(150),
  ttl: optionalText(150),
  pekerjaan: optionalText(100),
  alamat: optionalText(2000),
  noKtp: z.string().trim().regex(/^\d{16}$/, 'No. KTP harus 16 digit').optional().nullable().or(z.literal('')),
  perumahanId: uuidSchema.optional().nullable().or(z.literal('')),
};

const toColumns = (b) => {
  const out = {};
  for (const key of ['namaPt', 'singkatan', 'namaDirektur', 'ttl', 'pekerjaan', 'alamat']) if (key in b) out[key] = b[key];
  if ('noKtp' in b) out.noKtp = b.noKtp || null;
  if ('perumahanId' in b) out.proyekId = b.perumahanId || null;
  return out;
};

const LABELS = {
  namaPt: 'Nama PT', singkatan: 'Singkatan', namaDirektur: 'Nama direktur', ttl: 'Tempat, tanggal lahir',
  pekerjaan: 'Pekerjaan', alamat: 'Alamat', noKtp: 'No. KTP', proyekId: 'Perumahan',
};

async function assertProyek(tx, proyekId, selfId) {
  if (!proyekId) return;
  const [p] = await tx.select({ id: trkProjects.id }).from(trkProjects)
    .where(and(eq(trkProjects.id, proyekId), eq(trkProjects.isDeleted, false))).limit(1);
  if (!p) throw new AppError('Perumahan tidak ditemukan.', 400);
  const taken = await tx.select({ id: masterPt.id }).from(masterPt)
    .where(and(eq(masterPt.proyekId, proyekId), isNull(masterPt.deletedAt), selfId ? ne(masterPt.id, selfId) : undefined))
    .limit(1);
  if (taken.length) throw new AppError('Perumahan ini sudah terikat ke PT lain.', 409);
}

async function findActive(tx, id) {
  const [row] = await tx.select().from(masterPt).where(and(eq(masterPt.id, id), isNull(masterPt.deletedAt))).limit(1);
  if (!row) throw new AppError('PT tidak ditemukan.', 404);
  return row;
}

export default async function masterPtRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', { preHandler: guard, schema: { tags, description: 'Daftar PT' } }, async () => {
    const rows = await db.select().from(masterPt).where(isNull(masterPt.deletedAt)).orderBy(asc(masterPt.namaPt));
    return { success: true, message: 'Success', data: rows.map(toDto) };
  });

  fastify.get('/:id', {
    preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Detail PT' },
  }, async (request) => ({ success: true, message: 'Success', data: toDto(await findActive(db, request.params.id)) }));

  fastify.post('/', {
    preHandler: [...guard, validate({ body: z.object(fields) })], schema: { tags, description: 'Tambah PT' },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      const values = toColumns(request.body);
      await assertProyek(tx, values.proyekId);
      const [created] = await tx.insert(masterPt).values(values).returning();
      await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'master_pt', entityId: created.id, summary: created.namaPt });
      return created;
    });
    return reply.code(201).send({ success: true, message: 'PT ditambahkan', data: toDto(row) });
  });

  fastify.patch('/:id', {
    preHandler: [...guard, validatePatch({ params: idParams, body: z.object(fields).partial() })],
    schema: { tags, description: 'Ubah PT (riwayat perubahan dicatat per kolom)' },
  }, async (request) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      const before = await findActive(tx, request.params.id);
      const values = toColumns(request.body);
      if ('proyekId' in values) await assertProyek(tx, values.proyekId, before.id);
      const [updated] = await tx.update(masterPt).set({ ...values, updatedAt: new Date() })
        .where(eq(masterPt.id, before.id)).returning();
      await recordFieldChanges(tx, { ...actor, entity: 'master_pt', entityId: before.id, before, after: values, labels: LABELS });
      return updated;
    });
    return { success: true, message: 'PT diperbarui', data: toDto(row) };
  });

  fastify.delete('/:id', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Hapus PT (ditolak bila sudah dipakai jurnal atau periode)' },
  }, async (request) => {
    const actor = actorOf(request);
    await db.transaction(async (tx) => {
      const before = await findActive(tx, request.params.id);
      const [dipakai] = await tx.select({ id: jurnal.id }).from(jurnal).where(eq(jurnal.ptId, before.id)).limit(1);
      const [ditutup] = await tx.select({ id: periode.id }).from(periode).where(eq(periode.ptId, before.id)).limit(1);
      if (dipakai || ditutup) throw new AppError('PT sudah dipakai di jurnal atau tutup buku, tidak bisa dihapus.', 409);
      // Soft delete: dokumen legal lama tetap bisa menunjuk PT ini
      await tx.update(masterPt).set({ deletedAt: new Date(), proyekId: null }).where(eq(masterPt.id, before.id));
      await recordAuditTx(tx, { ...actor, action: AuditAction.DELETE, entity: 'master_pt', entityId: before.id, summary: before.namaPt });
    });
    return { success: true, message: 'PT dihapus' };
  });
}

