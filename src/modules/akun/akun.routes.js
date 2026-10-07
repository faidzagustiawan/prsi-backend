// src/modules/akun/akun.routes.js
//
// Bagan akun (COA). Bentuk data mengikuti Akun dan RiwayatAkun di frontend
// (src/store/coaStore.ts). Riwayat diambil dari audit_logs per kolom.
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../config/database.js';
import { akun, jurnalDetail, saldoAwal } from '../../shared/schemas/akuntansi.schema.js';
import { auditLogs, users } from '../../shared/schemas/finance.schema.js';
import { validate, validatePatch } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { idParams, uuidSchema, optionalText } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordFieldChanges, recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { KATEGORI_AKUN, KLASIFIKASI_AKUN, TIPE_SALDO } from '../../shared/constants.js';
import { kategoriById, findKategoriByKode } from '../kategori-hp/kategori-hp.routes.js';

const tags = ['Akun (COA)'];

// kategoriMap: id -> kategori_hutang_piutang (lihat kategoriById)
export const toAkunDto = (r, kategoriMap) => ({
  id: r.id,
  kodeAkun: r.kode,
  namaAkun: r.nama,
  kategori: r.kategori,
  tipeSaldo: r.tipeSaldo,
  klasifikasi: r.klasifikasi,
  status: r.aktif ? 'aktif' : 'nonaktif',
  akunIndukId: r.indukId ?? undefined,
  wajibKodePembantu: r.wajibKodePembantu,
  wajibProyek: r.wajibProyek,
  isKasBank: r.isKasBank,
  noRekening: r.noRekening ?? undefined,
  kategoriHpId: r.kategoriHpId ?? undefined,
  kategoriHutangPiutang: kategoriMap.get(r.kategoriHpId)?.kode,
  kategoriHutangPiutangNama: kategoriMap.get(r.kategoriHpId)?.nama,
});

const fields = {
  kodeAkun: z.string().trim().regex(/^\d{3,10}$/, 'Kode akun 3-10 digit angka'),
  namaAkun: z.string().trim().min(1, 'Nama akun wajib diisi').max(150),
  kategori: z.enum(KATEGORI_AKUN),
  tipeSaldo: z.enum(TIPE_SALDO),
  klasifikasi: z.enum(KLASIFIKASI_AKUN),
  status: z.enum(['aktif', 'nonaktif']).default('aktif'),
  akunIndukId: uuidSchema.optional().nullable().or(z.literal('')),
  wajibKodePembantu: z.boolean().default(false),
  wajibProyek: z.boolean().default(false),
  isKasBank: z.boolean().default(false),
  noRekening: optionalText(30),
  // Salah satu: kategoriHpId (id) atau kategoriHutangPiutang (kode kategori). Kosong = bukan akun hutang/piutang.
  kategoriHpId: uuidSchema.optional().nullable().or(z.literal('')),
  kategoriHutangPiutang: z.string().trim().max(20).optional().nullable(),
};

const toColumns = (b) => {
  const map = {
    kodeAkun: 'kode', namaAkun: 'nama', kategori: 'kategori', tipeSaldo: 'tipeSaldo', klasifikasi: 'klasifikasi',
    wajibKodePembantu: 'wajibKodePembantu', wajibProyek: 'wajibProyek', isKasBank: 'isKasBank', noRekening: 'noRekening',
  };
  const out = {};
  for (const [from, to] of Object.entries(map)) if (from in b) out[to] = b[from];
  if ('status' in b) out.aktif = b.status === 'aktif';
  if ('akunIndukId' in b) out.indukId = b.akunIndukId || null;
  if ('kategoriHpId' in b) out.kategoriHpId = b.kategoriHpId || null;
  return out;
};

