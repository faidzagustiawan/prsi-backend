// src/modules/jurnal/jurnal.schema.js
import { z } from 'zod';
import { uuidSchema, isoDate, bulanSchema, nominal, paginationQuery, idParams } from '../../shared/utils/zod.js';
import { JURNAL_STATUS, JURNAL_SUMBER } from '../../shared/constants.js';

const row = z.object({
  akunId: uuidSchema,
  kodePembantuId: uuidSchema.optional().nullable().or(z.literal('')),
  keterangan: z.string().trim().max(255).optional().nullable(),
  debit: nominal.default(0),
  kredit: nominal.default(0),
});

const body = z.object({
  tanggal: isoDate,
  // FE memakai nama `keterangan` untuk uraian jurnal
  keterangan: z.string().trim().min(1, 'Keterangan jurnal wajib diisi').max(1000),
  proyekId: uuidSchema,
  noReferensi: z.string().trim().max(60).optional().nullable(),
  status: z.enum(['draft', 'diposting']).default('draft'),
  rows: z.array(row).min(1, 'Jurnal minimal terdiri dari 1 baris').max(200),
}).transform(({ keterangan, ...rest }) => ({ ...rest, uraian: keterangan }));

export const listSchema = {
  query: z.object({
    ...paginationQuery,
    proyekId: uuidSchema.optional(),
    status: z.enum(JURNAL_STATUS).optional(),
    sumber: z.enum(JURNAL_SUMBER).optional(),
    bulan: bulanSchema.optional(),
    q: z.string().trim().max(100).optional(),
  }),
};

export const getSchema = { params: idParams };
export const createSchema = { body };
export const updateSchema = { params: idParams, body };
export const balikSchema = {
  params: idParams,
  body: z.object({
    tanggal: isoDate.optional(),
    keterangan: z.string().trim().max(1000).optional(),
  }).default({}),
};
