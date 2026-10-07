// src/modules/hutang/hutang.routes.js
//
// Mutasi hutang per kode pembantu (FE: hutangStore). Mutasi tidak punya tabel
// sendiri: setiap mutasi adalah jurnal dua baris (akun hutang kategori itu +
// akun lawan). Hutang antar proyek dicatat sebagai pasangan jurnal mirror:
// hutang di proyek peminjam, piutang di proyek pemberi.
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../config/database.js';
import { jurnal, jurnalDetail, akun, kodePembantu, saldoAwal, saldoAwalPeriode } from '../../shared/schemas/akuntansi.schema.js';
import { validate } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { uuidSchema, isoDate, bulanSchema, nominal } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { toNumber } from '../../shared/utils/money.js';
import { buatJurnalOtomatis, setMirrorTx, hapusJurnalModulTx, ringkasJurnal } from '../jurnal/jurnal.service.js';
import { saldoKodePembantu } from '../laporan/laporan.service.js';
import { jatuhTempo } from '../pinjaman/pinjaman.service.js';
import * as h from './hutang.helpers.js';

const tags = ['Hutang'];

// Kategori yang tampil di halaman Hutang (FE: KategoriHutang). Kontraktor
// punya tab sendiri lewat modul kontrak.
export const KATEGORI_HUTANG = ['lahan', 'ppn', 'pihak_ketiga', 'pemegang_saham', 'karyawan', 'antar_proyek', 'bank'];

const bulanIni = () => new Date().toISOString().slice(0, 7);

/** Satu baris mutasi berbentuk MutasiHutang di FE, dari baris jurnal kode pembantu itu. */
function toMutasiDto(r, lawanByJurnal, info) {
  const debit = toNumber(r.debit);
  return {
    id: r.jurnalId,
    proyekId: r.proyekId,
    kodePembantuId: r.kodePembantuId,
    kategori: r.kategori,
    tanggal: r.tanggal,
    uraian: r.uraian,
    jenisMutasi: debit > 0 ? 'debit' : 'kredit',
    nominal: debit > 0 ? debit : toNumber(r.kredit),
    akunCoaId: lawanByJurnal.get(r.jurnalId) ?? null,
    referensi: r.noReferensi,
    proyekLawanId: r.proyekLawanId,
    mirrorMutasiId: r.mirrorId,
    sumber: r.sumber,
    ...h.jurnalInfo(info, r.jurnalId),
    createdAt: r.createdAt,
  };
}

async function listMutasi({ kodePembantuId, kategori, proyekId, jurnalIds: onlyIds }) {
  // Semua status ikut, termasuk jurnal balik: jumlah baris terbuku harus sama
  // dengan saldo. Baris draft ditandai jurnalStatus dan belum masuk saldo.
  const filters = [isNotNull(jurnalDetail.kodePembantuId)];
  if (onlyIds) filters.push(inArray(jurnal.id, onlyIds));
  if (kodePembantuId) filters.push(eq(jurnalDetail.kodePembantuId, kodePembantuId));
  if (kategori) filters.push(eq(kodePembantu.kategori, kategori));
  if (proyekId) filters.push(eq(jurnal.proyekId, proyekId));

  const rows = await db
    .select({
      jurnalId: jurnal.id, proyekId: jurnal.proyekId, tanggal: jurnal.tanggal, uraian: jurnal.uraian, noReferensi: jurnal.noReferensi,
      mirrorId: jurnal.mirrorId, sumber: jurnal.sumber, createdAt: jurnal.createdAt,
      kodePembantuId: jurnalDetail.kodePembantuId, debit: jurnalDetail.debit, kredit: jurnalDetail.kredit,
      kategori: kodePembantu.kategori, proyekLawanId: kodePembantu.proyekLawanId,
    })
    .from(jurnalDetail)
    .innerJoin(jurnal, eq(jurnal.id, jurnalDetail.jurnalId))
    .innerJoin(kodePembantu, eq(kodePembantu.id, jurnalDetail.kodePembantuId))
    .innerJoin(akun, eq(akun.id, jurnalDetail.akunId))
    .where(and(...filters, isNotNull(akun.kategoriHpId)))
    .orderBy(desc(jurnal.tanggal), desc(jurnal.createdAt));

  const jurnalIds = [...new Set(rows.map((r) => r.jurnalId))];
  // Akun lawan = baris lain di jurnal yang sama (tanpa kode pembantu ini)
  const lawan = jurnalIds.length
    ? await db.select({ jurnalId: jurnalDetail.jurnalId, akunId: jurnalDetail.akunId, kp: jurnalDetail.kodePembantuId })
      .from(jurnalDetail).where(inArray(jurnalDetail.jurnalId, jurnalIds)).orderBy(jurnalDetail.urutan)
    : [];
  const lawanByJurnal = new Map();
  for (const l of lawan) {
    if (!l.kp && !lawanByJurnal.has(l.jurnalId)) lawanByJurnal.set(l.jurnalId, l.akunId);
  }
  const info = await ringkasJurnal(jurnalIds);
  return rows.map((r) => toMutasiDto(r, lawanByJurnal, info));
}

