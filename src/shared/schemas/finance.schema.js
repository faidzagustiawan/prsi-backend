// src/shared/schemas/finance.schema.js
//
// Semua tabel SI berada di schema `finance`. Tabel Track (schema public) TIDAK
// didefinisikan di sini dan tidak boleh di-import: data Track hanya dibaca lewat
// fungsi finance.track_* (lihat modules/track).
//
// Kolom yang menyimpan ID dari Track (company_id, unit_id, ...) sengaja tanpa
// foreign key ke public. Validasi dilakukan di aplikasi.
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

// Role aplikasi SI, terpisah dari role Track.
// Daftar final menunggu detail cakupan modul keuangan.
export const SI_ROLES = ['super_admin', 'finance_admin', 'finance_staff', 'viewer'];

export const siRoleEnum = finance.enum('si_role', SI_ROLES);
export const userStatusEnum = finance.enum('user_status', ['active', 'inactive']);

export const users = finance.table('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  // ID perusahaan dari Track (public.companies.id). Null = lintas perusahaan (super_admin).
  companyId: uuid('company_id'),
  nama: varchar('nama', { length: 255 }).notNull(),
  // Disimpan lowercase oleh service
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: siRoleEnum('role').notNull(),
  status: userStatusEnum('status').notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('users_company_idx').on(table.companyId),
]);

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

// Jejak audit wajib untuk sistem keuangan: siapa mengubah apa, kapan.
export const auditLogs = finance.table('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  companyId: uuid('company_id'),
  action: varchar('action', { length: 100 }).notNull(),
  entity: varchar('entity', { length: 100 }).notNull(),
  entityId: varchar('entity_id', { length: 100 }),
  summary: text('summary'),
  metadata: jsonb('metadata').default({}),
  ipAddress: varchar('ip_address', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('audit_entity_idx').on(table.entity, table.entityId),
  index('audit_company_created_idx').on(table.companyId, table.createdAt),
]);
