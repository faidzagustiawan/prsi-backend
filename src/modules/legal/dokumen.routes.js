// src/modules/legal/dokumen.routes.js
import { z } from 'zod';
import { validate, validatePatch } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { uuidSchema, isoDate, nominal, idParams, optionalText } from '../../shared/utils/zod.js';
import { STATUS_DOKUMEN, tipeDariLabel } from '../../shared/constants.js';
import { fieldSchema } from './pasal.routes.js';
import * as service from './dokumen.service.js';
import * as adendum from './adendum.service.js';

const tags = ['Legal - Dokumen SPPR'];
const ok = (data, message = 'Success') => ({ success: true, message, data });

const tipeSchema = z.string().transform((v, ctx) => {
  const t = tipeDariLabel(v);
  if (!t) ctx.addIssue({ code: 'custom', message: 'Tipe transaksi harus Cash, KPR, atau In House' });
  return t;
});

const pembeliSchema = z.object({
  nama: z.string().trim().max(150), ttl: z.string().trim().max(150), pekerjaan: z.string().trim().max(100),
  alamat: z.string().trim().max(1000), noKtp: z.string().trim().max(16), noHp: z.string().trim().max(20),
}).partial();

const dataUtama = {
  pembeli: pembeliSchema,
  hargaAwal: nominal,
  bphtb: nominal,
  ajbBbn: nominal,
  uangMuka: nominal,
  tanggalPerjanjian: isoDate,
  fasilitasTambahan: optionalText(2000),
  assignmentId: uuidSchema.nullable(),
};

const createBody = z.object({
  ptId: uuidSchema,
  kavlingId: uuidSchema,
  // Penjualan PR Track; boleh menyusul, wajib saat finalisasi
  assignmentId: uuidSchema.optional().nullable(),
  templateId: uuidSchema.optional().nullable(),
  tipeTransaksi: tipeSchema.optional(),
  pembeli: pembeliSchema.default({}),
  hargaAwal: nominal.default(0),
  bphtb: nominal.default(0),
  ajbBbn: nominal.default(0),
  uangMuka: nominal.default(0),
  tanggalPerjanjian: isoDate,
  fasilitasTambahan: optionalText(2000),
  status: z.enum(['draft', 'final']).default('draft'),
});

const jadwalBody = z.object({
  tanggalAcuan: z.coerce.number().int().min(1).max(31),
  nominalPerBulan: nominal.refine((v) => v > 0, 'Nominal per bulan harus lebih dari 0'),
  tanggalMulai: isoDate,
  jatuhTempoTerakhir: isoDate,
  // Opsional: baris eksplisit. Kosong = dihitung server dari parameter di atas
  baris: z.array(z.object({ id: z.string().max(60).optional(), tanggal: isoDate, jumlah: nominal, keterangan: optionalText(100) })).max(600).optional(),
}).refine((b) => b.jatuhTempoTerakhir >= b.tanggalMulai, 'Jatuh tempo terakhir harus setelah tanggal mulai');

const pasalParams = z.object({ id: uuidSchema, pasalId: uuidSchema });

