// src/shared/schemas/penjualan.schema.js
//
// Legal (pustaka pasal, template, dokumen SPPR) dan piutang penjualan.
// Penjualan sendiri milik PR Track (trk_assignments); SI menyimpan atribut
// keuangannya di penjualan_keuangan (1:1) dan jadwal angsuran yang dikirim ke
// Track lewat outbox_track.
import {
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  date,
  numeric,
  smallint,
  integer,
  jsonb,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { finance, users } from './finance.schema.js';
import { trkUnits, trkAssignments, trkPayments } from './track.schema.js';
import { masterPt, jurnal } from './akuntansi.schema.js';

const money = (name) => numeric(name, { precision: 18, scale: 2 });

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Pustaka pasal. isi memakai placeholder {key}; fields = isian yang bisa
// diubah per dokumen: [{ id, key, label, tipe }]
export const pasal = finance.table('pasal', {
  id: uuid('id').defaultRandom().primaryKey(),
  judul: varchar('judul', { length: 150 }).notNull(),
  isi: text('isi').notNull(),
  // semua, cash, kpr, in_house
  berlakuUntuk: varchar('berlaku_untuk', { length: 20 }).notNull().default('semua'),
  ptId: uuid('pt_id').references(() => masterPt.id),
  fields: jsonb('fields').notNull().default([]),
  aktif: boolean('aktif').notNull().default(true),
  ...timestamps(),
});

export const templateDokumen = finance.table('template_dokumen', {
  id: uuid('id').defaultRandom().primaryKey(),
  ptId: uuid('pt_id').references(() => masterPt.id).notNull(),
  jenis: varchar('jenis', { length: 20 }).notNull().default('SPPR'),
  // cash, kpr, in_house
  tipeTransaksi: varchar('tipe_transaksi', { length: 10 }).notNull(),
  nama: varchar('nama', { length: 100 }),
  // Token: {PT} singkatan PT, {TAHUN}, {BULAN}, {TIPE}, {NO}
  polaNomor: varchar('pola_nomor', { length: 60 }).notNull(),
  aktif: boolean('aktif').notNull().default(true),
  ...timestamps(),
});

export const templatePasal = finance.table('template_pasal', {
  templateId: uuid('template_id').references(() => templateDokumen.id, { onDelete: 'cascade' }).notNull(),
  pasalId: uuid('pasal_id').references(() => pasal.id).notNull(),
  urutan: smallint('urutan').notNull(),
}, (t) => [primaryKey({ columns: [t.templateId, t.pasalId] })]);

export const dokumen = finance.table('dokumen', {
  id: uuid('id').defaultRandom().primaryKey(),
  noDokumen: varchar('no_dokumen', { length: 60 }).notNull().unique(),
  ptId: uuid('pt_id').references(() => masterPt.id).notNull(),
  unitId: uuid('unit_id').references(() => trkUnits.id).notNull(),
  // Penjualan di PR Track; wajib saat finalisasi
  assignmentId: uuid('assignment_id').references(() => trkAssignments.id),
  templateId: uuid('template_id').references(() => templateDokumen.id),
  tipeTransaksi: varchar('tipe_transaksi', { length: 10 }).notNull(),
  tanggal: date('tanggal').notNull(),
  // draft, final, ditandatangani
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  // Dokumen asal untuk adendum
  indukId: uuid('induk_id').references(() => dokumen.id),
  // Salinan data pihak dan harga saat dokumen dibuat (ERD): pembeli, hargaAwal,
  // bphtb, ajbBbn, uangMuka, fasilitasTambahan
  data: jsonb('data').notNull(),
  // Rencana jadwal DP selama draft; dipindah ke jadwal_angsuran saat final
  jadwal: jsonb('jadwal'),
  difinalkanOleh: uuid('difinalkan_oleh').references(() => users.id),
  difinalkanPada: timestamp('difinalkan_pada', { withTimezone: true }),
  ...timestamps(),
}, (t) => [index('dokumen_assignment_idx').on(t.assignmentId)]);

export const dokumenPasal = finance.table('dokumen_pasal', {
  id: uuid('id').defaultRandom().primaryKey(),
  dokumenId: uuid('dokumen_id').references(() => dokumen.id, { onDelete: 'cascade' }).notNull(),
  pustakaId: uuid('pustaka_id').references(() => pasal.id),
  urutan: smallint('urutan').notNull(),
  judul: varchar('judul', { length: 150 }).notNull(),
  teks: text('teks').notNull(),
  // [{ id, key, label, tipe, nilai }]
  nilaiField: jsonb('nilai_field').notNull().default([]),
}, (t) => [index('dokumen_pasal_dokumen_idx').on(t.dokumenId)]);

// Atribut keuangan penjualan (1:1 dengan trk_assignments)
export const penjualanKeuangan = finance.table('penjualan_keuangan', {
  id: uuid('id').defaultRandom().primaryKey(),
  assignmentId: uuid('assignment_id').references(() => trkAssignments.id).notNull().unique(),
  // SPPR yang berlaku sekarang
  dokumenId: uuid('dokumen_id').references(() => dokumen.id),
  nilaiSppr: money('nilai_sppr').notNull(),
  // aktif, batal
  status: varchar('status', { length: 10 }).notNull().default('aktif'),
  tanggalBast: date('tanggal_bast'),
  jurnalBastId: uuid('jurnal_bast_id').references(() => jurnal.id),
  tanggalBatal: date('tanggal_batal'),
  nominalPotongan: money('nominal_potongan'),
  alasanBatal: text('alasan_batal'),
  jurnalBatalId: uuid('jurnal_batal_id').references(() => jurnal.id),
  nilaiCashbackKpr: money('nilai_cashback_kpr'),
  nilaiAdminKpr: money('nilai_admin_kpr'),
  ...timestamps(),
});

export const jadwalAngsuran = finance.table('jadwal_angsuran', {
  id: uuid('id').defaultRandom().primaryKey(),
  penjualanId: uuid('penjualan_id').references(() => penjualanKeuangan.id).notNull(),
  assignmentId: uuid('assignment_id').references(() => trkAssignments.id).notNull(),
  dokumenId: uuid('dokumen_id').references(() => dokumen.id).notNull(),
  noUrut: smallint('no_urut').notNull(),
  tanggal: date('tanggal').notNull(),
  jumlah: money('jumlah').notNull(),
  keterangan: varchar('keterangan', { length: 100 }),
  // false bila diganti jadwal dari adendum
  aktif: boolean('aktif').notNull().default(true),
  // Terisi setelah diterima Track
  trackId: uuid('track_id').unique(),
  ...timestamps(),
}, (t) => [index('jadwal_penjualan_idx').on(t.penjualanId)]);

// Pembagian pembayaran Track ke jadwal. jadwal_id kosong = di luar jadwal
// (booking fee, lebih bayar).
export const alokasiPembayaran = finance.table('alokasi_pembayaran', {
  id: uuid('id').defaultRandom().primaryKey(),
  paymentId: uuid('payment_id').references(() => trkPayments.id).notNull(),
  penjualanId: uuid('penjualan_id').references(() => penjualanKeuangan.id).notNull(),
  jadwalId: uuid('jadwal_id').references(() => jadwalAngsuran.id),
  nominal: money('nominal').notNull(),
  manual: boolean('manual').notNull().default(false),
  diubahOleh: uuid('diubah_oleh').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('alokasi_payment_idx').on(t.paymentId),
  index('alokasi_penjualan_idx').on(t.penjualanId),
]);

// Antrean kiriman SI ke Track (docs/RancanganSistem.md bagian 6). Ditulis di
// transaksi yang sama dengan perubahan bisnisnya; dikirim worker.
export const outboxTrack = finance.table('outbox_track', {
  id: uuid('id').defaultRandom().primaryKey(),
  // jadwal_angsuran, kunci_pembayaran
  jenis: varchar('jenis', { length: 30 }).notNull(),
  refId: uuid('ref_id').notNull(),
  payload: jsonb('payload').notNull(),
  // tertunda, terkirim, gagal
  status: varchar('status', { length: 10 }).notNull().default('tertunda'),
  percobaan: integer('percobaan').notNull().default(0),
  galatTerakhir: text('galat_terakhir'),
  dikirimPada: timestamp('dikirim_pada', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('outbox_status_idx').on(t.status)]);
