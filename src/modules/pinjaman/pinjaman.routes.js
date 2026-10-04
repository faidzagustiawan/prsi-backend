// src/modules/pinjaman/pinjaman.routes.js
import { z } from 'zod';
import { validate, validatePatch } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { uuidSchema, isoDate, nominal, idParams, optionalText } from '../../shared/utils/zod.js';
import * as service from './pinjaman.service.js';

const tags = ['Pinjaman Bank'];
const positif = nominal.refine((v) => v > 0, 'Nominal harus lebih dari 0');
const POLA = ['terpisah', 'satu_transfer', 'bunga_rutin', 'fleksibel'];

const createBody = z.object({
  proyekId: uuidSchema,
  // Bank yang sudah ada sebagai kode pembantu, atau nama bank baru
  kodePembantuId: uuidSchema.optional().nullable(),
  namaBank: z.string().trim().max(150).optional().nullable(),
  noAkad: optionalText(50),
  pola: z.enum(POLA),
  tanggalPencairanAwal: isoDate,
  nominalPencairanAwal: positif,
  // Rekening penerima pencairan
  akunKasId: uuidSchema,
  noBukti: optionalText(60),
  tanggalAcuanBunga: z.number().int().min(1).max(31),
  tanggalJatuhTempoPokok: isoDate,
  akunHutangId: uuidSchema.optional().nullable(),
  akunBebanBungaId: uuidSchema.optional().nullable(),
  keterangan: optionalText(2000),
});

const updateBody = z.object({
  tanggalAcuanBunga: z.number().int().min(1).max(31),
  tanggalJatuhTempoPokok: isoDate,
  keterangan: optionalText(2000),
  pola: z.enum(POLA),
  noAkad: optionalText(50),
}).partial();

const topUpBody = z.object({
  tanggal: isoDate, nominal: positif, akunKasId: uuidSchema, noBukti: optionalText(60), keterangan: optionalText(1000),
});

const bayarBody = z.object({
  tanggal: isoDate,
  jenis: z.enum(['pokok', 'bunga', 'gabungan']),
  nominal: positif,
  // Untuk gabungan; kosong = menunggu rincian dari bank
  nominalPokok: nominal.optional(),
  nominalBunga: nominal.optional(),
  periodeBunga: optionalText(30),
  akunKasId: uuidSchema,
  noBukti: optionalText(60),
  keterangan: optionalText(1000),
});

const ok = (data, message = 'Success') => ({ success: true, message, data });

export default async function pinjamanRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate({ query: z.object({ proyekId: uuidSchema.optional(), status: z.enum(['aktif', 'lunas']).optional() }) })],
    schema: { tags, description: 'Daftar pinjaman bank; sisa pokok dihitung dari jurnal terposting' },
  }, async (request) => ok(await service.list(request.query)));

  fastify.get('/jatuh-tempo', {
    preHandler: [...guard, validate({ query: z.object({ hari: z.coerce.number().int().min(0).max(366).default(14) }) })],
    schema: { tags, description: 'Pengingat jatuh tempo bunga (bulanan) dan pokok dalam N hari (FE: getDueReminders)' },
  }, async (request) => ok(await service.jatuhTempo({ hari: request.query.hari })));

  fastify.get('/:id', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Detail pinjaman dengan top up dan pembayaran (entries)' },
  }, async (request) => ok(await service.get(request.params.id)));

  fastify.post('/', {
    preHandler: [...guard, validate({ body: createBody })],
    schema: { tags, description: 'Tambah pinjaman beserta pencairan awal (jurnal draft: unggah bukti lalu posting)' },
  }, async (request, reply) => reply.code(201).send(ok(await service.create(actorOf(request), request.body), 'Pinjaman ditambahkan')));

  fastify.patch('/:id', {
    preHandler: [...guard, validatePatch({ params: idParams, body: updateBody })],
    schema: { tags, description: 'Ubah tanggal acuan bunga, jatuh tempo pokok, pola, no. akad, keterangan' },
  }, async (request) => ok(await service.update(actorOf(request), request.params.id, request.body), 'Pinjaman diperbarui'));

  fastify.delete('/:id', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Hapus pinjaman yang belum punya jurnal terposting' },
  }, async (request) => {
    await service.remove(actorOf(request), request.params.id);
    return { success: true, message: 'Pinjaman dihapus' };
  });

  fastify.post('/:id/top-up', {
    preHandler: [...guard, validate({ params: idParams, body: topUpBody })],
    schema: { tags, description: 'Tambah pencairan (top up)' },
  }, async (request, reply) => reply.code(201).send(ok(await service.topUp(actorOf(request), request.params.id, request.body), 'Top up dicatat')));

  fastify.post('/:id/pembayaran', {
    preHandler: [...guard, validate({ params: idParams, body: bayarBody })],
    schema: { tags, description: 'Catat pembayaran pokok, bunga, atau gabungan (satu transfer)' },
  }, async (request, reply) => reply.code(201).send(ok(await service.bayar(actorOf(request), request.params.id, request.body), 'Pembayaran dicatat')));

  fastify.patch('/transaksi/:id/rincian', {
    preHandler: [...guard, validate({ params: idParams, body: z.object({ nominalPokok: nominal, nominalBunga: nominal }) })],
    schema: { tags, description: 'Isi rincian pokok/bunga untuk pembayaran gabungan yang menunggu rincian' },
  }, async (request) => ok(await service.isiRincian(actorOf(request), request.params.id, request.body), 'Rincian disimpan'));

  fastify.delete('/transaksi/:id', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Hapus top up atau pembayaran (jurnal draft, atau periode masih terbuka)' },
  }, async (request) => ok(await service.hapusTransaksi(actorOf(request), request.params.id), 'Transaksi dihapus'));
}