/** Saldo awal kode pembantu (dari set saldo awal proyek) sebagai mutasi pertama. */
async function saldoAwalMutasi(kodePembantuId) {
  const rows = await db
    .select({ id: saldoAwal.id, debit: saldoAwal.debit, kredit: saldoAwal.kredit, akunId: saldoAwal.akunId,
      proyekId: saldoAwalPeriode.proyekId, tanggal: saldoAwalPeriode.tanggalMulai, kategori: kodePembantu.kategori })
    .from(saldoAwal)
    .innerJoin(saldoAwalPeriode, eq(saldoAwalPeriode.id, saldoAwal.periodeId))
    .innerJoin(kodePembantu, eq(kodePembantu.id, saldoAwal.kodePembantuId))
    .where(eq(saldoAwal.kodePembantuId, kodePembantuId));
  return rows.map((r) => {
    const debit = toNumber(r.debit);
    return {
      id: `saldo-awal-${r.id}`, proyekId: r.proyekId, kodePembantuId, kategori: r.kategori, tanggal: r.tanggal,
      uraian: 'Saldo awal', jenisMutasi: debit > 0 ? 'debit' : 'kredit', nominal: debit > 0 ? debit : toNumber(r.kredit),
      akunCoaId: r.akunId, referensi: null, proyekLawanId: null, mirrorMutasiId: null, sumber: 'saldo_awal',
      jurnalId: null, nomorJurnal: null, jurnalStatus: 'diposting', butuhLampiran: false, createdAt: null,
    };
  });
}

const mutasiBody = z.object({
  proyekId: uuidSchema,
  kategori: z.enum(KATEGORI_HUTANG),
  kodePembantuId: uuidSchema.optional().nullable(),
  kodePembantuBaru: z.string().trim().max(150).optional().nullable(),
  tanggal: isoDate,
  uraian: z.string().trim().min(1, 'Uraian wajib diisi').max(1000),
  // debit = mengurangi hutang, kredit = menambah hutang
  jenisMutasi: z.enum(['debit', 'kredit']),
  nominal: nominal.refine((v) => v > 0, 'Nominal harus lebih dari 0'),
  akunCoaId: uuidSchema,
  referensi: z.string().trim().max(60).optional().nullable(),
  proyekLawanId: uuidSchema.optional().nullable(),
  // Akun lawan di proyek pemberi (antar proyek). Default = akunCoaId.
  akunLawanPemberiId: uuidSchema.optional().nullable(),
});

const barisHutang = (akunId, kpId, jenis, nilai) => (jenis === 'kredit'
  ? { akunId, kodePembantuId: kpId, debit: 0, kredit: nilai }
  : { akunId, kodePembantuId: kpId, debit: nilai, kredit: 0 });
const barisLawan = (akunId, jenis, nilai) => (jenis === 'kredit'
  ? { akunId, debit: nilai, kredit: 0 }
  : { akunId, debit: 0, kredit: nilai });