export default async function dokumenRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate({ query: z.object({ perumahanId: uuidSchema.optional(), status: z.enum(STATUS_DOKUMEN).optional(), q: z.string().trim().max(100).optional() }) })],
    schema: { tags, description: 'Daftar dokumen (filter perumahan, status, q = nomor/nama pembeli)' },
  }, async (request) => ok(await service.list(request.query)));

  fastify.get('/penjualan-tersedia', {
    preHandler: [...guard, validate({ query: z.object({ proyekId: uuidSchema.optional() }) })],
    schema: { tags, description: 'Penjualan PR Track yang belum punya SPPR final, untuk dipilih saat membuat dokumen' },
  }, async (request) => ok(await service.penjualanTersedia(request.query)));

  fastify.get('/:id', { preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Detail dokumen' } },
    async (request) => ok(await service.get(request.params.id)));

  fastify.post('/', {
    preHandler: [...guard, validate({ body: createBody })],
    schema: { tags, description: 'Buat dokumen; pasal disalin dari template aktif PT dan tipe transaksi. status=final langsung memfinalkan.' },
  }, async (request, reply) => reply.code(201).send(ok(await service.create(actorOf(request), request.body), 'Dokumen dibuat')));

  fastify.patch('/:id', {
    preHandler: [...guard, validatePatch({ params: idParams, body: z.object(dataUtama).partial() })],
    schema: { tags, description: 'Ubah data utama (pembeli, harga, tanggal, fasilitas, penjualan). Hanya draft.' },
  }, async (request) => ok(await service.updateDataUtama(actorOf(request), request.params.id, request.body), 'Dokumen diperbarui'));

  fastify.delete('/:id', { preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Hapus draft' } },
    async (request) => {
      await service.remove(actorOf(request), request.params.id);
      return { success: true, message: 'Dokumen dihapus' };
    });

  fastify.post('/:id/pasal', {
    preHandler: [...guard, validate({
      params: idParams,
      body: z.object({
        pustakaId: uuidSchema.optional(), judul: z.string().trim().max(150).optional(), isi: z.string().trim().max(20000).optional(),
        fields: z.array(fieldSchema.extend({ nilai: z.string().max(500).optional() })).max(40).optional(), index: z.number().int().min(0).optional(),
      }),
    })],
    schema: { tags, description: 'Sisipkan pasal dari pustaka (pustakaId) atau pasal bebas (judul, isi, fields) di posisi index' },
  }, async (request, reply) => reply.code(201).send(ok(await service.addPasal(actorOf(request), request.params.id, request.body), 'Pasal ditambahkan')));

  fastify.patch('/:id/pasal/:pasalId', {
    preHandler: [...guard, validate({
      params: pasalParams,
      body: z.object({
        judul: z.string().trim().min(1).max(150), isi: z.string().trim().min(1).max(20000),
        // { key: nilai } untuk isian pasal (FE: updatePasalField)
        fieldValues: z.record(z.string(), z.string().max(500)),
      }).partial(),
    })],
    schema: { tags, description: 'Ubah judul/isi pasal atau nilai isiannya' },
  }, async (request) => ok(await service.updatePasal(actorOf(request), request.params.id, request.params.pasalId, request.body), 'Pasal diperbarui'));

  fastify.delete('/:id/pasal/:pasalId', {
    preHandler: [...guard, validate({ params: pasalParams })], schema: { tags, description: 'Hapus pasal dari dokumen' },
  }, async (request) => ok(await service.removePasal(actorOf(request), request.params.id, request.params.pasalId), 'Pasal dihapus'));

  fastify.put('/:id/pasal-urutan', {
    preHandler: [...guard, validate({ params: idParams, body: z.object({ pasalIds: z.array(uuidSchema).max(200) }) })],
    schema: { tags, description: 'Atur ulang urutan pasal (semua id pasal dokumen, urutan baru)' },
  }, async (request) => ok(await service.reorderPasal(actorOf(request), request.params.id, request.body.pasalIds), 'Urutan disimpan'));

  fastify.put('/:id/jadwal', {
    preHandler: [...guard, validate({ params: idParams, body: jadwalBody })],
    schema: { tags, description: 'Simpan jadwal DP. Tanpa "baris", server membuat baris bulanan (tanggal 29-31 jatuh ke akhir bulan pendek).' },
  }, async (request) => ok(await service.setJadwal(actorOf(request), request.params.id, request.body), 'Jadwal disimpan'));

  fastify.delete('/:id/jadwal', {
    preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Hapus jadwal DP (draft)' },
  }, async (request) => ok(await service.setJadwal(actorOf(request), request.params.id, null), 'Jadwal dihapus'));

  fastify.patch('/:id/jadwal/baris/:barisId', {
    preHandler: [...guard, validate({ params: z.object({ id: uuidSchema, barisId: z.string().max(60) }), body: z.object({ jumlah: nominal }) })],
    schema: { tags, description: 'Ubah jumlah satu baris jadwal (FE: updateBarisJadwal)' },
  }, async (request) => ok(await service.updateBarisJadwal(actorOf(request), request.params.id, request.params.barisId, request.body.jumlah), 'Baris diperbarui'));

  fastify.post('/:id/finalisasi', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: {
      tags,
      description: 'Finalkan SPPR: wajib assignmentId, nama pembeli, harga > 0, total jadwal = uang muka. ' +
        'Membentuk kartu piutang, jadwal angsuran (antre dikirim ke Track), dan jurnal booking fee ke uang muka.',
    },
  }, async (request) => ok(await service.finalisasi(actorOf(request), request.params.id), 'Dokumen difinalkan'));

  fastify.post('/:id/adendum', {
    preHandler: [...guard, validate({
      params: idParams,
      body: z.object({
        alasan: z.string().trim().min(1, 'Alasan adendum wajib diisi').max(1000),
        // Hanya untuk pindah kavling (kavling di PR Track sudah diganti)
        biayaPindah: nominal.default(0),
        tanggal: isoDate.optional(),
      }),
    })],
    schema: {
      tags,
      description: 'Buat adendum draft dari SPPR yang berlaku: data, pasal, dan jadwal aktif disalin; kavling ikut PR Track terkini. ' +
        'Ubah dengan endpoint dokumen biasa, lalu POST /:adendumId/finalisasi.',
    },
  }, async (request, reply) => {
    const id = await adendum.buat(actorOf(request), request.params.id, request.body);
    return reply.code(201).send(ok(await service.get(id), 'Adendum dibuat'));
  });

  fastify.get('/:id/riwayat', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Rantai SPPR dan adendumnya; berlaku = yang dipakai piutang sekarang' },
  }, async (request) => ok(await adendum.riwayat(request.params.id)));

  fastify.post('/:id/tandatangani', {
    preHandler: [...guard, validate({ params: idParams })], schema: { tags, description: 'Tandai dokumen final sudah ditandatangani' },
  }, async (request) => ok(await service.tandatangani(actorOf(request), request.params.id), 'Dokumen ditandatangani'));
}
