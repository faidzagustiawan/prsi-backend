// src/modules/penjualan/piutang.routes.js
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { uuidSchema, isoDate, nominal, idParams, optionalText } from '../../shared/utils/zod.js';
import { STATUS_PROSES_PEMBAYARAN } from '../../shared/constants.js';
import * as piutang from './piutang.service.js';
import * as pembayaran from './pembayaran.service.js';

const ok = (data, message = 'Success') => ({ success: true, message, data });
const positif = nominal.refine((v) => v > 0, 'Nominal harus lebih dari 0');

export async function piutangRoutes(fastify) {
  const guard = keuanganOnly(fastify);
  const tags = ['Piutang'];

  fastify.get('/', {
    preHandler: [...guard, validate({ query: z.object({ proyekId: uuidSchema.optional(), statusBast: z.enum(['belum_bast', 'sudah_bast']).optional() }) })],
    schema: { tags, description: 'Kartu tagihan per penjualan (FE: KavlingTagihan)' },
  }, async (request) => ok(await piutang.list(request.query)));

  fastify.get('/ringkasan', {
    preHandler: [...guard, validate({ query: z.object({ proyekId: uuidSchema.optional() }) })],
    schema: { tags, description: 'Total nilai kontrak, dibayar, sisa (FE: getTotalNilaiKontrak/Dibayar/Sisa)' },
  }, async (request) => ok(await piutang.ringkasan(request.query)));

  fastify.get('/:id', { preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Detail kartu tagihan' } },
    async (request) => ok(await piutang.get(request.params.id)));

  fastify.post('/:id/bast', {
    preHandler: [...guard, validate({ params: idParams, body: z.object({ tanggal: isoDate, nilaiHpp: nominal.default(0) }) })],
    schema: { tags, description: 'Tandai BAST: jurnal pengakuan penjualan dan HPP. Pembayaran sesudahnya masuk ke piutang.' },
  }, async (request) => ok(await piutang.bast(actorOf(request), request.params.id, request.body), 'BAST dicatat'));

  fastify.post('/:id/batal', {
    preHandler: [...guard, validate({ params: idParams, body: z.object({ tanggal: isoDate, potongan: nominal.default(0), alasan: optionalText(1000) }) })],
    schema: { tags, description: 'Batalkan penjualan (belum BAST): potongan jadi pendapatan lain-lain, sisa jadi hutang pengembalian' },
  }, async (request) => ok(await piutang.batal(actorOf(request), request.params.id, request.body), 'Penjualan dibatalkan'));

  fastify.post('/:id/biaya-kpr', {
    preHandler: [...guard, validate({
      params: idParams,
      body: z.object({ jenis: z.enum(['cashback', 'admin']), tanggal: isoDate, nominal: positif, akunKasId: uuidSchema, noBukti: optionalText(60) }),
    })],
    schema: { tags, description: 'Catat cashback atau admin KPR (jurnal draft sampai bukti diunggah)' },
  }, async (request, reply) => reply.code(201).send(ok(await piutang.biayaKpr(actorOf(request), request.params.id, request.body), 'Biaya KPR dicatat')));

  fastify.post('/:id/alokasi/pindah', {
    preHandler: [...guard, validate({ params: idParams, body: z.object({ dariJadwalId: uuidSchema, keJadwalId: uuidSchema, nominal: positif }) })],
    schema: { tags, description: 'Koreksi alokasi manual antar periode (FE: updateAlokasi). Tercatat di riwayatAlokasi.' },
  }, async (request) => ok(await piutang.pindahAlokasi(actorOf(request), request.params.id, request.body), 'Alokasi dipindah'));
}

export async function pembayaranTrackRoutes(fastify) {
  const guard = keuanganOnly(fastify);
  const tags = ['Pembayaran PR Track'];

  fastify.get('/', {
    preHandler: [...guard, validate({
      query: z.object({ statusProses: z.enum([...STATUS_PROSES_PEMBAYARAN, 'belum_diproses']).optional(), assignmentId: uuidSchema.optional() }),
    })],
    schema: { tags, description: 'Pembayaran dari PR Track dan status prosesnya (antrean Menunggu / Gagal validasi / Perlu ditinjau)' },
  }, async (request) => ok(await pembayaran.list(request.query)));

  fastify.post('/proses', {
    preHandler: guard,
    schema: { tags, description: 'Proses semua pembayaran yang belum diproses atau masih menunggu (biasanya dijalankan worker)' },
  }, async (request) => ok(await pembayaran.prosesSemua(actorOf(request)), 'Pembayaran diproses'));

  fastify.post('/:id/proses', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Proses ulang satu pembayaran (mis. setelah data Track diperbaiki atau jurnal lama dibalik)' },
  }, async (request) => ok(await pembayaran.proses(actorOf(request), request.params.id), 'Pembayaran diproses'));
}
