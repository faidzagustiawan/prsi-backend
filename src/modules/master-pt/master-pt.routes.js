// src/modules/master-pt/master-pt.routes.js
//
// Badan hukum PT (pihak pertama di SPPR). Milik SI. Bentuk data mengikuti
// MasterPt di frontend (src/store/masterPtStore.ts). Satu PT bisa memiliki
// banyak perumahan (perumahanIds = proyekId di master_pt_proyek); perumahanId
// tetap dikirim (perumahan pertama) untuk klien lama.
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../config/database.js';
import { masterPt, masterPtProyek, jurnal, periode } from '../../shared/schemas/akuntansi.schema.js';
import { trkProjects, trkCompanies } from '../../shared/schemas/track.schema.js';
import { assertCompanyMapping } from './master-pt.service.js';
import { validate, validatePatch } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { idParams, uuidSchema, optionalText } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordFieldChanges, recordAuditTx, AuditAction } from '../../shared/utils/audit.js';

const tags = ['Master PT'];

const toDto = (r, proyekIds = []) => ({
  id: r.id,
  trackCompanyId: r.trackCompanyId,
  namaPt: r.namaPt,
  singkatan: r.singkatan,
  namaDirektur: r.namaDirektur,
  ttl: r.ttl ?? '',
  pekerjaan: r.pekerjaan ?? '',
  alamat: r.alamat ?? '',
  noKtp: r.noKtp ?? '',
  perumahanId: proyekIds[0] ?? undefined,
  perumahanIds: proyekIds,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const fields = {
  trackCompanyId: uuidSchema.optional().nullable(),
  namaPt: z.string().trim().min(1, 'Nama PT wajib diisi').max(150),
  singkatan: optionalText(20),
  namaDirektur: z.string().trim().min(1, 'Nama direktur wajib diisi').max(150),
  ttl: optionalText(150),
  pekerjaan: optionalText(100),
  alamat: optionalText(2000),
  noKtp: z.string().trim().regex(/^\d{16}$/, 'No. KTP harus 16 digit').optional().nullable().or(z.literal('')),
  perumahanId: uuidSchema.optional().nullable().or(z.literal('')),
  perumahanIds: z.array(uuidSchema).max(100).optional().nullable(),
};

/** Perumahan dari body: perumahanIds diutamakan, perumahanId untuk klien lama. undefined = tidak diubah. */
const proyekDariBody = (b) => {
  if (b.perumahanIds !== undefined) return [...new Set(b.perumahanIds ?? [])];
  if (b.perumahanId !== undefined) return b.perumahanId ? [b.perumahanId] : [];
  return undefined;
};

const toColumns = (b) => {
  const out = {};
  if ('trackCompanyId' in b) out.trackCompanyId = b.trackCompanyId;
  for (const key of ['namaPt', 'singkatan', 'namaDirektur', 'ttl', 'pekerjaan', 'alamat']) if (key in b) out[key] = b[key];
  if ('noKtp' in b) out.noKtp = b.noKtp || null;
  return out;
};

const LABELS = {
  namaPt: 'Nama PT', singkatan: 'Singkatan', namaDirektur: 'Nama direktur', ttl: 'Tempat, tanggal lahir',
  trackCompanyId: 'Company PRTrack',
  pekerjaan: 'Pekerjaan', alamat: 'Alamat', noKtp: 'No. KTP', proyekIds: 'Perumahan',
};

async function assertProyek(tx, proyekIds, selfId) {
  if (!proyekIds.length) return;
  const found = await tx.select({ id: trkProjects.id }).from(trkProjects)
    .where(and(inArray(trkProjects.id, proyekIds), eq(trkProjects.isDeleted, false)));
  if (found.length !== proyekIds.length) throw new AppError('Perumahan tidak ditemukan.', 400);
  const [taken] = await tx.select({ nama: trkProjects.nama }).from(masterPtProyek)
    .innerJoin(trkProjects, eq(trkProjects.id, masterPtProyek.proyekId))
    .where(and(inArray(masterPtProyek.proyekId, proyekIds), selfId ? ne(masterPtProyek.ptId, selfId) : undefined))
    .limit(1);
  if (taken) throw new AppError(`Perumahan ${taken.nama} sudah terikat ke PT lain.`, 409);
}

/** Peta ptId -> daftar proyekId. */
async function proyekByPt(tx, ptIds) {
  const map = new Map(ptIds.map((id) => [id, []]));
  if (!ptIds.length) return map;
  const rows = await tx.select().from(masterPtProyek).where(inArray(masterPtProyek.ptId, ptIds))
    .orderBy(asc(masterPtProyek.createdAt), asc(masterPtProyek.proyekId));
  for (const r of rows) map.get(r.ptId)?.push(r.proyekId);
  return map;
}

/** Ganti seluruh perumahan PT; perubahan dicatat sebagai satu field audit. */
async function setProyek(tx, actor, ptId, proyekIds, before = []) {
  const sama = before.length === proyekIds.length && before.every((id) => proyekIds.includes(id));
  if (sama) return;
  await tx.delete(masterPtProyek).where(eq(masterPtProyek.ptId, ptId));
  if (proyekIds.length) await tx.insert(masterPtProyek).values(proyekIds.map((proyekId) => ({ ptId, proyekId })));
  await recordFieldChanges(tx, {
    ...actor, entity: 'master_pt', entityId: ptId, labels: LABELS,
    before: { proyekIds: before.join(', ') || '-' }, after: { proyekIds: proyekIds.join(', ') || '-' },
  });
}

async function dtoOf(tx, row) {
  return toDto(row, (await proyekByPt(tx, [row.id])).get(row.id));
}

async function findActive(tx, id) {
  const [row] = await tx.select().from(masterPt).where(and(eq(masterPt.id, id), isNull(masterPt.deletedAt))).limit(1);
  if (!row) throw new AppError('PT tidak ditemukan.', 404);
  return row;
}

export default async function masterPtRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/companies', { preHandler: guard, schema: { tags, description: 'Company aktif PRTrack; id lokal dipakai sebagai trackCompanyId, trackId adalah ID sumber' } }, async () => ({
    success: true, message: 'Success', data: await db.select({ id: trkCompanies.id, trackId: trkCompanies.trackId, nama: trkCompanies.nama, kode: trkCompanies.kode })
      .from(trkCompanies).where(eq(trkCompanies.isDeleted, false)).orderBy(asc(trkCompanies.nama)),
  }));

  fastify.get('/', { preHandler: guard, schema: { tags, description: 'Daftar PT' } }, async () => {
    const rows = await db.select().from(masterPt).where(isNull(masterPt.deletedAt)).orderBy(asc(masterPt.namaPt));
    const proyek = await proyekByPt(db, rows.map((r) => r.id));
    return { success: true, message: 'Success', data: rows.map((r) => toDto(r, proyek.get(r.id))) };
  });

  fastify.get('/:id', {
    preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Detail PT' },
  }, async (request) => ({ success: true, message: 'Success', data: await dtoOf(db, await findActive(db, request.params.id)) }));

  fastify.post('/', {
    preHandler: [...guard, validate({ body: z.object(fields) })], schema: { tags, description: 'Tambah PT' },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      const values = toColumns(request.body);
      const proyekIds = proyekDariBody(request.body) ?? [];
      await assertProyek(tx, proyekIds);
      await assertCompanyMapping(tx, { ...values, proyekIds });
      const [created] = await tx.insert(masterPt).values(values).returning();
      if (proyekIds.length) await tx.insert(masterPtProyek).values(proyekIds.map((proyekId) => ({ ptId: created.id, proyekId })));
      await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'master_pt', entityId: created.id, summary: created.namaPt });
      return dtoOf(tx, created);
    });
    return reply.code(201).send({ success: true, message: 'PT ditambahkan', data: row });
  });

  fastify.patch('/:id', {
    preHandler: [...guard, validatePatch({ params: idParams, body: z.object(fields).partial() })],
    schema: { tags, description: 'Ubah PT (riwayat perubahan dicatat per kolom)' },
  }, async (request) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      const before = await findActive(tx, request.params.id);
      const values = toColumns(request.body);
      const proyekLama = (await proyekByPt(tx, [before.id])).get(before.id);
      const proyekBaru = proyekDariBody(request.body);
      if (proyekBaru) await assertProyek(tx, proyekBaru, before.id);
      await assertCompanyMapping(tx, { ...before, ...values, proyekIds: proyekBaru ?? proyekLama }, before.id);
      const [updated] = await tx.update(masterPt).set({ ...values, updatedAt: new Date() })
        .where(eq(masterPt.id, before.id)).returning();
      await recordFieldChanges(tx, { ...actor, entity: 'master_pt', entityId: before.id, before, after: values, labels: LABELS });
      if (proyekBaru) await setProyek(tx, actor, before.id, proyekBaru, proyekLama);
      return dtoOf(tx, updated);
    });
    return { success: true, message: 'PT diperbarui', data: row };
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
      await tx.update(masterPt).set({ deletedAt: new Date() }).where(eq(masterPt.id, before.id));
      await tx.delete(masterPtProyek).where(eq(masterPtProyek.ptId, before.id));
      await recordAuditTx(tx, { ...actor, action: AuditAction.DELETE, entity: 'master_pt', entityId: before.id, summary: before.namaPt });
    });
    return { success: true, message: 'PT dihapus' };
  });
}
