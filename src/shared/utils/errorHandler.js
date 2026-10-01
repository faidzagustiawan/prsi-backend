// src/shared/utils/errorHandler.js

const validationMessage = (err) => {
  const rawPath = err.instancePath || '';
  const field = rawPath ? rawPath.replace(/^\//, '') : (err.params?.missingProperty || 'Input');

  if (err.keyword === 'required') return `Kolom '${field}' wajib diisi.`;
  if (err.keyword === 'minLength') return `Kolom '${field}' minimal ${err.params.limit} karakter.`;
  if (err.keyword === 'format' && err.params.format === 'email') return `Format email pada '${field}' tidak valid.`;
  if (err.keyword === 'enum') return `Pilihan untuk '${field}' tidak valid.`;
  return err.message;
};

/** Pesan error ramah pengguna (Bahasa Indonesia), tanpa membocorkan detail internal. */
export const globalErrorHandler = (error, request, reply) => {
  request.server.log.error(error);

  let statusCode = error.statusCode || 500;
  let message = !error.statusCode
    ? 'Terjadi kesalahan pada server.'
    : (error.message || 'Terjadi kesalahan.');
  let errors = [];

  if (error.validation) {
    statusCode = 400;
    errors = error.validation.map(validationMessage);
    message = errors.length === 1 ? errors[0] : 'Data yang Anda masukkan tidak valid.';
  }

  // PostgreSQL error codes
  if (error.code === '23505') {
    statusCode = 400;
    message = 'Data tersebut sudah terdaftar di sistem.';
  } else if (error.code === '23503') {
    statusCode = 400;
    message = 'Tindakan tidak dapat dilakukan karena data ini masih terhubung dengan data lain.';
  } else if (error.code === '42501') {
    // insufficient_privilege: role SI mencoba menyentuh objek di luar haknya
    statusCode = 500;
    message = 'Terjadi kesalahan pada server.';
  }

  if (
    error.code === 'FST_JWT_NO_AUTHORIZATION_IN_HEADER' ||
    error.code === 'FST_JWT_AUTHORIZATION_TOKEN_INVALID'
  ) {
    statusCode = 401;
    message = 'Akses ditolak. Anda belum login atau token tidak valid.';
  } else if (error.code === 'FAST_JWT_EXPIRED') {
    statusCode = 401;
    message = 'Sesi Anda telah berakhir. Silakan login kembali.';
  }

  return reply.status(statusCode).send({ success: false, message, errors });
};
