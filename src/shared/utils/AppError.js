// src/shared/utils/AppError.js

/** Error aplikasi dengan HTTP status code. `errors` = daftar pesan rinci (opsional). */
export class AppError extends Error {
  constructor(message, statusCode = 400, errors = []) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}