async function catatMutasi(tx, actor, b) {
  await h.findProyekAktif(tx, b.proyekId);
  const lawan = await h.findAkunAktif(tx, b.akunCoaId, 'Akun lawan');
  if (lawan.kategoriHpId) throw new AppError('Akun lawan tidak boleh akun hutang/piutang. Pilih akun kas, persediaan, atau beban.', 422);

  if (b.kategori !== 'antar_proyek') {
    const kp = await h.resolveKodePembantu(tx, {
      id: b.kodePembantuId, namaBaru: b.kodePembantuBaru, kategori: b.kategori, proyekId: b.proyekId,
    });
    const akunHutang = await h.akunUntukKategori(tx, b.kategori, 'hutang');
    return [await buatJurnalOtomatis(tx, actor, {
      tanggal: b.tanggal, uraian: b.uraian, proyekId: b.proyekId, sumber: 'manual', refType: 'mutasi_hutang',
      noReferensi: b.referensi, rows: [barisHutang(akunHutang.id, kp.id, b.jenisMutasi, b.nominal), barisLawan(lawan.id, b.jenisMutasi, b.nominal)],
    })];
  }

  // Antar proyek: proyekId = peminjam, proyekLawanId = pemberi
  if (!b.proyekLawanId) throw new AppError('Pilih proyek pemberi pinjaman.', 422);
  if (b.proyekLawanId === b.proyekId) throw new AppError('Proyek pemberi harus berbeda dari proyek peminjam.', 422);
  const kpPeminjam = await h.kodePembantuAntarProyek(tx, b.proyekId, b.proyekLawanId);
  const kpPemberi = await h.kodePembantuAntarProyek(tx, b.proyekLawanId, b.proyekId);
  const akunHutang = await h.akunUntukKategori(tx, 'antar_proyek', 'hutang');
  const akunPiutang = await h.akunUntukKategori(tx, 'antar_proyek', 'aktiva');
  const lawanPemberi = b.akunLawanPemberiId ? await h.findAkunAktif(tx, b.akunLawanPemberiId, 'Akun lawan pemberi') : lawan;

  // Kredit hutang di peminjam = debit piutang di pemberi, dan sebaliknya
  const sisiPiutang = b.jenisMutasi === 'kredit' ? 'debit' : 'kredit';
  const peminjam = await buatJurnalOtomatis(tx, actor, {
    tanggal: b.tanggal, uraian: b.uraian, proyekId: b.proyekId, sumber: 'mirror', refType: 'mutasi_hutang', noReferensi: b.referensi,
    rows: [barisHutang(akunHutang.id, kpPeminjam.id, b.jenisMutasi, b.nominal), barisLawan(lawan.id, b.jenisMutasi, b.nominal)],
  });
  const pemberi = await buatJurnalOtomatis(tx, actor, {
    tanggal: b.tanggal, uraian: `[Mirror] ${b.uraian}`, proyekId: b.proyekLawanId, sumber: 'mirror', refType: 'mutasi_hutang',
    noReferensi: b.referensi,
    rows: [
      sisiPiutang === 'debit'
        ? { akunId: akunPiutang.id, kodePembantuId: kpPemberi.id, debit: b.nominal, kredit: 0 }
        : { akunId: akunPiutang.id, kodePembantuId: kpPemberi.id, debit: 0, kredit: b.nominal },
      sisiPiutang === 'debit'
        ? { akunId: lawanPemberi.id, debit: 0, kredit: b.nominal }
        : { akunId: lawanPemberi.id, debit: b.nominal, kredit: 0 },
    ],
  });
  if (peminjam.status !== pemberi.status) {
    // Satu sisi kas/bank, sisi lain tidak: keduanya harus menunggu bukti bersama
    throw new AppError('Akun lawan kedua proyek harus sama-sama kas/bank atau sama-sama bukan kas/bank.', 422);
  }
  await setMirrorTx(tx, peminjam.id, pemberi.id);
  return [peminjam, pemberi];
}

