// src/modules/laporan/laporan.routes.js
//
// Semua saldo dihitung dari saldo_awal + jurnal_detail yang terbuku. Tidak ada
// tabel saldo, jadi angka di sini selalu sama dengan isi jurnal.
// Tanda saldo mengikuti saldo normal akun: akun bersaldo normal kredit
// (hutang, modal, pendapatan) positif bila kredit > debit.
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { reportDb } from '../../config/database.js';
import { validate } from '../../middleware/validate.js';
import { keuanganOnly } from '../../middleware/authorize.js';
import { uuidSchema, isoDate, bulanSchema } from '../../shared/utils/zod.js';
import { KATEGORI_KODE_PEMBANTU } from '../../shared/constants.js';
import { STATUS_TERBUKU } from '../jurnal/jurnal.repository.js';
import { saldoKodePembantu } from './laporan.service.js';

const tags = ['Laporan'];
const terbuku = sql.raw(STATUS_TERBUKU.map((s) => `'${s}'`).join(', '));
const today = () => new Date().toISOString().slice(0, 10);
const n = (v) => Number(v ?? 0);

// Saldo bertanda menurut saldo normal akun (alias tabel akun: a)
const signed = (d, k) => sql`CASE WHEN a.tipe_saldo = 'k' THEN ${k} - ${d} ELSE ${d} - ${k} END`;

