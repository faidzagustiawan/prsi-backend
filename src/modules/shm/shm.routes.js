// src/modules/shm/shm.routes.js
//
// SHM dan PBG per kavling (FE: shmStore). Tidak ada jurnal; setiap perubahan
// status SHM dicatat di shm_riwayat. SHM berstatus "dijaminkan" wajib menunjuk
// pinjaman bank tempatnya dijaminkan.
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../config/database.js';
import { dokumenLegalKavling, shmRiwayat, pinjaman } from '../../shared/schemas/hutang.schema.js';
import { kodePembantu } from '../../shared/schemas/akuntansi.schema.js';
import { trkUnits } from '../../shared/schemas/track.schema.js';
import { users } from '../../shared/schemas/finance.schema.js';
import { validate } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { uuidSchema, idParams, optionalText } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';

const tags = ['SHM / PBG'];
const STATUS_SHM = ['di_notaris', 'di_kantor', 'dijaminkan', 'sudah_ditebus', 'lainnya'];
const STATUS_PBG = ['belum_diajukan', 'dalam_proses', 'terbit', 'lainnya'];
const today = () => new Date().toISOString().slice(0, 10);

const selectShm = () => db
  .select({ d: dokumenLegalKavling, kavling: trkUnits.kode, proyekId: trkUnits.projectId, namaBank: kodePembantu.nama })
  .from(dokumenLegalKavling)
  .innerJoin(trkUnits, eq(trkUnits.id, dokumenLegalKavling.unitId))
  .leftJoin(pinjaman, eq(pinjaman.id, dokumenLegalKavling.pinjamanId))
  .leftJoin(kodePembantu, eq(kodePembantu.id, pinjaman.kodePembantuId));

const toRiwayatDto = (r) => ({
  id: r.id, shmId: r.dokumenId, tanggal: r.tanggal, dariStatus: r.dariStatus, keStatus: r.keStatus,
  lokasi: r.lokasi ?? undefined, keterangan: r.keterangan ?? undefined, oleh: r.oleh ?? 'Sistem',
});

const toDto = ({ d, kavling, proyekId, namaBank }, riwayat = []) => ({
  id: d.id,
  nomorShm: d.noShm,
  unitId: d.unitId,
  kavling,
  proyekId,
  status: d.statusShm,
  statusKustom: d.statusShmKustom ?? undefined,
  lokasi: d.lokasi,
  pinjamanBankId: d.pinjamanId ?? undefined,
  namaBank: namaBank ?? undefined,
  noPbg: d.noPbg ?? undefined,
  statusPbg: d.statusPbg,
  statusPbgKustom: d.statusPbgKustom ?? undefined,
  riwayat: riwayat.map(toRiwayatDto),
  createdAt: d.createdAt,
});

async function loadRiwayat(ids) {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ r: shmRiwayat, oleh: users.nama })
    .from(shmRiwayat).leftJoin(users, eq(users.id, shmRiwayat.oleh))
    .where(inArray(shmRiwayat.dokumenId, ids))
    .orderBy(asc(shmRiwayat.createdAt));
  const map = new Map();
  for (const { r, oleh } of rows) {
    const list = map.get(r.dokumenId) ?? [];
    list.push({ ...r, oleh });
    map.set(r.dokumenId, list);
  }
  return map;
}

async function getOne(id) {
  const [row] = await selectShm().where(eq(dokumenLegalKavling.id, id)).limit(1);
  if (!row) throw new AppError('SHM tidak ditemukan.', 404);
  return toDto(row, (await loadRiwayat([id])).get(id));
}

async function assertJaminan(tx, status, pinjamanId) {
  if (status !== 'dijaminkan') return null;
  if (!pinjamanId) throw new AppError('SHM yang dijaminkan wajib memilih pinjaman bank.', 422);
  const [p] = await tx.select({ id: pinjaman.id }).from(pinjaman).where(eq(pinjaman.id, pinjamanId)).limit(1);
  if (!p) throw new AppError('Pinjaman bank tidak ditemukan.', 422);
  return p.id;
}

