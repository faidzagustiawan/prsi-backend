// src/shared/schemas/track.schema.js
//
// Cermin data PR Track (docs/RancanganSistem.md bagian 5).
// - Hanya worker sinkronisasi yang menulis tabel trk_*; aplikasi SI hanya membaca.
// - track_id = UUID baris di Track. Relasi di dalam SI memakai id lokal.
// - row_version menolak event lama/duplikat; baris yang dihapus di Track
//   ditandai is_deleted, tidak dihapus dari SI.
// - Kolom milik SI untuk pembayaran ada di status_pembayaran_si, bukan di cermin.
import {
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  bigint,
  boolean,
  date,
  numeric,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { finance } from './finance.schema.js';

const money = (name) => numeric(name, { precision: 18, scale: 2 });

const mirrorColumns = () => ({
  id: uuid('id').defaultRandom().primaryKey(),
  trackId: uuid('track_id').notNull().unique(),
  rowVersion: bigint('row_version', { mode: 'number' }).notNull().default(0),
  trackSeq: bigint('track_seq', { mode: 'number' }),
  isDeleted: boolean('is_deleted').notNull().default(false),
  raw: jsonb('raw'),
  syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow().notNull(),
});

export const trkCompanies = finance.table('trk_companies', {
  ...mirrorColumns(),
  nama: varchar('nama', { length: 255 }).notNull(),
  kode: varchar('kode', { length: 50 }),
  alamat: text('alamat'),
});

export const trkProjects = finance.table('trk_projects', {
  ...mirrorColumns(),
  companyId: uuid('company_id').references(() => trkCompanies.id),
  kode: varchar('kode', { length: 20 }),
  nama: varchar('nama', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }),
}, (t) => [index('trk_projects_company_idx').on(t.companyId)]);

export const trkClusters = finance.table('trk_clusters', {
  ...mirrorColumns(),
  projectId: uuid('project_id').references(() => trkProjects.id).notNull(),
  nama: varchar('nama', { length: 255 }).notNull(),
}, (t) => [index('trk_clusters_project_idx').on(t.projectId)]);

export const trkUnits = finance.table('trk_units', {
  ...mirrorColumns(),
  clusterId: uuid('cluster_id').references(() => trkClusters.id).notNull(),
  // Diturunkan dari cluster supaya filter per proyek tidak perlu join
  projectId: uuid('project_id').references(() => trkProjects.id).notNull(),
  kode: varchar('kode', { length: 50 }).notNull(),
  tipe: varchar('tipe', { length: 50 }),
  luasTanah: numeric('luas_tanah', { precision: 10, scale: 2 }),
  luasBangunan: numeric('luas_bangunan', { precision: 10, scale: 2 }),
  status: varchar('status', { length: 50 }),
}, (t) => [index('trk_units_project_idx').on(t.projectId)]);

export const trkCustomers = finance.table('trk_customers', {
  ...mirrorColumns(),
  nama: varchar('nama', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  noHp: varchar('no_hp', { length: 20 }),
  tempatLahir: varchar('tempat_lahir', { length: 100 }),
  tanggalLahir: date('tanggal_lahir'),
  pekerjaan: varchar('pekerjaan', { length: 100 }),
  alamat: text('alamat'),
  noKtp: varchar('no_ktp', { length: 16 }),
});

export const trkAssignments = finance.table('trk_assignments', {
  ...mirrorColumns(),
  unitId: uuid('unit_id').references(() => trkUnits.id).notNull(),
  customerId: uuid('customer_id').references(() => trkCustomers.id).notNull(),
  // Nilai asli Track: cash_lunas, cash_cicil, kredit_kpr
  tipePembayaran: varchar('tipe_pembayaran', { length: 50 }),
  harga: money('harga'),
  uangMuka: money('uang_muka'),
  status: varchar('status', { length: 50 }),
  tanggal: timestamp('tanggal', { withTimezone: true }),
}, (t) => [
  index('trk_assignments_unit_idx').on(t.unitId),
  index('trk_assignments_customer_idx').on(t.customerId),
]);

export const trkPayments = finance.table('trk_payments', {
  ...mirrorColumns(),
  assignmentId: uuid('assignment_id').references(() => trkAssignments.id).notNull(),
  tanggal: date('tanggal').notNull(),
  nominal: money('nominal').notNull(),
  jenis: varchar('jenis', { length: 20 }),
  statusVerifikasi: varchar('status_verifikasi', { length: 20 }),
  diverifikasiOleh: varchar('diverifikasi_oleh', { length: 150 }),
  diverifikasiPada: timestamp('diverifikasi_pada', { withTimezone: true }),
  rekeningTujuan: varchar('rekening_tujuan', { length: 30 }),
  buktiUrl: text('bukti_url'),
  catatan: text('catatan'),
  isAutoInject: boolean('is_auto_inject').notNull().default(false),
  sourceCreatedAt: timestamp('source_created_at', { withTimezone: true }),
}, (t) => [index('trk_payments_assignment_idx').on(t.assignmentId)]);

// Status pemrosesan pembayaran di SI (Alur 2). 1:1 dengan trk_payments.
export const statusPembayaranSi = finance.table('status_pembayaran_si', {
  paymentId: uuid('payment_id').primaryKey().references(() => trkPayments.id),
  // menunggu, dijurnal, gagal_validasi, perlu_ditinjau
  statusProses: varchar('status_proses', { length: 20 }).notNull(),
  jurnalId: uuid('jurnal_id'),
  alasan: text('alasan'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const syncCursor = finance.table('sync_cursor', {
  id: varchar('id', { length: 20 }).primaryKey(),
  cursorSeq: bigint('cursor_seq', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const syncLog = finance.table('sync_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  entitas: varchar('entitas', { length: 30 }).notNull(),
  // tarik, kirim, rekonsiliasi
  arah: varchar('arah', { length: 15 }).notNull(),
  mulai: timestamp('mulai', { withTimezone: true }).notNull(),
  selesai: timestamp('selesai', { withTimezone: true }),
  jmlBaru: integer('jml_baru').notNull().default(0),
  jmlUbah: integer('jml_ubah').notNull().default(0),
  jmlGagal: integer('jml_gagal').notNull().default(0),
  status: varchar('status', { length: 10 }).notNull(),
  pesan: text('pesan'),
});

export const syncError = finance.table('sync_error', {
  id: uuid('id').defaultRandom().primaryKey(),
  seq: bigint('seq', { mode: 'number' }),
  entity: varchar('entity', { length: 30 }).notNull(),
  entityTrackId: uuid('entity_track_id'),
  alasan: text('alasan').notNull(),
  payload: jsonb('payload'),
  percobaan: integer('percobaan').notNull().default(1),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
