// src/shared/constants.js
// Nilai pilihan tetap. Disimpan sebagai VARCHAR di database dan divalidasi di
// aplikasi. Kodenya mengikuti tipe di frontend (FE_Podorukun-SI/src/store).

export const ROLES = ['admin', 'keuangan', 'teknisi', 'marketing', 'kontraktor'];
export const USER_STATUS = ['active', 'inactive'];

export const KATEGORI_AKUN = ['aktiva', 'hutang', 'modal', 'pendapatan', 'beban', 'hpp'];
export const KLASIFIKASI_AKUN = ['neraca', 'laba_rugi'];
export const TIPE_SALDO = ['d', 'k'];
// Kategori hutang/piutang dan kategori kode pembantu ada di tabel
// finance.kategori_hutang_piutang, bukan konstanta.

export const JURNAL_STATUS = ['draft', 'diposting', 'dikoreksi', 'balik'];
export const JURNAL_SUMBER = ['manual', 'pr_track', 'pinjaman', 'kontraktor', 'penjualan', 'mirror'];

export const PERIODE_STATUS = ['terbuka', 'terkunci'];

export const LAMPIRAN_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const LAMPIRAN_MAKS_BYTES = 10 * 1024 * 1024;

// Tipe transaksi penjualan. Kode internal huruf kecil; FE memakai label
// 'Cash' | 'KPR' | 'In House' di template dan dokumen legal.
export const TIPE_TRANSAKSI = ['cash', 'kpr', 'in_house'];
export const TIPE_TRANSAKSI_LABEL = { cash: 'Cash', kpr: 'KPR', in_house: 'In House' };
export const tipeDariLabel = (v) => {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  return TIPE_TRANSAKSI.includes(s) ? s : null;
};
// tipe_pembayaran PR Track -> tipe transaksi SI
export const TIPE_DARI_TRACK = { cash_lunas: 'cash', cash_cicil: 'in_house', kredit_kpr: 'kpr' };

export const BERLAKU_PASAL = ['semua', ...TIPE_TRANSAKSI];
export const STATUS_DOKUMEN = ['draft', 'final', 'ditandatangani'];

// Jenis pembayaran dari PR Track (Alur 2)
export const JENIS_PEMBAYARAN = ['booking_fee', 'uang_muka', 'angsuran', 'pencairan_kpr'];
export const STATUS_PROSES_PEMBAYARAN = ['menunggu', 'dijurnal', 'gagal_validasi', 'perlu_ditinjau'];

// Peran akun di jurnal otomatis penjualan (peta jurnal ERD)
export const AKUN_SISTEM = {
  titipan_booking_fee: 'Titipan booking fee',
  uang_muka_penjualan: 'Uang muka penjualan',
  piutang_penjualan: 'Piutang penjualan',
  penjualan: 'Penjualan',
  hpp: 'HPP',
  persediaan_kavling: 'Persediaan kavling',
  pendapatan_lain: 'Pendapatan lain-lain',
  hutang_pengembalian: 'Hutang pengembalian',
  beban_cashback_kpr: 'Beban cashback KPR',
  beban_admin_kpr: 'Beban admin KPR',
};
