// src/shared/constants.js
// Nilai pilihan tetap. Disimpan sebagai VARCHAR di database dan divalidasi di
// aplikasi. Kodenya mengikuti tipe di frontend (FE_Podorukun-SI/src/store).

export const ROLES = ['admin', 'keuangan', 'teknisi', 'marketing', 'kontraktor'];
export const USER_STATUS = ['active', 'inactive'];

export const KATEGORI_AKUN = ['aktiva', 'hutang', 'modal', 'pendapatan', 'beban', 'hpp'];
export const KLASIFIKASI_AKUN = ['neraca', 'laba_rugi'];
export const TIPE_SALDO = ['d', 'k'];
export const KATEGORI_HUTANG_PIUTANG = [
  'lahan', 'bank', 'antar_proyek', 'ppn', 'pihak_ketiga',
  'pemegang_saham', 'karyawan', 'kontraktor', 'lain_lain',
];

// Kategori kode pembantu = kategori hutang/piutang + pihak penjualan
export const KATEGORI_KODE_PEMBANTU = [...KATEGORI_HUTANG_PIUTANG, 'pembeli'];

export const JURNAL_STATUS = ['draft', 'diposting', 'dikoreksi', 'balik'];
export const JURNAL_SUMBER = ['manual', 'pr_track', 'pinjaman', 'kontraktor', 'penjualan', 'mirror'];

export const PERIODE_STATUS = ['terbuka', 'terkunci'];

export const LAMPIRAN_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const LAMPIRAN_MAKS_BYTES = 10 * 1024 * 1024;
