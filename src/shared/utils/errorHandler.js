// src/shared/utils/errorHandler.js
//
// Semua respons galat API memakai satu bentuk:
//   { success: false, message, code, errors: [{ field?, message }], requestId }
// - message  : kalimat utama yang aman ditampilkan ke pengguna (Bahasa Indonesia)
// - code     : kode mesin yang stabil untuk dicabangkan di frontend
// - errors   : rincian per kolom/aturan (boleh kosong)
// - requestId: kode referensi untuk mencari log server; detail internal tidak pernah dikirim

import { AppError } from './AppError.js';

const humanizeField = (path) => (path || '').replace(/^\//, '').replace(/\//g, '.');

/** Rincian galat selalu berbentuk objek { field?, message } walau sumbernya string. */
export const normalizeErrors = (errors) =>
  (Array.isArray(errors) ? errors : [])
    .map((item) => {
      if (typeof item === 'string') return { message: item };
      if (item && typeof item.message === 'string') {
        return item.field ? { field: String(item.field), message: item.message } : { message: item.message };
      }
      return null;
    })
    .filter(Boolean);

const ajvMessage = (err) => {
  const parent = humanizeField(err.instancePath);
  const field = err.keyword === 'required'
    ? [parent, err.params.missingProperty].filter(Boolean).join('.')
    : parent || 'input';
  const label = `Kolom '${field}'`;
  switch (err.keyword) {
    case 'required': return { field, message: `${label} wajib diisi.` };
    case 'minLength': return { field, message: `${label} minimal ${err.params.limit} karakter.` };
    case 'maxLength': return { field, message: `${label} maksimal ${err.params.limit} karakter.` };
    case 'minimum': return { field, message: `${label} minimal ${err.params.limit}.` };
    case 'maximum': return { field, message: `${label} maksimal ${err.params.limit}.` };
    case 'type': return { field, message: `${label} harus bertipe ${err.params.type}.` };
    case 'enum': return { field, message: `Pilihan untuk ${label.toLowerCase()} tidak valid. Pilihan yang diizinkan: ${(err.params.allowedValues ?? []).join(', ')}.` };
    case 'format': return { field, message: err.params.format === 'email' ? `Format email pada ${label.toLowerCase()} tidak valid.` : `Format ${label.toLowerCase()} tidak valid (${err.params.format}).` };
    case 'additionalProperties': return { field: err.params.additionalProperty, message: `Kolom '${err.params.additionalProperty}' tidak dikenal.` };
    default: return { field, message: `${label}: ${err.message}` };
  }
};

// pg: detail "Key (kode)=(1101) already exists." → { kolom: 'kode', nilai: '1101' }
const parseKey = (detail) => {
  const match = /Key \((.+?)\)=\((.*?)\)/.exec(detail ?? '');
  return match ? { kolom: match[1], nilai: match[2] } : null;
};

const DB_UNAVAILABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', '08000', '08001', '08003', '08006', '57P01', '57P03', '53300']);

/** Terjemahkan kode galat PostgreSQL/driver menjadi status + pesan yang membantu. */
const fromDatabase = (pgError) => {
  const code = pgError?.code;
  const key = parseKey(pgError?.detail);
  switch (code) {
    case '23505':
      return {
        statusCode: 409,
        code: 'DUPLICATE',
        message: key
          ? `Data dengan ${key.kolom} '${key.nilai}' sudah terdaftar. Gunakan nilai lain atau ubah data yang sudah ada.`
          : 'Data tersebut sudah terdaftar di sistem.',
        errors: key ? [{ field: key.kolom, message: `Nilai '${key.nilai}' sudah dipakai.` }] : [],
      };
    case '23503': {
      const masihDipakai = /still referenced/.test(pgError.detail ?? '');
      return {
        statusCode: 409,
        code: masihDipakai ? 'IN_USE' : 'REFERENCE_NOT_FOUND',
        message: masihDipakai
          ? 'Data ini tidak dapat dihapus/diubah karena masih dipakai oleh data lain. Hapus atau pindahkan data terkait terlebih dahulu.'
          : `Data rujukan${key ? ` (${key.kolom})` : ''} tidak ditemukan. Muat ulang halaman lalu pilih ulang data tersebut.`,
        errors: key ? [{ field: key.kolom, message: masihDipakai ? 'Masih dipakai data lain.' : 'Data rujukan tidak ditemukan.' }] : [],
      };
    }
    case '23502':
      return {
        statusCode: 400,
        code: 'REQUIRED',
        message: `Kolom '${pgError.column_name ?? pgError.column ?? 'wajib'}' wajib diisi.`,
        errors: [{ field: pgError.column_name ?? pgError.column, message: 'Wajib diisi.' }].filter((e) => e.field),
      };
    case '23514':
      return { statusCode: 400, code: 'CONSTRAINT', message: 'Data tidak memenuhi aturan validasi sistem. Periksa kembali nilai yang dimasukkan.', errors: [] };
    case '22001':
      return { statusCode: 400, code: 'TOO_LONG', message: 'Teks yang dimasukkan terlalu panjang. Persingkat isian lalu coba lagi.', errors: [] };
    case '22003':
      return { statusCode: 400, code: 'OUT_OF_RANGE', message: 'Angka yang dimasukkan di luar batas yang diizinkan.', errors: [] };
    case '22P02':
    case '22007':
    case '22008':
      return { statusCode: 400, code: 'INVALID_FORMAT', message: 'Format data tidak valid (mis. tanggal, angka, atau ID). Periksa kembali isian Anda.', errors: [] };
    case '40001':
    case '40P01':
    case '55P03':
      return { statusCode: 409, code: 'CONFLICT_RETRY', message: 'Data sedang diproses oleh permintaan lain. Tunggu sebentar lalu coba lagi.', errors: [] };
    case '57014':
      return { statusCode: 504, code: 'DB_TIMEOUT', message: 'Permintaan ke database terlalu lama. Persempit filter/rentang data lalu coba lagi.', errors: [] };
    default:
      if (DB_UNAVAILABLE.has(code)) {
        return { statusCode: 503, code: 'DB_UNAVAILABLE', message: 'Database sedang tidak dapat dihubungi. Coba lagi beberapa saat lagi.', errors: [] };
      }
      return null;
  }
};

// Galat bawaan Fastify/plugin yang pesannya berbahasa Inggris.
const FASTIFY_CODES = {
  FST_ERR_CTP_EMPTY_JSON_BODY: [400, 'BAD_REQUEST', 'Isi permintaan kosong padahal dikirim sebagai JSON.'],
  FST_ERR_CTP_INVALID_JSON_BODY: [400, 'BAD_REQUEST', 'Isi permintaan bukan JSON yang valid.'],
  FST_ERR_CTP_BODY_TOO_LARGE: [413, 'PAYLOAD_TOO_LARGE', 'Ukuran data yang dikirim terlalu besar (maks. 5 MB).'],
  FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, 'UNSUPPORTED_MEDIA_TYPE', 'Jenis konten permintaan tidak didukung.'],
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: [400, 'BAD_REQUEST', 'Panjang isi permintaan tidak sesuai.'],
  FST_REQ_FILE_TOO_LARGE: [413, 'FILE_TOO_LARGE', 'Ukuran berkas melebihi batas yang diizinkan.'],
  FST_FILES_LIMIT: [413, 'TOO_MANY_FILES', 'Hanya satu berkas yang boleh diunggah per permintaan.'],
  FST_FIELDS_LIMIT: [413, 'TOO_MANY_FIELDS', 'Terlalu banyak kolom pada formulir unggahan.'],
  FST_PARTS_LIMIT: [413, 'TOO_MANY_FIELDS', 'Terlalu banyak bagian pada formulir unggahan.'],
  FST_INVALID_MULTIPART_CONTENT_TYPE: [406, 'BAD_REQUEST', 'Unggahan harus dikirim sebagai multipart/form-data.'],
  FST_NO_FORM_DATA: [400, 'BAD_REQUEST', 'Tidak ada berkas yang dikirim.'],
};