/** Ubah kategoriHutangPiutang (kode) menjadi kategoriHpId; kategori harus ada dan aktif. */
async function resolveKategori(tx, values, body) {
  if (body.kategoriHutangPiutang !== undefined && !('kategoriHpId' in body)) {
    values.kategoriHpId = body.kategoriHutangPiutang ? (await findKategoriByKode(tx, body.kategoriHutangPiutang)).id : null;
  }
  if (values.kategoriHpId) {
    const kategori = (await kategoriById(tx)).get(values.kategoriHpId);
    if (!kategori) throw new AppError('Kategori hutang/piutang tidak ditemukan.', 400);
    if (!kategori.aktif) throw new AppError(`Kategori hutang/piutang "${kategori.kode}" nonaktif.`, 400);
  }
  return values;
}

const yaTidak = (v) => (v ? 'Ya' : 'Tidak');
const LABELS = {
  kode: 'Kode akun', nama: 'Nama akun', kategori: 'Kategori', tipeSaldo: 'Tipe saldo', klasifikasi: 'Klasifikasi',
  aktif: 'Status', indukId: 'Akun induk', wajibKodePembantu: 'Wajib kode pembantu', wajibProyek: 'Wajib proyek',
  isKasBank: 'Akun kas/bank', noRekening: 'No. rekening', kategoriHpId: 'Kategori hutang/piutang',
};
const FORMAT = {
  aktif: (v) => (v ? 'Aktif' : 'Nonaktif'),
  wajibKodePembantu: yaTidak, wajibProyek: yaTidak, isKasBank: yaTidak,
};

async function findAkun(tx, id) {
  const [row] = await tx.select().from(akun).where(eq(akun.id, id)).limit(1);
  if (!row) throw new AppError('Akun tidak ditemukan.', 404);
  return row;
}

/** Akun induk harus ada, bukan dirinya sendiri, dan tidak membentuk siklus. */
async function assertInduk(tx, indukId, selfId) {
  if (!indukId) return;
  if (indukId === selfId) throw new AppError('Akun tidak bisa menjadi induk dirinya sendiri.', 400);
  const rows = await tx.execute(sql`
    WITH RECURSIVE naik AS (
      SELECT id, induk_id FROM finance.akun WHERE id = ${indukId}
      UNION ALL
      SELECT a.id, a.induk_id FROM finance.akun a JOIN naik ON a.id = naik.induk_id
    )
    SELECT id FROM naik
  `);
  if (!rows.length) throw new AppError('Akun induk tidak ditemukan.', 400);
  if (selfId && rows.some((r) => r.id === selfId)) throw new AppError('Akun induk membentuk siklus.', 400);
  // Akun yang sudah dipakai jurnal tidak boleh dijadikan induk
  const [dipakai] = await tx.select({ id: jurnalDetail.id }).from(jurnalDetail).where(eq(jurnalDetail.akunId, indukId)).limit(1);
  if (dipakai) throw new AppError('Akun induk sudah dipakai jurnal; pilih akun lain sebagai induk.', 409);
}

