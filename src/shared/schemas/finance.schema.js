// src/shared/schemas/finance.schema.js
//
// Semua tabel SI berada di schema `finance` milik database SI sendiri (VPS SI).
// Database Track terpisah di server lain; data Track masuk hanya lewat worker
// sinkronisasi ke tabel cermin trk_* (lihat track.schema.js).
//
// Kolom pilihan tetap disimpan sebagai VARCHAR dan divalidasi di aplikasi
// (sesuai ERD 02/10/2026). Daftar nilainya ada di shared/constants.js.
import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const finance = pgSchema('finance');

export const users = finance.table('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  // Sisa rancangan database bersama, tidak dipakai lagi. Dibiarkan supaya
  // migrasi tetap aditif.
  companyId: uuid('company_id'),
  nama: varchar('nama', { length: 255 }).notNull(),
  // Disimpan lowercase oleh service
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: varchar('role', { length: 20 }).notNull(),
  status: varchar('status', { length: 10 }).notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const refreshTokens = finance.table('refresh_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('rt_user_idx').on(table.userId),
]);

// Jejak audit: satu baris per aksi, atau per kolom yang berubah (field,
// nilai_lama, nilai_baru) untuk riwayat seperti riwayat akun di COA.
export const auditLogs = finance.table('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  companyId: uuid('company_id'),
  action: varchar('action', { length: 100 }).notNull(),
  entity: varchar('entity', { length: 100 }).notNull(),
  entityId: varchar('entity_id', { length: 100 }),
  field: varchar('field', { length: 60 }),
  nilaiLama: text('nilai_lama'),
  nilaiBaru: text('nilai_baru'),
  summary: text('summary'),
  metadata: jsonb('metadata').default({}),
  ipAddress: varchar('ip_address', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('audit_entity_idx').on(table.entity, table.entityId),
  index('audit_company_created_idx').on(table.companyId, table.createdAt),
]);