const JWT_CODES = new Set([
  'FST_JWT_NO_AUTHORIZATION_IN_HEADER',
  'FST_JWT_NO_AUTHORIZATION_IN_COOKIE',
  'FST_JWT_AUTHORIZATION_TOKEN_INVALID',
  'FST_JWT_AUTHORIZATION_TOKEN_UNTRUSTED',
  'FST_JWT_BAD_REQUEST',
  'FST_JWT_BAD_COOKIE_REQUEST',
]);

const DEFAULT_CODE = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE', 422: 'UNPROCESSABLE', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE',
};

/** Bangun body galat standar. Dipakai juga oleh middleware yang membalas langsung. */
export const errorBody = (request, statusCode, message, { code, errors = [] } = {}) => ({
  success: false,
  message,
  code: code ?? DEFAULT_CODE[statusCode] ?? (statusCode >= 500 ? 'INTERNAL_ERROR' : 'ERROR'),
  errors: normalizeErrors(errors),
  requestId: request?.id,
});

/** Pesan error ramah pengguna (Bahasa Indonesia), tanpa membocorkan detail internal. */
export const globalErrorHandler = (error, request, reply) => {
  let statusCode = error.statusCode >= 400 ? error.statusCode : 500;
  let code;
  // Pesan galat 5xx tak terduga bisa berisi detail internal; hanya AppError yang dipercaya.
  const trusted = error instanceof AppError;
  let message = statusCode >= 500 && !trusted ? null : error.message;
  let errors = error.errors;

  if (error.validation) {
    statusCode = 400;
    code = 'VALIDATION';
    errors = error.validation.map(ajvMessage);
    message = errors.length === 1 ? errors[0].message : `Data yang Anda masukkan tidak valid (${errors.length} kesalahan).`;
  } else if (FASTIFY_CODES[error.code]) {
    [statusCode, code, message] = FASTIFY_CODES[error.code];
  } else if (JWT_CODES.has(error.code)) {
    statusCode = 401;
    code = 'UNAUTHORIZED';
    message = 'Akses ditolak. Anda belum login atau token tidak valid. Silakan login kembali.';
  } else if (error.code === 'FAST_JWT_EXPIRED' || error.code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED') {
    statusCode = 401;
    code = 'SESSION_EXPIRED';
    message = 'Sesi Anda telah berakhir. Silakan login kembali.';
  } else if (statusCode === 429) {
    code = 'RATE_LIMITED';
    message = error.message?.startsWith('Terlalu') ? error.message : 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.';
  } else if (error.message === 'Not allowed by CORS') {
    code = 'CORS_REJECTED';
    message = `Origin '${request.headers.origin}' tidak diizinkan mengakses API ini.`;
  } else {
    const db = fromDatabase(error.cause ?? error);
    if (db) ({ statusCode, code, message, errors } = db);
  }

  if (statusCode >= 500 && !code && !trusted) {
    code = 'INTERNAL_ERROR';
    message = 'Terjadi kesalahan pada server. Coba lagi; bila masih gagal, hubungi admin dengan menyertakan kode referensi.';
  }
  if (!message) message = 'Terjadi kesalahan.';

  // Galat bisnis (4xx) cukup level warn; sisanya error lengkap dengan stack
  if (statusCode < 500) request.log.warn({ code, statusCode, err: { message: error.message, code: error.code } }, message);
  else request.log.error({ err: error, code }, 'request gagal');

  if (statusCode === 429 && error.headers) reply.headers(error.headers);
  return reply.status(statusCode).send(errorBody(request, statusCode, message, { code, errors }));
};

/** 404 untuk rute yang tidak ada, dengan bentuk body yang sama. */
export const notFoundHandler = (request, reply) =>
  reply.status(404).send(errorBody(request, 404, `Endpoint ${request.method} ${request.url.split('?')[0]} tidak ditemukan.`, { code: 'ROUTE_NOT_FOUND' }));
