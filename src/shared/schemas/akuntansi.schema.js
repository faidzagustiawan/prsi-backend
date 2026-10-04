// src/shared/schemas/akuntansi.schema.js
//
// Master keuangan dan jurnal. Jurnal adalah sumber tunggal angka akuntansi:
// saldo, buku besar, dan laporan dihitung dari saldo_awal + jurnal_detail yang
// diposting. Tidak ada tabel saldo.
import {
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  date,
  numeric,
  integer,
  smallint,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { finance, users } from './finance.schema.js';
import { trkCompanies, trkProjects, trkCustomers } from './track.schema.js';

const money = (name) => numeric(name, { precision: 18, scale: 2 });

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Badan hukum PT untuk dokumen legal dan tutup buku. Milik SI.
// proyekId = perumahan tempat PT ini terikat (satu PT, satu perumahan).
export const masterPt = finance.table('master_pt', {
  id: uuid('id').defaultRandom().primaryKey(),
  trackCompanyId: uuid('track_company_id').references(() => trkCompanies.id),
  proyekId: uuid('proyek_id').references(() => trkProjects.id).unique(),
  namaPt: varchar('nama_pt', { length: 150 }).notNull(),
  singkatan: varchar('singkatan', { length: 20 }),
  namaDirektur: varchar('nama_direktur', { length: 150 }).notNull(),
  ttl: varchar('ttl', { length: 150 }),
  pekerjaan: varchar('pekerjaan', { length: 100 }),
  alamat: text('alamat'),
  noKtp: varchar('no_ktp', { length: 16 }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps(),
});

export const akun = finance.table('akun', {
  id: uuid('id').defaultRandom().primaryKey(),
  kode: varchar('kode', { length: 10 }).notNull().unique(),
  nama: varchar('nama', { length: 150 }).notNull(),
  indukId: uuid('induk_id').references(() => akun.id),
  kategori: varchar('kategori', { length: 12 }).notNull(),
  tipeSaldo: varchar('tipe_saldo', { length: 1 }).notNull(),
  klasifikasi: varchar('klasifikasi', { length: 10 }).notNull(),
  kategoriHutangPiutang: varchar('kategori_hutang_piutang', { length: 20 }),
  wajibKodePembantu: boolean('wajib_kode_pembantu').notNull().default(false),
  wajibProyek: boolean('wajib_proyek').notNull().default(false),
  isKasBank: boolean('is_kas_bank').notNull().default(false),
  noRekening: varchar('no_rekening', { length: 30 }),
  aktif: boolean('aktif').notNull().default(true),
  ...timestamps(),
}, (t) => [index('akun_induk_idx').on(t.indukId)]);

export const kodePembantu = finance.table('kode_pembantu', {
  id: uuid('id').defaultRandom().primaryKey(),
  kode: varchar('kode', { length: 20 }).notNull().unique(),
  nama: varchar('nama', { length: 150 }).notNull(),
  kategori: varchar('kategori', { length: 20 }).notNull(),
  proyekId: uuid('proyek_id').references(() => trkProjects.id),
  customerId: uuid('customer_id').references(() => trkCustomers.id),
  aktif: boolean('aktif').notNull().default(true),
  ...timestamps(),
}, (t) => [index('kode_pembantu_proyek_idx').on(t.proyekId)]);

// Kunci bulanan per PT (Alur 6). Baris yang belum ada = periode terbuka.
export const periode = finance.table('periode', {
  id: uuid('id').defaultRandom().primaryKey(),
  ptId: uuid('pt_id').references(() => masterPt.id).notNull(),
  tahun: smallint('tahun').notNull(),
  bulan: smallint('bulan').notNull(),
  status: varchar('status', { length: 10 }).notNull().default('terbuka'),
  ditutupOleh: uuid('ditutup_oleh').references(() => users.id),
  ditutupPada: timestamp('ditutup_pada', { withTimezone: true }),
  ...timestamps(),
}, (t) => [uniqueIndex('periode_pt_bulan_uq').on(t.ptId, t.tahun, t.bulan)]);

// Saldo awal per proyek: satu set per proyek, dikunci sekali saat mulai pakai SI.
export const saldoAwalPeriode = finance.table('saldo_awal_periode', {
  id: uuid('id').defaultRandom().primaryKey(),
  proyekId: uuid('proyek_id').references(() => trkProjects.id).notNull().unique(),
  tanggalMulai: date('tanggal_mulai').notNull(),
  status: varchar('status', { length: 10 }).notNull().default('terbuka'),
  dikunciOleh: uuid('dikunci_oleh').references(() => users.id),
  dikunciPada: timestamp('dikunci_pada', { withTimezone: true }),
  ...timestamps(),
});

export const saldoAwal = finance.table('saldo_awal', {
  id: uuid('id').defaultRandom().primaryKey(),
  periodeId: uuid('periode_id').references(() => saldoAwalPeriode.id, { onDelete: 'cascade' }).notNull(),
  akunId: uuid('akun_id').references(() => akun.id).notNull(),
  kodePembantuId: uuid('kode_pembantu_id').references(() => kodePembantu.id),
  debit: money('debit').notNull().default('0'),
  kredit: money('kredit').notNull().default('0'),
  ...timestamps(),
}, (t) => [index('saldo_awal_periode_idx').on(t.periodeId)]);

// Nomor urut per jenis dokumen. scope = kunci gabungan (mis. kode proyek),
// tidak pernah NULL supaya unique index berlaku.
export const penomoran = finance.table('penomoran', {
  id: uuid('id').defaultRandom().primaryKey(),
  jenis: varchar('jenis', { length: 20 }).notNull(),
  scope: varchar('scope', { length: 60 }).notNull().default(''),
  tahun: smallint('tahun').notNull(),
  bulan: smallint('bulan').notNull().default(0),
  nomorTerakhir: integer('nomor_terakhir').notNull().default(0),
}, (t) => [uniqueIndex('penomoran_uq').on(t.jenis, t.scope, t.tahun, t.bulan)]);

export const jurnal = finance.table('jurnal', {
  id: uuid('id').defaultRandom().primaryKey(),
  noBukti: varchar('no_bukti', { length: 40 }).notNull().unique(),
  tanggal: date('tanggal').notNull(),
  uraian: text('uraian').notNull(),
  proyekId: uuid('proyek_id').references(() => trkProjects.id),
  ptId: uuid('pt_id').references(() => masterPt.id),
  status: varchar('status', { length: 12 }).notNull(),
  sumber: varchar('sumber', { length: 20 }).notNull(),
  refType: varchar('ref_type', { length: 40 }),
  refId: uuid('ref_id'),
  // Jurnal antar proyek: dua jurnal saling menunjuk
  mirrorId: uuid('mirror_id').references(() => jurnal.id),
  // Diisi pada jurnal asal yang dikoreksi lewat jurnal balik
  dibalikOlehId: uuid('dibalik_oleh_id').references(() => jurnal.id),
  dibuatOleh: uuid('dibuat_oleh').references(() => users.id),
  dipostingOleh: uuid('diposting_oleh').references(() => users.id),
  dipostingPada: timestamp('diposting_pada', { withTimezone: true }),
  ...timestamps(),
}, (t) => [
  index('jurnal_tanggal_idx').on(t.tanggal),
  index('jurnal_proyek_idx').on(t.proyekId),
  index('jurnal_ref_idx').on(t.refType, t.refId),
]);

export const jurnalDetail = finance.table('jurnal_detail', {
  id: uuid('id').defaultRandom().primaryKey(),
  jurnalId: uuid('jurnal_id').references(() => jurnal.id, { onDelete: 'cascade' }).notNull(),
  urutan: smallint('urutan').notNull(),
  akunId: uuid('akun_id').references(() => akun.id).notNull(),
  kodePembantuId: uuid('kode_pembantu_id').references(() => kodePembantu.id),
  keterangan: varchar('keterangan', { length: 255 }),
  debit: money('debit').notNull().default('0'),
  kredit: money('kredit').notNull().default('0'),
}, (t) => [
  index('jurnal_detail_jurnal_idx').on(t.jurnalId),
  index('jurnal_detail_akun_idx').on(t.akunId),
  index('jurnal_detail_kp_idx').on(t.kodePembantuId),
]);

// Lampiran polimorfik (jurnal, kontrak, dokumen legal, ...). Berkas disimpan di
// disk server SI; path relatif terhadap UPLOAD_DIR.
export const lampiran = finance.table('lampiran', {
  id: uuid('id').defaultRandom().primaryKey(),
  entityType: varchar('entity_type', { length: 40 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  namaFile: varchar('nama_file', { length: 255 }).notNull(),
  path: varchar('path', { length: 255 }).notNull(),
  mime: varchar('mime', { length: 50 }).notNull(),
  ukuran: integer('ukuran').notNull(),
  // unggah, pr_track
  sumber: varchar('sumber', { length: 10 }).notNull().default('unggah'),
  diunggahOleh: uuid('diunggah_oleh').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('lampiran_entity_idx').on(t.entityType, t.entityId)]);
