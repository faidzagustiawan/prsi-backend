// src/shared/schemas/hutang.schema.js
//
// Modul hutang: pinjaman bank, kontrak kontraktor, dan dokumen legal kavling
// (SHM/PBG). Setiap gerak uang punya jurnal_id; saldo (sisa pokok, sisa hutang
// kontraktor) dihitung dari jurnal yang terbuku, tidak disimpan di sini.
import {
  uuid,
  varchar,
  text,
  timestamp,
  date,
  numeric,
  smallint,
  index,
} from 'drizzle-orm/pg-core';
import { finance, users } from './finance.schema.js';
import { trkProjects, trkUnits } from './track.schema.js';
import { akun, kodePembantu, jurnal } from './akuntansi.schema.js';

const money = (name) => numeric(name, { precision: 18, scale: 2 });

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const pinjaman = finance.table('pinjaman', {
  id: uuid('id').defaultRandom().primaryKey(),
  proyekId: uuid('proyek_id').references(() => trkProjects.id).notNull(),
  // Pihak bank (kode pembantu kategori bank)
  kodePembantuId: uuid('kode_pembantu_id').references(() => kodePembantu.id).notNull(),
  noAkad: varchar('no_akad', { length: 50 }),
  // terpisah, satu_transfer, bunga_rutin, fleksibel
  pola: varchar('pola', { length: 15 }).notNull(),
  tanggalAcuanBunga: smallint('tanggal_acuan_bunga').notNull(),
  jatuhTempoPokok: date('jatuh_tempo_pokok').notNull(),
  akunHutangId: uuid('akun_hutang_id').references(() => akun.id).notNull(),
  akunBebanBungaId: uuid('akun_beban_bunga_id').references(() => akun.id).notNull(),
  keterangan: text('keterangan'),
  ...timestamps(),
}, (t) => [index('pinjaman_proyek_idx').on(t.proyekId)]);

// Satu baris per pencairan, top up, atau pembayaran. Pencairan awal = baris
// jenis 'pencairan' pertama.
export const pinjamanTransaksi = finance.table('pinjaman_transaksi', {
  id: uuid('id').defaultRandom().primaryKey(),
  pinjamanId: uuid('pinjaman_id').references(() => pinjaman.id).notNull(),
  // pencairan, top_up, pokok, bunga, gabungan
  jenis: varchar('jenis', { length: 10 }).notNull(),
  tanggal: date('tanggal').notNull(),
  nominal: money('nominal').notNull(),
  nominalPokok: money('nominal_pokok'),
  nominalBunga: money('nominal_bunga'),
  periodeBunga: varchar('periode_bunga', { length: 30 }),
  noBukti: varchar('no_bukti', { length: 60 }),
  akunKasId: uuid('akun_kas_id').references(() => akun.id).notNull(),
  keterangan: text('keterangan'),
  // lengkap, menunggu_rincian (satu transfer yang porsi pokok/bunganya belum diketahui)
  statusRincian: varchar('status_rincian', { length: 20 }).notNull().default('lengkap'),
  jurnalId: uuid('jurnal_id').references(() => jurnal.id),
  dibuatOleh: uuid('dibuat_oleh').references(() => users.id),
  ...timestamps(),
}, (t) => [index('pinjaman_transaksi_pinjaman_idx').on(t.pinjamanId)]);

