// Data contoh untuk development lokal, mengikuti data dummy di frontend
// (FE_Podorukun-SI/src/store). Hanya berjalan bila NODE_ENV=development dan
// database belum berisi akun.
//
//   npm run seed:dev
//
// Tabel trk_* di produksi hanya diisi worker sinkronisasi dari PR Track. Di sini
// diisi langsung supaya layar keuangan bisa dicoba sebelum API Track siap.
import { randomUUID } from 'node:crypto';
import { count } from 'drizzle-orm';
import { db, closeDatabase } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { trkCompanies, trkProjects, trkClusters, trkUnits, trkCustomers, trkAssignments } from '../src/shared/schemas/track.schema.js';
import { akun, kodePembantu, masterPt } from '../src/shared/schemas/akuntansi.schema.js';

if (!env.isDevelopment) {
  console.error('✖ seed-dev hanya untuk NODE_ENV=development');
  process.exit(1);
}

// [kode, nama, kategori, tipeSaldo, klasifikasi, induk, opsi]
const COA = [
  ['110000', 'Aktiva Lancar', 'aktiva', 'd', 'neraca'],
  ['111010', 'Kas', 'aktiva', 'd', 'neraca', '110000', { isKasBank: true }],
  ['112010', 'Bank Mandiri', 'aktiva', 'd', 'neraca', '110000', { isKasBank: true, noRekening: '1230004567890' }],
  ['112020', 'Bank BRI', 'aktiva', 'd', 'neraca', '110000', { isKasBank: true, noRekening: '0021010012345' }],
  ['113010', 'Piutang penjualan', 'aktiva', 'd', 'neraca', '110000', { wajibKodePembantu: true, wajibProyek: true }],
  ['114010', 'Piutang antar proyek', 'aktiva', 'd', 'neraca', '110000', { wajibKodePembantu: true, kategoriHutangPiutang: 'antar_proyek' }],
  ['131010', 'Persediaan kavling', 'aktiva', 'd', 'neraca', '110000', { wajibProyek: true }],
  ['210000', 'Hutang', 'hutang', 'k', 'neraca'],
  ['211010', 'Hutang lahan', 'hutang', 'k', 'neraca', '210000', { wajibKodePembantu: true, kategoriHutangPiutang: 'lahan' }],
  ['212010', 'Hutang bank', 'hutang', 'k', 'neraca', '210000', { wajibKodePembantu: true, kategoriHutangPiutang: 'bank' }],
  ['213010', 'Hutang kontraktor', 'hutang', 'k', 'neraca', '210000', { wajibKodePembantu: true, kategoriHutangPiutang: 'kontraktor' }],
  ['214010', 'Titipan booking fee', 'hutang', 'k', 'neraca', '210000', { wajibKodePembantu: true }],
  ['215010', 'Uang muka penjualan', 'hutang', 'k', 'neraca', '210000', { wajibKodePembantu: true, wajibProyek: true }],
  ['216010', 'Hutang antar proyek', 'hutang', 'k', 'neraca', '210000', { wajibKodePembantu: true, kategoriHutangPiutang: 'antar_proyek' }],
  ['217010', 'Hutang pihak ketiga', 'hutang', 'k', 'neraca', '210000', { wajibKodePembantu: true, kategoriHutangPiutang: 'pihak_ketiga' }],
  ['218010', 'Hutang PPN', 'hutang', 'k', 'neraca', '210000', { wajibKodePembantu: true, kategoriHutangPiutang: 'ppn' }],
  ['219010', 'Hutang pengembalian', 'hutang', 'k', 'neraca', '210000', { wajibKodePembantu: true }],
  ['310000', 'Modal disetor', 'modal', 'k', 'neraca'],
  ['410000', 'Penjualan', 'pendapatan', 'k', 'laba_rugi', null, { wajibProyek: true }],
  ['420000', 'Pendapatan lain-lain', 'pendapatan', 'k', 'laba_rugi'],
  ['510000', 'HPP', 'hpp', 'd', 'laba_rugi', null, { wajibProyek: true }],
  ['600000', 'Beban', 'beban', 'd', 'laba_rugi'],
  ['611010', 'Beban bunga', 'beban', 'd', 'laba_rugi', '600000'],
  ['612010', 'Beban cashback KPR', 'beban', 'd', 'laba_rugi', '600000'],
  ['612020', 'Beban admin KPR', 'beban', 'd', 'laba_rugi', '600000'],
];

const track = (extra) => ({ trackId: randomUUID(), rowVersion: 1, ...extra });