export default async function laporanRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/saldo-akun', {
    preHandler: [...guard, validate({ query: z.object({ proyekId: uuidSchema.optional(), sampai: isoDate.optional() }) })],
    schema: { tags, description: 'Neraca saldo: saldo per akun sampai tanggal tertentu (default hari ini)' },
  }, async (request) => {
    const { proyekId, sampai = today() } = request.query;
    const proyekSa = proyekId ? sql`AND p.proyek_id = ${proyekId}` : sql``;
    const proyekJ = proyekId ? sql`AND j.proyek_id = ${proyekId}` : sql``;
    const rows = await reportDb.execute(sql`
      WITH sa AS (
        SELECT s.akun_id, SUM(s.debit) d, SUM(s.kredit) k
        FROM finance.saldo_awal s JOIN finance.saldo_awal_periode p ON p.id = s.periode_id
        WHERE TRUE ${proyekSa}
        GROUP BY s.akun_id
      ), mut AS (
        SELECT jd.akun_id, SUM(jd.debit) d, SUM(jd.kredit) k
        FROM finance.jurnal_detail jd JOIN finance.jurnal j ON j.id = jd.jurnal_id
        WHERE j.status IN (${terbuku}) AND j.tanggal <= ${sampai} ${proyekJ}
        GROUP BY jd.akun_id
      )
      SELECT a.id, a.kode, a.nama, a.kategori, a.tipe_saldo,
             COALESCE(sa.d, 0) sa_d, COALESCE(sa.k, 0) sa_k, COALESCE(mut.d, 0) mut_d, COALESCE(mut.k, 0) mut_k,
             ${signed(sql`(COALESCE(sa.d, 0) + COALESCE(mut.d, 0))`, sql`(COALESCE(sa.k, 0) + COALESCE(mut.k, 0))`)} saldo
      FROM finance.akun a
      LEFT JOIN sa ON sa.akun_id = a.id
      LEFT JOIN mut ON mut.akun_id = a.id
      WHERE sa.akun_id IS NOT NULL OR mut.akun_id IS NOT NULL
      ORDER BY a.kode
    `);
    return {
      success: true,
      message: 'Success',
      data: rows.map((r) => ({
        akunId: r.id, kodeAkun: r.kode, namaAkun: r.nama, kategori: r.kategori, tipeSaldo: r.tipe_saldo,
        saldoAwalDebit: n(r.sa_d), saldoAwalKredit: n(r.sa_k), mutasiDebit: n(r.mut_d), mutasiKredit: n(r.mut_k), saldo: n(r.saldo),
      })),
      meta: { proyekId: proyekId ?? null, sampai },
    };
  });

  fastify.get('/buku-besar', {
    preHandler: [...guard, validate({
      query: z.object({
        akunId: uuidSchema, proyekId: uuidSchema.optional(), kodePembantuId: uuidSchema.optional(),
        dari: isoDate, sampai: isoDate,
      }),
    })],
    schema: { tags, description: 'Buku besar satu akun: saldo awal per tanggal "dari" dan mutasi dengan saldo berjalan' },
  }, async (request) => {
    const { akunId, proyekId, kodePembantuId, dari, sampai } = request.query;
    const proyekSa = proyekId ? sql`AND p.proyek_id = ${proyekId}` : sql``;
    const proyekJ = proyekId ? sql`AND j.proyek_id = ${proyekId}` : sql``;
    const kpSa = kodePembantuId ? sql`AND s.kode_pembantu_id = ${kodePembantuId}` : sql``;
    const kpJ = kodePembantuId ? sql`AND jd.kode_pembantu_id = ${kodePembantuId}` : sql``;

    const [awal] = await reportDb.execute(sql`
      SELECT ${signed(sql`COALESCE(SUM(x.d), 0)`, sql`COALESCE(SUM(x.k), 0)`)} saldo
      FROM finance.akun a, (
        SELECT s.debit d, s.kredit k FROM finance.saldo_awal s JOIN finance.saldo_awal_periode p ON p.id = s.periode_id
        WHERE s.akun_id = ${akunId} ${proyekSa} ${kpSa}
        UNION ALL
        SELECT jd.debit, jd.kredit FROM finance.jurnal_detail jd JOIN finance.jurnal j ON j.id = jd.jurnal_id
        WHERE jd.akun_id = ${akunId} AND j.status IN (${terbuku}) AND j.tanggal < ${dari} ${proyekJ} ${kpJ}
      ) x
      WHERE a.id = ${akunId}
      GROUP BY a.tipe_saldo
    `);
    const lines = await reportDb.execute(sql`
      SELECT j.id jurnal_id, j.no_bukti, j.tanggal, j.uraian, j.sumber, jd.keterangan, jd.kode_pembantu_id, jd.debit, jd.kredit,
             ${signed(sql`jd.debit`, sql`jd.kredit`)} gerak
      FROM finance.jurnal_detail jd
      JOIN finance.jurnal j ON j.id = jd.jurnal_id
      JOIN finance.akun a ON a.id = jd.akun_id
      WHERE jd.akun_id = ${akunId} AND j.status IN (${terbuku}) AND j.tanggal BETWEEN ${dari} AND ${sampai} ${proyekJ} ${kpJ}
      ORDER BY j.tanggal, j.no_bukti, jd.urutan
    `);

    let saldo = n(awal?.saldo);
    const saldoAwal = saldo;
    const data = lines.map((l) => {
      saldo = Math.round((saldo + n(l.gerak)) * 100) / 100;
      return {
        jurnalId: l.jurnal_id, nomorJurnal: l.no_bukti, tanggal: l.tanggal, keterangan: l.keterangan || l.uraian,
        sumber: l.sumber, kodePembantuId: l.kode_pembantu_id, debit: n(l.debit), kredit: n(l.kredit), saldo,
      };
    });
    return { success: true, message: 'Success', data, meta: { saldoAwal, saldoAkhir: saldo, dari, sampai } };
  });

  fastify.get('/saldo-kode-pembantu', {
    preHandler: [...guard, validate({
      query: z.object({ bulan: bulanSchema, proyekId: uuidSchema.optional(), kategori: z.enum(KATEGORI_KODE_PEMBANTU).optional() }),
    })],
    schema: {
      tags,
      description: 'Saldo per kode pembantu untuk satu bulan (FE: getSaldoPerKodePembantu di hutangStore). ' +
        'saldoAwal = sebelum bulan itu, mutasiBulan = gerak bertanda di bulan itu.',
    },
  }, async (request) => {
    const { bulan, proyekId, kategori } = request.query;
    const data = await saldoKodePembantu({ bulan, proyekId, kategori: kategori ? [kategori] : undefined });
    return {
      success: true,
      message: 'Success',
      data,
      meta: { bulan },
    };
  });
}