export const kontrakKontraktor = finance.table('kontrak_kontraktor', {
  id: uuid('id').defaultRandom().primaryKey(),
  noSpk: varchar('no_spk', { length: 40 }).notNull().unique(),
  proyekId: uuid('proyek_id').references(() => trkProjects.id).notNull(),
  unitId: uuid('unit_id').references(() => trkUnits.id).notNull(),
  tipe: varchar('tipe', { length: 50 }),
  tanggalSpk: date('tanggal_spk').notNull(),
  // Kontraktor (kode pembantu kategori kontraktor)
  kodePembantuId: uuid('kode_pembantu_id').references(() => kodePembantu.id).notNull(),
  nilaiRab: money('nilai_rab').notNull(),
  nilaiKontrak: money('nilai_kontrak').notNull(),
  keterangan: text('keterangan'),
  akunPersediaanId: uuid('akun_persediaan_id').references(() => akun.id).notNull(),
  akunHutangId: uuid('akun_hutang_id').references(() => akun.id).notNull(),
  // aktif, batal
  status: varchar('status', { length: 10 }).notNull().default('aktif'),
  // Jurnal pengakuan hutang saat SPK
  jurnalId: uuid('jurnal_id').references(() => jurnal.id),
  jurnalBatalId: uuid('jurnal_batal_id').references(() => jurnal.id),
  dibatalkanPada: timestamp('dibatalkan_pada', { withTimezone: true }),
  ...timestamps(),
}, (t) => [index('kontrak_proyek_idx').on(t.proyekId)]);

export const adendumKontrak = finance.table('adendum_kontrak', {
  id: uuid('id').defaultRandom().primaryKey(),
  kontrakId: uuid('kontrak_id').references(() => kontrakKontraktor.id).notNull(),
  noAdendum: varchar('no_adendum', { length: 40 }).notNull(),
  tanggal: date('tanggal').notNull(),
  nilaiLama: money('nilai_lama').notNull(),
  nilaiBaru: money('nilai_baru').notNull(),
  alasan: text('alasan').notNull(),
  jurnalId: uuid('jurnal_id').references(() => jurnal.id),
  dibuatOleh: uuid('dibuat_oleh').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('adendum_kontrak_idx').on(t.kontrakId)]);

export const pembayaranKontrak = finance.table('pembayaran_kontrak', {
  id: uuid('id').defaultRandom().primaryKey(),
  kontrakId: uuid('kontrak_id').references(() => kontrakKontraktor.id).notNull(),
  tanggal: date('tanggal').notNull(),
  nominal: money('nominal').notNull(),
  akunKasId: uuid('akun_kas_id').references(() => akun.id).notNull(),
  noBukti: varchar('no_bukti', { length: 60 }),
  keterangan: text('keterangan'),
  jurnalId: uuid('jurnal_id').references(() => jurnal.id),
  dibuatOleh: uuid('dibuat_oleh').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('pembayaran_kontrak_idx').on(t.kontrakId)]);

// SHM dan PBG per kavling (FE: shmStore)
export const dokumenLegalKavling = finance.table('dokumen_legal_kavling', {
  id: uuid('id').defaultRandom().primaryKey(),
  unitId: uuid('unit_id').references(() => trkUnits.id).notNull().unique(),
  noShm: varchar('no_shm', { length: 40 }).notNull().unique(),
  // di_notaris, di_kantor, dijaminkan, sudah_ditebus, lainnya
  statusShm: varchar('status_shm', { length: 20 }).notNull(),
  statusShmKustom: varchar('status_shm_kustom', { length: 60 }),
  lokasi: varchar('lokasi', { length: 100 }).notNull(),
  pinjamanId: uuid('pinjaman_id').references(() => pinjaman.id),
  noPbg: varchar('no_pbg', { length: 40 }),
  // belum_diajukan, dalam_proses, terbit, lainnya
  statusPbg: varchar('status_pbg', { length: 20 }).notNull().default('belum_diajukan'),
  statusPbgKustom: varchar('status_pbg_kustom', { length: 60 }),
  ...timestamps(),
});

export const shmRiwayat = finance.table('shm_riwayat', {
  id: uuid('id').defaultRandom().primaryKey(),
  dokumenId: uuid('dokumen_id').references(() => dokumenLegalKavling.id, { onDelete: 'cascade' }).notNull(),
  tanggal: date('tanggal').notNull(),
  dariStatus: varchar('dari_status', { length: 20 }),
  keStatus: varchar('ke_status', { length: 20 }).notNull(),
  lokasi: varchar('lokasi', { length: 100 }),
  keterangan: text('keterangan'),
  oleh: uuid('oleh').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('shm_riwayat_dokumen_idx').on(t.dokumenId)]);
