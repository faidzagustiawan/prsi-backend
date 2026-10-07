// src/modules/kategori-hp/kategori-hp.routes.js
//
// Kategori hutang/piutang (ERD: kategori_hutang_piutang). Dirujuk akun lewat
// kategori_hp_id dan kode pembantu lewat kode, jadi kategori baru cukup
// ditambah di sini tanpa ubah kode aplikasi.
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../config/database.js';
import { akun, kategoriHutangPiutang, kodePembantu } from '../../shared/schemas/akuntansi.schema.js';
import { validate, validatePatch } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { idParams } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordFieldChanges, recordAuditTx, AuditAction } from '../../shared/utils/audit.js';

const tags = ['Kategori Hutang/Piutang'];

export const toKategoriDto = (r) => ({
  id: r.id,
  kode: r.kode,
  nama: r.nama,
  prefixKodePembantu: r.prefixKodePembantu,
  aktif: r.aktif,
});

/** Peta id -> baris kategori. Tabelnya kecil, jadi dibaca utuh. */
export async function kategoriById(tx) {
  const rows = await tx.select().from(kategoriHutangPiutang);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Kategori berdasarkan kode; `aktifSaja` menolak kategori nonaktif. */
export async function findKategoriByKode(tx, kode, { aktifSaja = true } = {}) {
  const [row] = await tx.select().from(kategoriHutangPiutang).where(eq(kategoriHutangPiutang.kode, kode)).limit(1);
  if (!row) throw new AppError(`Kategori hutang/piutang "${kode}" tidak ditemukan.`, 400);
  if (aktifSaja && !row.aktif) throw new AppError(`Kategori hutang/piutang "${kode}" nonaktif.`, 400);
  return row;
}

async function findKategori(tx, id) {
  const [row] = await tx.select().from(kategoriHutangPiutang).where(eq(kategoriHutangPiutang.id, id)).limit(1);
  if (!row) throw new AppError('Kategori hutang/piutang tidak ditemukan.', 404);
  return row;
}

const fields = {
  kode: z.string().trim().regex(/^[a-z][a-z0-9_]{1,19}$/, 'Kode 2-20 karakter: huruf kecil, angka, garis bawah'),
  nama: z.string().trim().min(1, 'Nama wajib diisi').max(100),
  prefixKodePembantu: z.string().trim().toUpperCase().regex(/^[A-Z]{2,4}$/, 'Prefix 2-4 huruf'),
  aktif: z.boolean().default(true),
};

const LABELS = { nama: 'Nama', prefixKodePembantu: 'Prefix kode pembantu', aktif: 'Status' };
const FORMAT = { aktif: (v) => (v ? 'Aktif' : 'Nonaktif') };


export default async function kategoriHpRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate({ query: z.object({ aktif: z.enum(['true', 'false']).optional() }) })],
    schema: { tags, description: 'Daftar kategori hutang/piutang, urut nama' },
  }, async (request) => {
    const { aktif } = request.query;
    const rows = await db.select().from(kategoriHutangPiutang)
      .where(aktif ? eq(kategoriHutangPiutang.aktif, aktif === 'true') : undefined)
      .orderBy(asc(kategoriHutangPiutang.nama));
    return { success: true, message: 'Success', data: rows.map(toKategoriDto) };
  });

  fastify.post('/', {
    preHandler: [...guard, validate({ body: z.object(fields) })],
    schema: { tags, description: 'Tambah kategori. Kode dan prefix unik, tidak bisa diubah setelah dibuat.' },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(kategoriHutangPiutang).values(request.body).returning();
      await recordAuditTx(tx, {
        ...actor, action: AuditAction.CREATE, entity: 'kategori_hutang_piutang', entityId: created.id, summary: `${created.kode} ${created.nama}`,
      });
      return created;
    }).catch((err) => {
      if (err.code === '23505' || err.cause?.code === '23505') throw new AppError('Kode atau prefix kode pembantu sudah dipakai kategori lain.', 400);
      throw err;
    });
    return reply.code(201).send({ success: true, message: 'Kategori ditambahkan', data: toKategoriDto(row) });
  });

  fastify.patch('/:id', {
    preHandler: [...guard, validatePatch({ params: idParams, body: z.object({ nama: fields.nama, aktif: z.boolean() }).partial() })],
    schema: { tags, description: 'Ubah nama atau status aktif. Kode dan prefix terkunci karena dipakai aturan dan nomor kode pembantu.' },
  }, async (request) => {
    const actor = actorOf(request);
    const row = await db.transaction(async (tx) => {
      const before = await findKategori(tx, request.params.id);
      const [updated] = await tx.update(kategoriHutangPiutang).set({ ...request.body, updatedAt: new Date() })
        .where(eq(kategoriHutangPiutang.id, before.id)).returning();
      await recordFieldChanges(tx, {
        ...actor, entity: 'kategori_hutang_piutang', entityId: before.id, before, after: request.body, labels: LABELS, format: FORMAT,
      });
      return updated;
    });
    return { success: true, message: 'Kategori diperbarui', data: toKategoriDto(row) };
  });

  fastify.delete('/:id', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Hapus kategori yang belum dipakai akun atau kode pembantu; yang sudah dipakai cukup dinonaktifkan' },
  }, async (request) => {
    const actor = actorOf(request);
    await db.transaction(async (tx) => {
      const before = await findKategori(tx, request.params.id);
      const [a] = await tx.select({ id: akun.id }).from(akun).where(eq(akun.kategoriHpId, before.id)).limit(1);
      const [kp] = await tx.select({ id: kodePembantu.id }).from(kodePembantu).where(eq(kodePembantu.kategori, before.kode)).limit(1);
      if (a || kp) throw new AppError('Kategori sudah dipakai akun atau kode pembantu. Nonaktifkan saja.', 409);
      await tx.delete(kategoriHutangPiutang).where(eq(kategoriHutangPiutang.id, before.id));
      await recordAuditTx(tx, {
        ...actor, action: AuditAction.DELETE, entity: 'kategori_hutang_piutang', entityId: before.id, summary: `${before.kode} ${before.nama}`,
      });
    });
    return { success: true, message: 'Kategori dihapus' };
  });
}
