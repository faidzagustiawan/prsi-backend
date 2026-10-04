// src/modules/kontrak/kontrak.routes.js
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { uuidSchema, isoDate, nominal, idParams, optionalText } from '../../shared/utils/zod.js';
import * as service from './kontrak.service.js';

const tags = ['Kontrak Kontraktor'];
const positif = nominal.refine((v) => v > 0, 'Nominal harus lebih dari 0');
const ok = (data, message = 'Success') => ({ success: true, message, data });

const createBody = z.object({
  noSpk: z.string().trim().min(1, 'No. SPK wajib diisi').max(40),
  proyekId: uuidSchema,
  unitId: uuidSchema,
  tipe: optionalText(50),
  tanggalSpk: isoDate,
  // Kontraktor yang sudah ada sebagai kode pembantu, atau nama kontraktor baru
  kontraktorId: uuidSchema.optional().nullable(),
  namaKontraktor: z.string().trim().max(150).optional().nullable(),
  rab: nominal,
  nilaiKontrak: positif,
  keterangan: optionalText(2000),
  akunPersediaanId: uuidSchema,
  akunHutangId: uuidSchema.optional().nullable(),
});

export default async function kontrakRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate({ query: z.object({ proyekId: uuidSchema.optional(), status: z.enum(['aktif', 'batal']).optional() }) })],
    schema: { tags, description: 'Daftar kontrak; nilaiTerkini, totalDibayar, sisaHutang dihitung dari jurnal' },
  }, async (request) => ok(await service.list(request.query)));

  fastify.get('/:id', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Detail kontrak dengan adendum dan pembayaran' },
  }, async (request) => ok(await service.get(request.params.id)));

  fastify.post('/', {
    preHandler: [...guard, validate({ body: createBody })],
    schema: { tags, description: 'Simpan SPK; jurnal pengakuan hutang langsung diposting' },
  }, async (request, reply) => reply.code(201).send(ok(await service.create(actorOf(request), request.body), 'Kontrak disimpan')));

  fastify.post('/:id/adendum', {
    preHandler: [...guard, validate({
      params: idParams,
      body: z.object({
        noAdendum: z.string().trim().min(1).max(40), tanggal: isoDate, nilaiBaru: positif,
        alasan: z.string().trim().min(1, 'Alasan wajib diisi').max(2000),
      }),
    })],
    schema: { tags, description: 'Adendum nilai kontrak; jurnal selisih langsung diposting' },
  }, async (request, reply) => reply.code(201).send(ok(await service.adendum(actorOf(request), request.params.id, request.body), 'Adendum disimpan')));

  fastify.post('/:id/pembayaran', {
    preHandler: [...guard, validate({
      params: idParams,
      body: z.object({ tanggal: isoDate, nominal: positif, akunKasId: uuidSchema, noBukti: optionalText(60), keterangan: optionalText(1000) }),
    })],
    schema: { tags, description: 'Catat pembayaran ke kontraktor (jurnal draft sampai bukti diunggah lalu diposting)' },
  }, async (request, reply) => reply.code(201).send(ok(await service.bayar(actorOf(request), request.params.id, request.body), 'Pembayaran dicatat')));

  fastify.delete('/pembayaran/:id', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Hapus pembayaran (jurnal draft, atau periode masih terbuka)' },
  }, async (request) => ok(await service.hapusPembayaran(actorOf(request), request.params.id), 'Pembayaran dihapus'));

  fastify.post('/:id/batal', {
    preHandler: [...guard, validate({ params: idParams, body: z.object({ tanggal: isoDate.optional(), alasan: optionalText(1000) }).default({}) })],
    schema: { tags, description: 'Batalkan kontrak; sisa hutang yang belum dibayar dibalik ke persediaan' },
  }, async (request) => ok(await service.batal(actorOf(request), request.params.id, request.body), 'Kontrak dibatalkan'));
}