try {
  const [{ n }] = await db.select({ n: count() }).from(akun);
  if (Number(n) > 0) {
    console.log('• Akun sudah ada, seed dilewati.');
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    const [company] = await tx.insert(trkCompanies).values(track({ nama: 'Podorukun Group', kode: 'PDR' })).returning();

    const projects = await tx.insert(trkProjects).values([
      track({ companyId: company.id, kode: 'ATH', nama: 'Atlantis Hills', status: 'active' }),
      track({ companyId: company.id, kode: 'ATI', nama: 'Atlantis Icon', status: 'active' }),
      track({ companyId: company.id, kode: 'AYS', nama: 'Aya Sophia', status: 'active' }),
    ]).returning();
    const [ath, ati] = projects;

    const clusters = await tx.insert(trkClusters).values(projects.map((p) => track({ projectId: p.id, nama: `${p.nama} Cluster A` }))).returning();
    const units = await tx.insert(trkUnits).values(clusters.flatMap((c) =>
      ['A-01', 'A-02', 'B-12'].map((kode) => track({
        clusterId: c.id, projectId: c.projectId, kode, tipe: kode.startsWith('B') ? 'Type 36' : 'Type 45',
        luasTanah: '90.00', luasBangunan: '45.00', status: 'planned',
      })))).returning();

    const [budi, sari] = await tx.insert(trkCustomers).values([
      track({ nama: 'Andi Wijaya', noHp: '081234567890', alamat: 'Jl. Melati 3, Malang' }),
      track({ nama: 'Sari Lestari', noHp: '081298765432', alamat: 'Jl. Kenanga 7, Batu' }),
    ]).returning();
    await tx.insert(trkAssignments).values([
      track({ unitId: units[0].id, customerId: budi.id, tipePembayaran: 'kredit_kpr', harga: '450000000.00', uangMuka: '90000000.00', status: 'active', tanggal: new Date('2026-02-01') }),
      track({ unitId: units[3].id, customerId: sari.id, tipePembayaran: 'cash_cicil', harga: '380000000.00', uangMuka: '0.00', status: 'active', tanggal: new Date('2026-03-10') }),
    ]);

    await tx.insert(masterPt).values([
      { namaPt: 'PT Pesona Raya Sejahtera Mandiri', singkatan: 'PRSM', namaDirektur: 'Budi Hartanto', ttl: 'Jakarta, 12 Maret 1975',
        pekerjaan: 'Direktur', alamat: 'Jl. Sudirman No. 45, Jakarta Selatan', noKtp: '3174012203750002', proyekId: ath.id },
      { namaPt: 'PT Prima Realty Nusantara', singkatan: 'PRN', namaDirektur: 'Sari Dewi Kusuma', ttl: 'Surabaya, 8 Juli 1980',
        pekerjaan: 'Direktur', alamat: 'Jl. Pemuda No. 12, Surabaya', noKtp: '3578054807800003', proyekId: ati.id },
    ]);

    const idByKode = new Map();
    for (const [kode, nama, kategori, tipeSaldo, klasifikasi, induk, opsi = {}] of COA) {
      const [row] = await tx.insert(akun).values({
        kode, nama, kategori, tipeSaldo, klasifikasi, indukId: induk ? idByKode.get(induk) : null, ...opsi,
      }).returning({ id: akun.id });
      idByKode.set(kode, row.id);
    }

    await tx.insert(kodePembantu).values([
      { kode: 'LH-0001', nama: 'Pak Warsito (pemilik lahan)', kategori: 'lahan', proyekId: ath.id },
      { kode: 'BK-0001', nama: 'Bank Mandiri', kategori: 'bank', proyekId: ati.id },
      { kode: 'AP-0001', nama: 'Aya Sophia', kategori: 'antar_proyek', proyekId: ath.id },
      { kode: 'PK-0001', nama: 'Arohma (investor)', kategori: 'pihak_ketiga', proyekId: ati.id },
      { kode: 'KT-0001', nama: 'PT Beton Jaya', kategori: 'kontraktor', proyekId: ath.id },
      { kode: 'PJ-0001', nama: 'Kantor Pajak', kategori: 'ppn', proyekId: ath.id },
      { kode: 'PB-0001', nama: budi.nama, kategori: 'pembeli', proyekId: ath.id, customerId: budi.id },
      { kode: 'PB-0002', nama: sari.nama, kategori: 'pembeli', proyekId: ath.id, customerId: sari.id },
    ]);
    // Penomoran kode pembantu melanjutkan dari kode contoh di atas
    await tx.execute(`INSERT INTO finance.penomoran (jenis, scope, tahun, bulan, nomor_terakhir) VALUES
      ('kode_pembantu','LH',0,0,1),('kode_pembantu','BK',0,0,1),('kode_pembantu','AP',0,0,1),('kode_pembantu','PK',0,0,1),
      ('kode_pembantu','KT',0,0,1),('kode_pembantu','PJ',0,0,1),('kode_pembantu','PB',0,0,2)`);
  });

  console.log('✔ Seed dev selesai: 3 proyek, 2 PT, akun COA, kode pembantu.');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
