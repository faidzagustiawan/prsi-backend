// src/config/env.js
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

const required = ['DATABASE_URL', 'JWT_SECRET', 'COOKIE_SECRET'];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`${key} is missing in environment`);
  }
}

// Secret pendek mudah ditebak; secret yang sama dengan Track membuat token
// kedua aplikasi bisa saling dipakai. Panjang minimum memaksa secret dibuat baru.
for (const key of ['JWT_SECRET', 'COOKIE_SECRET']) {
  if (process.env[key].length < 32) {
    throw new Error(`${key} minimal 32 karakter`);
  }
}

if (process.env.JWT_SECRET === process.env.COOKIE_SECRET) {
  throw new Error('JWT_SECRET dan COOKIE_SECRET tidak boleh sama');
}

export const env = {
  nodeEnv: process.env.NODE_ENV,
  isDevelopment: process.env.NODE_ENV === 'development',
  port: parseInt(process.env.PORT, 10) || 3100,
  host: process.env.HOST || '127.0.0.1',
  databaseUrl: process.env.DATABASE_URL,
  reportDatabaseUrl: process.env.REPORT_DATABASE_URL || process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  cookieSecret: process.env.COOKIE_SECRET,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  frontendUrls: process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',')
    : ['http://localhost:5174'],
  apiUrl: process.env.API_URL || 'http://localhost:3100',
  // Berkas lampiran (bukti transfer, nota). Di VPS arahkan ke disk yang di-backup.
  uploadDir: path.resolve(process.env.UPLOAD_DIR || './storage/lampiran'),
  allowUnsafeDbRole:
    process.env.NODE_ENV === 'development' && process.env.ALLOW_UNSAFE_DB_ROLE === 'true',
};

// Identitas token SI. Token dari Track (tanpa audience ini) ditolak walaupun
// secret-nya kebetulan sama.
export const JWT_AUDIENCE = 'podorukun-si';
export const JWT_ISSUER = 'podorukun-si-api';
