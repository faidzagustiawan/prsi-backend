// src/sync/mapping.js
//
// Pemetaan payload event/snapshot PR Track ke kolom tabel cermin. Satu-satunya
// tempat yang tahu nama kolom Track. Setiap payload divalidasi ulang di SI
// (Track bisa saja sudah dimanipulasi): tipe, wajib isi, dan nilai pilihan.
import { z } from 'zod';
import {
  trkCompanies, trkProjects, trkClusters, trkUnits, trkCustomers, trkAssignments, trkPayments,
} from '../shared/schemas/track.schema.js';

const uuid = z.uuid();
const text = (max) => z.string().max(max).nullable().optional().transform((v) => v ?? null);
const req = (max) => z.string().trim().min(1).max(max);
const money = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const s = String(v).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    ctx.addIssue({ code: 'custom', message: `nominal tidak valid: ${s}` });
    return z.NEVER;
  }
  return s;
});
const optMoney = money.nullable().optional().transform((v) => v ?? null);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/).transform((v) => v.slice(0, 10));
const ts = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/))
  .nullable().optional().transform((v) => (v ? new Date(v) : null));
const decimal = z.union([z.string(), z.number()]).nullable().optional().transform((v) => (v === null || v === undefined ? null : String(v)));

// Urutan relasi: induk selalu diterapkan lebih dulu pada muat awal
export const ENTITY_ORDER = ['companies', 'projects', 'clusters', 'units', 'customers', 'assignments', 'payments'];

/**
 * parents: kolom FK di payload -> entitas induk. Nilainya track_id induk dan
 * diganti id lokal saat diterapkan; induk yang belum ada menahan event.
 */
export const ENTITIES = {
  companies: {
    table: trkCompanies,
    schema: z.object({ nama_pt: req(255), kode_pt: text(50), alamat: text(5000) }),
    toRow: (p) => ({ nama: p.nama_pt, kode: p.kode_pt, alamat: p.alamat }),
    parents: {},
  },
  projects: {
    table: trkProjects,
    schema: z.object({ company_id: uuid, nama_proyek: req(255), kode: text(20), status: text(50) }),
    toRow: (p, ids) => ({ companyId: ids.company_id, nama: p.nama_proyek, kode: p.kode, status: p.status }),
    parents: { company_id: 'companies' },
  },
  clusters: {
    table: trkClusters,
    schema: z.object({ project_id: uuid, nama_cluster: req(255) }),
    toRow: (p, ids) => ({ projectId: ids.project_id, nama: p.nama_cluster }),
    parents: { project_id: 'projects' },
  },
  units: {
    table: trkUnits,
    schema: z.object({
      cluster_id: uuid, nomor_unit: req(50), tipe_rumah: text(50), luas_tanah: decimal, luas_bangunan: decimal,
      status_pembangunan: text(50),
    }),
    // project_id diturunkan dari cluster (lihat apply.js)
    toRow: (p, ids, extra) => ({
      clusterId: ids.cluster_id, projectId: extra.projectId, kode: p.nomor_unit, tipe: p.tipe_rumah,
      luasTanah: p.luas_tanah, luasBangunan: p.luas_bangunan, status: p.status_pembangunan,
    }),
    parents: { cluster_id: 'clusters' },
  },
  customers: {
    table: trkCustomers,
    // Hanya kolom whitelist; password_hash dan token tidak pernah dikirim Track
    schema: z.object({
      nama: req(255), email: text(255), nomor_telepon: text(20), tempat_lahir: text(100), tanggal_lahir: isoDate.nullable().optional(),
      pekerjaan: text(100), alamat: text(5000), no_ktp: text(16),
    }),
    toRow: (p) => ({
      nama: p.nama, email: p.email, noHp: p.nomor_telepon, tempatLahir: p.tempat_lahir, tanggalLahir: p.tanggal_lahir ?? null,
      pekerjaan: p.pekerjaan, alamat: p.alamat, noKtp: p.no_ktp,
    }),
    parents: {},
  },
  assignments: {
    table: trkAssignments,
    schema: z.object({
      user_id: uuid, unit_id: uuid, tipe_pembayaran: z.enum(['cash_lunas', 'cash_cicil', 'kredit_kpr']),
      harga_total: optMoney, dp: optMoney, status_kepemilikan: text(50), tanggal_pembelian: ts,
    }),
    toRow: (p, ids) => ({
      unitId: ids.unit_id, customerId: ids.user_id, tipePembayaran: p.tipe_pembayaran, harga: p.harga_total,
      uangMuka: p.dp, status: p.status_kepemilikan, tanggal: p.tanggal_pembelian,
    }),
    parents: { user_id: 'customers', unit_id: 'units' },
  },
  payments: {
    table: trkPayments,
    schema: z.object({
      assignment_id: uuid, jumlah_bayar: money, tanggal_bayar: isoDate, catatan: text(5000),
      bukti_pembayaran: z.union([z.string(), z.array(z.string())]).nullable().optional(),
      is_auto_inject: z.boolean().nullable().optional(), created_at: ts,
      // Kolom baru di Track (RancanganSistem T7); boleh belum ada
      jenis: text(20), status_verifikasi: text(20), rekening_tujuan: text(30),
      diverifikasi_oleh: text(150), diverifikasi_pada: ts,
    }),
    toRow: (p, ids) => ({
      assignmentId: ids.assignment_id, nominal: p.jumlah_bayar, tanggal: p.tanggal_bayar, catatan: p.catatan,
      buktiUrl: Array.isArray(p.bukti_pembayaran) ? JSON.stringify(p.bukti_pembayaran) : (p.bukti_pembayaran ?? null),
      isAutoInject: Boolean(p.is_auto_inject), sourceCreatedAt: p.created_at, jenis: p.jenis, statusVerifikasi: p.status_verifikasi,
      rekeningTujuan: p.rekening_tujuan, diverifikasiOleh: p.diverifikasi_oleh, diverifikasiPada: p.diverifikasi_pada,
    }),
    parents: { assignment_id: 'assignments' },
  },
};
