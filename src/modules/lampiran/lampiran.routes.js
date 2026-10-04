// src/modules/lampiran/lampiran.routes.js
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { keuanganOnly } from '../../middleware/authorize.js';
import { uuidSchema, idParams } from '../../shared/utils/zod.js';
import * as service from './lampiran.service.js';

const tags = ['Lampiran'];
const ownerQuery = { query: z.object({ entityType: z.enum(['jurnal', 'dokumen']), entityId: uuidSchema }) };

export default async function lampiranRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate(ownerQuery)],
    schema: { tags, description: 'Daftar lampiran milik satu entitas' },
  }, async (request) => ({ success: true, message: 'Success', data: await service.listFor(request.query) }));

  fastify.post('/', {
    preHandler: [...guard, validate(ownerQuery)],
    schema: {
      tags,
      description: 'Unggah satu berkas (multipart/form-data, field "file"). PDF/JPG/PNG/WEBP, maks 10 MB. ' +
        'Contoh: POST /api/v1/lampiran?entityType=jurnal&entityId=<id jurnal>',
    },
  }, async (request, reply) => {
    const data = await service.upload(request, request.query);
    return reply.code(201).send({ success: true, message: 'Lampiran diunggah', data });
  });

  fastify.get('/:id/unduh', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Unduh berkas lampiran' },
  }, async (request, reply) => {
    const { row, fullPath } = await service.findForDownload(request.params.id);
    // Bukti dari PR Track disimpan sebagai tautan ke penyimpanan Track
    if (row.sumber === 'pr_track') return reply.redirect(row.path);
    const disposition = request.query?.inline === '1' ? 'inline' : 'attachment';
    return reply
      .type(row.mime)
      .header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.namaFile)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .send(createReadStream(fullPath));
  });

  fastify.delete('/:id', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Hapus lampiran (hanya untuk jurnal draft)' },
  }, async (request) => {
    await service.remove(request, request.params.id);
    return { success: true, message: 'Lampiran dihapus' };
  });
}