export default async function hutangRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/ringkasan', {
    preHandler: [...guard, validate({ query: z.object({ bulan: bulanSchema.optional(), proyekId: uuidSchema.optional() }) })],
    schema: { tags, description: 'Kartu ringkasan halaman Hutang: total, per kategori, jatuh tempo pinjaman 14 hari' },
  }, async (request) => {
    const bulan = request.query.bulan ?? bulanIni();
    const saldo = await saldoKodePembantu({ bulan, proyekId: request.query.proyekId, kategori: KATEGORI_HUTANG, akunKategori: 'hutang' });
    const perKategori = Object.fromEntries(KATEGORI_HUTANG.map((k) => [k, 0]));
    let total = 0;
    for (const s of saldo) {
      perKategori[s.kodePembantu.kategori] = Math.round((perKategori[s.kodePembantu.kategori] + s.saldoAkhir) * 100) / 100;
      total += s.saldoAkhir;
    }
    const reminders = await jatuhTempo({ hari: 14 });
    return {
      success: true, message: 'Success',
      data: { bulan, totalHutang: Math.round(total * 100) / 100, perKategori, jatuhTempoDekat: reminders.length },
    };
  });

  fastify.get('/saldo', {
    preHandler: [...guard, validate({
      query: z.object({ bulan: bulanSchema.optional(), proyekId: uuidSchema.optional(), kategori: z.enum(KATEGORI_HUTANG).optional() }),
    })],
    schema: { tags, description: 'Saldo hutang per kode pembantu untuk satu bulan (FE: getSaldoPerKodePembantu)' },
  }, async (request) => {
    const { bulan = bulanIni(), proyekId, kategori } = request.query;
    const data = await saldoKodePembantu({ bulan, proyekId, kategori: kategori ? [kategori] : KATEGORI_HUTANG, akunKategori: 'hutang' });
    return { success: true, message: 'Success', data, meta: { bulan } };
  });

  fastify.get('/mutasi', {
    preHandler: [...guard, validate({
      query: z.object({ kodePembantuId: uuidSchema.optional(), kategori: z.enum(KATEGORI_HUTANG).optional(), proyekId: uuidSchema.optional() }),
    })],
    schema: { tags, description: 'Mutasi hutang (terbaru dulu). Dengan kodePembantuId, saldo awal ikut sebagai baris pertama.' },
  }, async (request) => {
    const items = await listMutasi(request.query);
    const awal = request.query.kodePembantuId ? await saldoAwalMutasi(request.query.kodePembantuId) : [];
    return { success: true, message: 'Success', data: [...items, ...awal] };
  });

  fastify.get('/antar-proyek', {
    preHandler: [...guard, validate({ query: z.object({ proyekId: uuidSchema.optional() }) })],
    schema: { tags, description: 'Mutasi antar proyek, kedua sisi (FE: getMutasiAntarProyek)' },
  }, async (request) => ({
    success: true, message: 'Success', data: await listMutasi({ kategori: 'antar_proyek', proyekId: request.query.proyekId }),
  }));

  fastify.post('/mutasi', {
    preHandler: [...guard, validate({ body: mutasiBody })],
    schema: {
      tags,
      description: 'Catat mutasi hutang. Jurnal langsung diposting, kecuali akun lawan kas/bank: jurnal draft ' +
        '(butuhLampiran = true) sampai bukti diunggah lalu POST /jurnal/:jurnalId/posting.',
    },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const created = await db.transaction((tx) => catatMutasi(tx, actor, request.body));
    const items = await listMutasi({ jurnalIds: created.map((c) => c.id) });
    const data = items.filter((m) => m.proyekId === request.body.proyekId);
    return reply.code(201).send({ success: true, message: 'Mutasi dicatat', data: data[0] ?? null });
  });

  fastify.delete('/mutasi/:id', {
    preHandler: [...guard, validate({ params: z.object({ id: uuidSchema }) })],
    schema: { tags, description: 'Hapus mutasi (jurnalnya, termasuk pasangan mirror) selama draft atau periode terbuka' },
  }, async (request) => {
    const actor = actorOf(request);
    await db.transaction(async (tx) => {
      const [j] = await tx.select().from(jurnal).where(eq(jurnal.id, request.params.id)).limit(1);
      if (!j || j.refType !== 'mutasi_hutang') throw new AppError('Mutasi tidak ditemukan.', 404);
      await hapusJurnalModulTx(tx, actor, j.id);
    });
    return { success: true, message: 'Mutasi dihapus' };
  });
}

