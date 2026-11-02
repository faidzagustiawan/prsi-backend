// src/middleware/validate.js
import { errorBody } from '../shared/utils/errorHandler.js';

const LOKASI = { body: '', query: 'parameter ', params: 'parameter URL ' };

/** Ubah issue zod menjadi { field, message } dengan nama kolom yang jelas. */
const zodErrors = (error, lokasi) => {
  const issues = error.issues ?? error.errors;
  if (!Array.isArray(issues)) return [{ message: error.message }];
  return issues.map((issue) => {
    const field = issue.path?.join('.') || '';
    return { field: field || undefined, message: field ? `Kolom ${LOKASI[lokasi]}'${field}': ${issue.message}` : issue.message };
  });
};

export const validate = (schema) => {
  const handler = async (request, reply) => {
    for (const lokasi of ['params', 'query', 'body']) {
      if (!schema[lokasi]) continue;
      const result = schema[lokasi].safeParse(request[lokasi]);
      if (result.success) {
        request[lokasi] = result.data;
        continue;
      }
      const errors = zodErrors(result.error, lokasi);
      const message = errors.length === 1
        ? errors[0].message
        : `Data yang Anda masukkan tidak valid (${errors.length} kesalahan). Periksa kolom yang ditandai.`;
      return reply.code(400).send(errorBody(request, 400, message, { code: 'VALIDATION', errors }));
    }
  };
  // Documentation metadata only; does not change request validation.
  handler.validationSchema = schema;
  return handler;
};

/**
 * Untuk PATCH: setelah divalidasi, hanya kolom yang benar-benar dikirim klien
 * yang dipertahankan. Tanpa ini, nilai default di skema (mis. status 'aktif',
 * flag false) ikut terisi dan menimpa data yang tidak dimaksud diubah.
 */
export const validatePatch = (schema) => {
  const inner = validate(schema);
  const handler = async (request, reply) => {
    const sent = request.body && typeof request.body === 'object' ? new Set(Object.keys(request.body)) : new Set();
    await inner(request, reply);
    if (reply.sent || !request.body) return;
    request.body = Object.fromEntries(Object.entries(request.body).filter(([key]) => sent.has(key)));
    if (!Object.keys(request.body).length) {
      return reply.code(400).send(errorBody(request, 400, 'Tidak ada data yang diubah. Ubah minimal satu kolom sebelum menyimpan.', { code: 'NO_CHANGES' }));
    }
  };
  handler.validationSchema = schema;
  handler.isPatchValidation = true;
  return handler;
};
