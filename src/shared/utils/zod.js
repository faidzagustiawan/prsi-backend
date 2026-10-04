// src/shared/utils/zod.js
// Potongan skema zod yang dipakai banyak modul.
import { z } from 'zod';

export const uuidSchema = z.uuid('ID tidak valid');

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Tanggal tidak valid');

export const bulanSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Format bulan harus YYYY-MM');

/** Nominal rupiah >= 0, maksimal 2 desimal, di bawah 100 triliun supaya presisi 2 desimal number JS terjaga. */
export const nominal = z
  .number({ error: 'Nominal harus berupa angka' })
  .nonnegative('Nominal tidak boleh negatif')
  .max(99_999_999_999_999, 'Nominal terlalu besar')
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'Nominal maksimal 2 angka desimal');

export const optionalText = (max) =>
  z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
};

export const idParams = z.object({ id: uuidSchema });