export default async function akunRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate({ query: z.object({ status: z.enum(['aktif', 'nonaktif']).optional(), kategori: z.enum(KATEGORI_AKUN).optional() }) })],
    schema: { tags, description: 'Daftar akun, urut kode' },
  }, async (request) => {
    const { status, kategori } = request.query;
    const filters = [];
    if (status) filters.push(eq(akun.aktif, status === 'aktif'));
    if (kategori) filters.push(eq(akun.kategori, kategori));
    const rows = await db.select().from(akun).where(filters.length ? and(...filters) : undefined).orderBy(asc(akun.kode));
    const kategoriMap = await kategoriById(db);
    return { success: true, message: 'Success', data: rows.map((r) => toAkunDto(r, kategoriMap)) };
  });

  fastify.get('/:id', {
    preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Detail akun' },
  }, async (request) => ({
    success: true, message: 'Success', data: toAkunDto(await findAkun(db, request.params.id), await kategoriById(db)),
  }));

  fastify.get('/:id/riwayat', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Riwayat perubahan akun, terbaru dulu' },
  }, async (request) => {
    const rows = await db
      .select({
        id: auditLogs.id, waktu: auditLogs.createdAt, action: auditLogs.action, field: auditLogs.field,
        nilaiLama: auditLogs.nilaiLama, nilaiBaru: auditLogs.nilaiBaru, oleh: users.nama,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(and(eq(auditLogs.entity, 'akun'), eq(auditLogs.entityId, request.params.id)))
      .orderBy(desc(auditLogs.createdAt));
    return {
      success: true,
      message: 'Success',
      data: rows.map((r) => ({
        id: r.id,
        akunId: request.params.id,
        waktu: r.waktu,
        field: r.field ?? (r.action === AuditAction.CREATE ? 'Akun dibuat' : r.action),
        nilaiLama: r.nilaiLama ?? '-',
        nilaiBaru: r.nilaiBaru ?? '-',
        oleh: r.oleh ?? 'Sistem',
      })),
    };
  });

  fastify.post('/', {
    preHandler: [...guard, validate({ body: z.object(fields) })], schema: { tags, description: 'Tambah akun' },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      const values = await resolveKategori(tx, toColumns(request.body), request.body);
      await assertInduk(tx, values.indukId);
      const [created] = await tx.insert(akun).values(values).returning();
      await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'akun', entityId: created.id, summary: `${created.kode} ${created.nama}` });
      return created;
    });
    return reply.code(201).send({ success: true, message: 'Akun ditambahkan', data: toAkunDto(row, await kategoriById(db)) });
  });

  fastify.patch('/:id', {
    preHandler: [...guard, validatePatch({ params: idParams, body: z.object(fields).partial() })],
    schema: { tags, description: 'Ubah akun. Kode, kategori, dan tipe saldo terkunci setelah akun dipakai jurnal.' },
  }, async (request) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      const before = await findAkun(tx, request.params.id);
      const values = await resolveKategori(tx, toColumns(request.body), request.body);
      if ('indukId' in values && values.indukId !== before.indukId) await assertInduk(tx, values.indukId, before.id);

      const struktural = ['kode', 'kategori', 'tipeSaldo', 'klasifikasi'].filter((k) => k in values && values[k] !== before[k]);
      if (struktural.length) {
        const [dipakai] = await tx.select({ id: jurnalDetail.id }).from(jurnalDetail).where(eq(jurnalDetail.akunId, before.id)).limit(1);
        if (dipakai) throw new AppError('Akun sudah dipakai jurnal: kode, kategori, tipe saldo, dan klasifikasi tidak bisa diubah.', 409);
      }

      const [updated] = await tx.update(akun).set({ ...values, updatedAt: new Date() }).where(eq(akun.id, before.id)).returning();
      const kategoriMap = await kategoriById(tx);
      await recordFieldChanges(tx, {
        ...actor, entity: 'akun', entityId: before.id, before, after: values, labels: LABELS,
        format: { ...FORMAT, kategoriHpId: (v) => kategoriMap.get(v)?.nama ?? '-' },
      });
      return updated;
    });
    return { success: true, message: 'Akun diperbarui', data: toAkunDto(row, await kategoriById(db)) };
  });

  fastify.delete('/:id', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Hapus akun yang belum dipakai. Akun yang sudah dipakai cukup dinonaktifkan.' },
  }, async (request) => {
    const actor = actorOf(request);
    await db.transaction(async (tx) => {
      const before = await findAkun(tx, request.params.id);
      const [anak] = await tx.select({ id: akun.id }).from(akun).where(eq(akun.indukId, before.id)).limit(1);
      const [jd] = await tx.select({ id: jurnalDetail.id }).from(jurnalDetail).where(eq(jurnalDetail.akunId, before.id)).limit(1);
      const [sa] = await tx.select({ id: saldoAwal.id }).from(saldoAwal).where(eq(saldoAwal.akunId, before.id)).limit(1);
      if (anak) throw new AppError('Akun masih punya sub-akun.', 409);
      if (jd || sa) throw new AppError('Akun sudah dipakai jurnal atau saldo awal. Nonaktifkan saja.', 409);
      await tx.delete(akun).where(eq(akun.id, before.id));
      await recordAuditTx(tx, { ...actor, action: AuditAction.DELETE, entity: 'akun', entityId: before.id, summary: `${before.kode} ${before.nama}` });
    });
    return { success: true, message: 'Akun dihapus' };
  });
}