const kustom = (status, value) => (status === 'lainnya' ? (value?.trim() || null) : null);

export default async function shmRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate({ query: z.object({ proyekId: uuidSchema.optional(), pinjamanId: uuidSchema.optional() }) })],
    schema: { tags, description: 'Daftar SHM dengan riwayat (filter proyekId, pinjamanId)' },
  }, async (request) => {
    const { proyekId, pinjamanId } = request.query;
    const filters = [];
    if (proyekId) filters.push(eq(trkUnits.projectId, proyekId));
    if (pinjamanId) filters.push(eq(dokumenLegalKavling.pinjamanId, pinjamanId));
    const rows = await selectShm().where(filters.length ? and(...filters) : undefined).orderBy(asc(trkUnits.kode));
    const riwayat = await loadRiwayat(rows.map((r) => r.d.id));
    return { success: true, message: 'Success', data: rows.map((r) => toDto(r, riwayat.get(r.d.id))) };
  });

  fastify.get('/opsi', {
    preHandler: guard,
    schema: { tags, description: 'Status kustom dan lokasi yang pernah dipakai, untuk saran isian (FE: getCustomStatuses/getCustomLokasis)' },
  }, async () => {
    const rows = await db.select({ s: dokumenLegalKavling.statusShmKustom, l: dokumenLegalKavling.lokasi }).from(dokumenLegalKavling);
    const pbg = await db.selectDistinct({ s: dokumenLegalKavling.statusPbgKustom }).from(dokumenLegalKavling)
      .where(isNotNull(dokumenLegalKavling.statusPbgKustom));
    const uniq = (xs) => [...new Set(xs.filter(Boolean).map((x) => x.trim()))].sort();
    return {
      success: true, message: 'Success',
      data: { statusKustom: uniq(rows.map((r) => r.s)), lokasi: uniq(rows.map((r) => r.l)), statusPbgKustom: uniq(pbg.map((r) => r.s)) },
    };
  });

  fastify.get('/:id', {
    preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Detail SHM' },
  }, async (request) => ({ success: true, message: 'Success', data: await getOne(request.params.id) }));

  fastify.post('/', {
    preHandler: [...guard, validate({
      body: z.object({
        nomorShm: z.string().trim().min(1, 'Nomor SHM wajib diisi').max(40),
        unitId: uuidSchema,
        status: z.enum(STATUS_SHM),
        statusKustom: optionalText(60),
        lokasi: z.string().trim().min(1, 'Lokasi wajib diisi').max(100),
        pinjamanBankId: uuidSchema.optional().nullable(),
        noPbg: optionalText(40),
        statusPbg: z.enum(STATUS_PBG).default('belum_diajukan'),
        statusPbgKustom: optionalText(60),
      }),
    })],
    schema: { tags, description: 'Tambah SHM. Satu kavling satu SHM; nomor SHM unik.' },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const b = request.body;
    const id = await db.transaction(async (tx) => {
      const [unit] = await tx.select({ id: trkUnits.id }).from(trkUnits).where(eq(trkUnits.id, b.unitId)).limit(1);
      if (!unit) throw new AppError('Kavling tidak ditemukan.', 404);
      const [dupe] = await tx.select({ id: dokumenLegalKavling.id, unitId: dokumenLegalKavling.unitId, noShm: dokumenLegalKavling.noShm })
        .from(dokumenLegalKavling).where(eq(dokumenLegalKavling.unitId, b.unitId)).limit(1);
      if (dupe) throw new AppError('Kavling ini sudah punya SHM.', 409);
      const pinjamanId = await assertJaminan(tx, b.status, b.pinjamanBankId);
      const [d] = await tx.insert(dokumenLegalKavling).values({
        unitId: b.unitId, noShm: b.nomorShm, statusShm: b.status, statusShmKustom: kustom(b.status, b.statusKustom), lokasi: b.lokasi,
        pinjamanId, noPbg: b.noPbg, statusPbg: b.statusPbg, statusPbgKustom: kustom(b.statusPbg, b.statusPbgKustom),
      }).returning();
      await tx.insert(shmRiwayat).values({ dokumenId: d.id, tanggal: today(), keStatus: b.status, lokasi: b.lokasi, keterangan: 'SHM dicatat', oleh: actor.userId });
      await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'shm', entityId: d.id, summary: b.nomorShm });
      return d.id;
    });
    return reply.code(201).send({ success: true, message: 'SHM ditambahkan', data: await getOne(id) });
  });

  fastify.patch('/:id/status', {
    preHandler: [...guard, validate({
      params: idParams,
      body: z.object({
        keStatus: z.enum(STATUS_SHM),
        lokasi: z.string().trim().min(1, 'Lokasi wajib diisi').max(100),
        keterangan: optionalText(1000),
        pinjamanBankId: uuidSchema.optional().nullable(),
        statusKustom: optionalText(60),
      }),
    })],
    schema: { tags, description: 'Pindah status/lokasi SHM; riwayat dicatat' },
  }, async (request) => {
    const actor = actorOf(request);
    const b = request.body;
    await db.transaction(async (tx) => {
      const [d] = await tx.select().from(dokumenLegalKavling).where(eq(dokumenLegalKavling.id, request.params.id)).for('update').limit(1);
      if (!d) throw new AppError('SHM tidak ditemukan.', 404);
      const pinjamanId = await assertJaminan(tx, b.keStatus, b.pinjamanBankId);
      await tx.update(dokumenLegalKavling).set({
        statusShm: b.keStatus, statusShmKustom: kustom(b.keStatus, b.statusKustom), lokasi: b.lokasi, pinjamanId, updatedAt: new Date(),
      }).where(eq(dokumenLegalKavling.id, d.id));
      await tx.insert(shmRiwayat).values({
        dokumenId: d.id, tanggal: today(), dariStatus: d.statusShm, keStatus: b.keStatus, lokasi: b.lokasi,
        keterangan: b.keterangan, oleh: actor.userId,
      });
    });
    return { success: true, message: 'Status SHM diperbarui', data: await getOne(request.params.id) };
  });

  fastify.patch('/:id/pbg', {
    preHandler: [...guard, validate({
      params: idParams,
      body: z.object({ noPbg: optionalText(40), statusPbg: z.enum(STATUS_PBG), statusPbgKustom: optionalText(60) }),
    })],
    schema: { tags, description: 'Ubah nomor dan status PBG' },
  }, async (request) => {
    const actor = actorOf(request);
    const b = request.body;
    await db.transaction(async (tx) => {
      const [d] = await tx.select().from(dokumenLegalKavling).where(eq(dokumenLegalKavling.id, request.params.id)).limit(1);
      if (!d) throw new AppError('SHM tidak ditemukan.', 404);
      await tx.update(dokumenLegalKavling).set({
        noPbg: b.noPbg, statusPbg: b.statusPbg, statusPbgKustom: kustom(b.statusPbg, b.statusPbgKustom), updatedAt: new Date(),
      }).where(eq(dokumenLegalKavling.id, d.id));
      await recordAuditTx(tx, { ...actor, action: AuditAction.UPDATE, entity: 'shm', entityId: d.id, summary: `PBG ${b.statusPbg}` });
    });
    return { success: true, message: 'PBG diperbarui', data: await getOne(request.params.id) };
  });

  fastify.delete('/:id', {
    preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Hapus SHM beserta riwayatnya' },
  }, async (request) => {
    const actor = actorOf(request);
    await db.transaction(async (tx) => {
      const [d] = await tx.select().from(dokumenLegalKavling).where(eq(dokumenLegalKavling.id, request.params.id)).limit(1);
      if (!d) throw new AppError('SHM tidak ditemukan.', 404);
      if (d.statusShm === 'dijaminkan') throw new AppError('SHM masih dijaminkan ke bank, tidak bisa dihapus.', 409);
      await tx.delete(dokumenLegalKavling).where(eq(dokumenLegalKavling.id, d.id));
      await recordAuditTx(tx, { ...actor, action: AuditAction.DELETE, entity: 'shm', entityId: d.id, summary: d.noShm });
    });
    return { success: true, message: 'SHM dihapus' };
  });
}

