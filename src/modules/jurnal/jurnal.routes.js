// src/modules/jurnal/jurnal.routes.js
import { validate } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import * as schema from './jurnal.schema.js';
import * as service from './jurnal.service.js';

const tags = ['Jurnal'];

export default async function jurnalRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate(schema.listSchema)],
    schema: { tags, description: 'Daftar jurnal (filter proyekId, status, sumber, bulan YYYY-MM, q)' },
  }, async (request) => {
    const { items, meta } = await service.list(request.query);
    return { success: true, message: 'Success', data: items, meta };
  });

  fastify.get('/:id', {
    preHandler: [...guard, validate(schema.getSchema)],
    schema: { tags, description: 'Detail jurnal beserta baris dan lampiran' },
  }, async (request) => ({ success: true, message: 'Success', data: await service.get(request.params.id) }));

  fastify.post('/', {
    preHandler: [...guard, validate(schema.createSchema)],
    schema: {
      tags,
      description: 'Buat jurnal umum. status=diposting langsung memposting; bila ada akun kas/bank, ' +
        'simpan draft dulu, unggah lampiran, lalu POST /:id/posting.',
    },
  }, async (request, reply) => {
    const data = await service.createManual(actorOf(request), request.body);
    return reply.code(201).send({ success: true, message: 'Jurnal disimpan', data });
  });

  fastify.put('/:id', {
    preHandler: [...guard, validate(schema.updateSchema)],
    schema: { tags, description: 'Ubah jurnal manual: draft, atau diposting selama periodenya terbuka' },
  }, async (request) => ({
    success: true, message: 'Jurnal diperbarui', data: await service.updateManual(actorOf(request), request.params.id, request.body),
  }));

  fastify.post('/:id/posting', {
    preHandler: [...guard, validate(schema.getSchema)],
    schema: { tags, description: 'Posting jurnal draft' },
  }, async (request) => ({
    success: true, message: 'Jurnal diposting', data: await service.postDraft(actorOf(request), request.params.id),
  }));

  fastify.post('/:id/balik', {
    preHandler: [...guard, validate(schema.balikSchema)],
    schema: { tags, description: 'Buat jurnal balik untuk jurnal yang sudah diposting (koreksi periode terkunci)' },
  }, async (request, reply) => {
    const data = await service.balik(actorOf(request), request.params.id, {
      tanggal: request.body.tanggal, uraian: request.body.keterangan,
    });
    return reply.code(201).send({ success: true, message: 'Jurnal balik dibuat', data });
  });

  fastify.delete('/:id', {
    preHandler: [...guard, validate(schema.getSchema)],
    schema: { tags, description: 'Hapus jurnal manual: draft, atau diposting selama periodenya terbuka' },
  }, async (request) => {
    await service.removeManual(actorOf(request), request.params.id);
    return { success: true, message: 'Jurnal dihapus' };
  });
}
