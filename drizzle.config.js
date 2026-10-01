import dotenv from 'dotenv';
dotenv.config();

// Migrasi SI hanya boleh menyentuh schema `finance`.
// - schemaFilter membuat drizzle-kit tidak pernah membaca/membandingkan tabel Track (public).
// - Koneksi memakai role si_migrator, yang tidak punya hak DDL/DML di public,
//   jadi kesalahan konfigurasi pun ditolak oleh Postgres.
// - Jangan pakai `drizzle-kit push` ke production. Gunakan generate -> check -> migrate.
if (!process.env.SI_MIGRATOR_DATABASE_URL) {
  throw new Error('SI_MIGRATOR_DATABASE_URL is missing in environment');
}

export default {
  schema: './src/shared/schemas/finance.schema.js',
  out: './drizzle',
  dialect: 'postgresql',
  schemaFilter: ['finance'],
  migrations: {
    schema: 'finance',
    table: '__drizzle_migrations',
  },
  dbCredentials: {
    url: process.env.SI_MIGRATOR_DATABASE_URL,
  },
  strict: true,
  verbose: true,
};
