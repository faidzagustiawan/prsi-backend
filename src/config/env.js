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
  // Session pooler / koneksi langsung, untuk advisory lock worker. Kosong = DATABASE_URL
  // (aman hanya bila DATABASE_URL bukan transaction pooler).
  sessionDatabaseUrl: process.env.SESSION_DATABASE_URL || process.env.DATABASE_URL,
  dbPoolMax: parseInt(process.env.DB_POOL_MAX, 10) || 5,
  jwtSecret: process.env.JWT_SECRET,
  cookieSecret: process.env.COOKIE_SECRET,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  frontendUrls: process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',')
    : ['http://localhost:5174'],
  corsAllowAll: process.env.CORS_ALLOW_ALL === 'true',
  apiUrl: process.env.API_URL || 'http://localhost:3100',
  // Berkas lampiran (bukti transfer, nota). Di VPS arahkan ke disk yang di-backup.
  uploadDir: path.resolve(process.env.UPLOAD_DIR || './storage/lampiran'),
  // Sinkronisasi PR Track (docs/RancanganSistem.md bagian 5-7)
  sync: {
    // Saklar utama: false = worker tidak menghubungi Track sama sekali
    enabled: process.env.SYNC_ENABLED === 'true',
    // Fase pilot wajib false: tarik Track -> SI tanpa PUT kembali ke Track
    writeEnabled: process.env.SYNC_WRITE_ENABLED === 'true',
    trackApiUrl: process.env.TRACK_API_URL || '',
    readToken: process.env.TRACK_SYNC_TOKEN || '',
    scheduleToken: process.env.TRACK_SCHEDULE_TOKEN || '',
    // v2 = cursor urutan commit (docs/TrackSyncAPI.md bagian 3.1). v1 hanya untuk Track lama.
    protocol: process.env.SYNC_PROTOCOL === 'v2' ? 'v2' : 'v1',
    intervalSec: parseInt(process.env.SYNC_INTERVAL_SEC, 10) || 120,
    // Putaran berikutnya lebih cepat selama masih ada event (backlog atau aktivitas ramai)
    busyIntervalSec: parseInt(process.env.SYNC_BUSY_INTERVAL_SEC, 10) || 10,
    // v2: peringatan bila event tertahan transaksi Track yang terbuka selama ini
    heldWarnSec: parseInt(process.env.SYNC_HELD_WARN_SEC, 10) || 300,
    pageSize: parseInt(process.env.SYNC_PAGE_SIZE, 10) || 500,
    gapTimeoutSec: parseInt(process.env.SYNC_GAP_TIMEOUT_SEC, 10) || 600,
    // Jam rekonsiliasi harian (waktu server)
    reconcileHour: parseInt(process.env.SYNC_RECONCILE_HOUR, 10) || 2,
  },
  allowUnsafeDbRole:
    process.env.NODE_ENV === 'development' && process.env.ALLOW_UNSAFE_DB_ROLE === 'true',
};

// Identitas token SI. Token dari Track (tanpa audience ini) ditolak walaupun
// secret-nya kebetulan sama.
export const JWT_AUDIENCE = 'podorukun-si';
export const JWT_ISSUER = 'podorukun-si-api';
