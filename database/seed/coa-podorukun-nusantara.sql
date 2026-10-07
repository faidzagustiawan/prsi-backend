-- COA PT. Podo Rukun Nusantara dari sheet "DAFTAR AKUN PODORUKUN SI" (78 akun).
-- Idempoten: akun yang kodenya sudah ada dilewati (ON CONFLICT DO NOTHING).
-- Induk diturunkan dari prefix kode; baris tanpa D/K di sheet = akun header,
-- tipe saldonya mengikuti saldo normal kategori.
-- Kode 11100 (KAS) 5 digit sesuai sheet. Afiliasi PT = pihak_ketiga.
-- Modul hutang memakai akun berkode terkecil per kategori hutang/piutang
-- (bank: 215070; pihak_ketiga: 215010). Mutasi akun lain di kategori yang sama
-- dicatat lewat jurnal manual.
-- Tidak tercatat di audit_logs; akun_sistem dan no_rekening diisi terpisah.
BEGIN;

CREATE TEMP TABLE coa_seed (
  urut serial, kode varchar(10), nama varchar(150), induk varchar(10), kategori varchar(12),
  tipe_saldo varchar(1), klasifikasi varchar(10), kategori_hutang_piutang varchar(20),
  wajib_kode_pembantu boolean, wajib_proyek boolean, is_kas_bank boolean
) ON COMMIT DROP;

INSERT INTO coa_seed (kode, nama, induk, kategori, tipe_saldo, klasifikasi, kategori_hutang_piutang,
  wajib_kode_pembantu, wajib_proyek, is_kas_bank) VALUES
  ('100000', 'AKTIVA', NULL, 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('110000', 'AKTIVA LANCAR', '100000', 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('11100', 'KAS', '110000', 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('111100', 'REKENING TABUNGAN PENAMPUNG', '11100', 'aktiva', 'd', 'neraca', NULL, false, false, true),
  ('112000', 'BANK', '110000', 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('112010', 'BANK BCA BRI BSI BNI (GIRO)', '112000', 'aktiva', 'd', 'neraca', NULL, false, false, true),
  ('112020', 'BANK BTN BTNS (GIRO)', '112000', 'aktiva', 'd', 'neraca', NULL, false, false, true),
  ('112030', 'BANK MANDIRI', '112000', 'aktiva', 'd', 'neraca', NULL, false, false, true),
  ('113000', 'PIUTANG', '110000', 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('113500', 'PIUTANG AFILIASI PT. PODO RUKUN INDONESIA', '113000', 'aktiva', 'd', 'neraca', 'pihak_ketiga', true, false, false),
  ('113510', 'PIUTANG AFILIASI PT. PODO RUKUN NUSANTARA', '113000', 'aktiva', 'd', 'neraca', 'pihak_ketiga', true, false, false),
  ('113520', 'PIUTANG AFILIASI PT. PODO RUKUN GROUP', '113000', 'aktiva', 'd', 'neraca', 'pihak_ketiga', true, false, false),
  ('113530', 'PIUTANG PENJUALAN', '113000', 'aktiva', 'd', 'neraca', NULL, true, true, false),
  ('113540', 'PIUTANG PEMEGANG SAHAM (DEVIDEN)', '113000', 'aktiva', 'd', 'neraca', 'pemegang_saham', true, false, false),
  ('113600', 'PIUTANG KARYAWAN', '113000', 'aktiva', 'd', 'neraca', 'karyawan', true, false, false),
  ('113700', 'PIUTANG LAIN-LAIN', '113000', 'aktiva', 'd', 'neraca', 'lain_lain', true, false, false),
  ('114000', 'PERSEDIAAN DAN INVESTASI LAINNYA', '110000', 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('114230', 'INVESTASI PODO RUKUN NUSANTARA', '114000', 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('114240', 'PERSEDIAAN TANAH KAVLING PODO RUKUN NUSANTARA', '114000', 'aktiva', 'd', 'neraca', NULL, false, true, false),
  ('120000', 'AKTIVA TETAP', '100000', 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('121000', 'TANAH, BANGUNAN DAN PERALATAN', '120000', 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('121010', 'TANAH DAN BANGUNAN', '121000', 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('121020', 'PERALATAN KANTOR DAN EQUIPMENT', '121000', 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('121030', 'KENDARAAN', '121000', 'aktiva', 'd', 'neraca', NULL, false, false, false),
  ('200000', 'HUTANG', NULL, 'hutang', 'k', 'neraca', NULL, false, false, false),
  ('210000', 'HUTANG JANGKA PENDEK', '200000', 'hutang', 'k', 'neraca', NULL, false, false, false),
  ('212005', 'HUTANG LAHAN', '210000', 'hutang', 'k', 'neraca', 'lahan', true, false, false),
  ('212006', 'HUTANG PPN', '210000', 'hutang', 'k', 'neraca', 'ppn', true, false, false),
  ('215000', 'HUTANG PIHAK KETIGA', '210000', 'hutang', 'k', 'neraca', NULL, false, false, false),
  ('215010', 'HUTANG AFILIASI PT. PODO RUKUN INDONESIA', '215000', 'hutang', 'k', 'neraca', 'pihak_ketiga', true, false, false),
  ('215020', 'HUTANG AFILIASI PT. PODO RUKUN NUSANTARA', '215000', 'hutang', 'k', 'neraca', 'pihak_ketiga', true, false, false),
  ('215030', 'HUTANG AFILIASI PODO RUKUN GROUP', '215000', 'hutang', 'k', 'neraca', 'pihak_ketiga', true, false, false),
  ('215040', 'HUTANG LAIN - LAIN', '215000', 'hutang', 'k', 'neraca', 'lain_lain', true, false, false),
  ('215050', 'HUTANG PEMEGANG SAHAM', '215000', 'hutang', 'k', 'neraca', 'pemegang_saham', true, false, false),
  ('215070', 'HUTANG BRI', '215000', 'hutang', 'k', 'neraca', 'bank', true, false, false),
  ('215080', 'HUTANG KARYAWAN', '215000', 'hutang', 'k', 'neraca', 'karyawan', true, false, false),
  ('220000', 'HUTANG JANGKA PANJANG', '200000', 'hutang', 'k', 'neraca', NULL, false, false, false),
  ('221000', 'HUTANG BANK', '220000', 'hutang', 'k', 'neraca', NULL, false, false, false),
  ('221100', 'HUTANG MANDIRI', '221000', 'hutang', 'k', 'neraca', 'bank', true, false, false),
  ('221300', 'HUTANG BANK BTNS KYG', '221000', 'hutang', 'k', 'neraca', 'bank', true, false, false),
  ('300000', 'MODAL', NULL, 'modal', 'k', 'neraca', NULL, false, false, false),
  ('310100', 'MODAL PENYERTAAN', '300000', 'modal', 'k', 'neraca', NULL, false, false, false),
  ('320000', 'L/R BERJALAN', '300000', 'modal', 'k', 'neraca', NULL, false, false, false),
  ('320200', 'L/R BERJALAN PODO RUKUN NUSANTARA', '320000', 'modal', 'k', 'neraca', NULL, false, false, false),
  ('330000', 'L/R DITAHAN', '300000', 'modal', 'k', 'neraca', NULL, false, false, false),
  ('330200', 'L/R DITAHAN PODO RUKUN NUSANTARA', '330000', 'modal', 'k', 'neraca', NULL, false, false, false),
  ('340000', 'DIVIDEN', '300000', 'modal', 'k', 'neraca', NULL, false, false, false),
  ('340200', 'DIVIDEN PODO RUKUN NUSANTARA', '340000', 'modal', 'k', 'neraca', NULL, false, false, false),
  ('400000', 'PENDAPATAN', NULL, 'pendapatan', 'k', 'laba_rugi', NULL, false, false, false),
  ('400200', 'PENDAPATAN PODO RUKUN NUSANTARA', '400000', 'pendapatan', 'k', 'laba_rugi', NULL, false, false, false),
  ('400210', 'PEMASUKAN UANG MUKA USER', '400200', 'pendapatan', 'k', 'laba_rugi', NULL, false, false, false),
  ('400220', 'PENCAIRAN REALISASI KPR USER', '400200', 'pendapatan', 'k', 'laba_rugi', NULL, false, false, false),
  ('500000', 'BIAYA', NULL, 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('521000', 'HARGA POKOK PENJUALAN PODO RUKUN NUSANTARA', '500000', 'hpp', 'd', 'laba_rugi', NULL, false, false, false),
  ('521100', 'BIAYA TANAH / LAHAN', '521000', 'hpp', 'd', 'laba_rugi', NULL, false, false, false),
  ('521200', 'BIAYA SUB KONTRAKTOR', '521000', 'hpp', 'd', 'laba_rugi', NULL, false, false, false),
  ('521300', 'OVERHEAD PROYEK', '521000', 'hpp', 'd', 'laba_rugi', NULL, false, false, false),
  ('521400', 'BIAYA SARANA & PRASARANA (FASUM)', '521000', 'hpp', 'd', 'laba_rugi', NULL, false, false, false),
  ('521500', 'BIAYA PEMASANGAN LISTRIK & AIR', '521000', 'hpp', 'd', 'laba_rugi', NULL, false, false, false),
  ('521600', 'BIAYA LEGAL NOTARIS & PAJAK', '521000', 'hpp', 'd', 'laba_rugi', NULL, false, false, false),
  ('522000', 'BIAYA USAHA', '500000', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522100', 'BIAYA PENJUALAN DAN PEMASARAN', '522000', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522110', 'BIAYA PROMOSI', '522100', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522120', 'BIAYA KOMISI PENJUALAN', '522100', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522200', 'BIAYA ADMINISTRASI DAN UMUM', '522000', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522210', 'BIAYA GAJI DAN UPAH', '522200', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522220', 'BIAYA BPJS & TUNJANGAN', '522200', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522230', 'BIAYA AKOMODASI', '522200', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522240', 'BIAYA BONUS DAN THR', '522200', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522250', 'BIAYA LISTRIK, AIR DAN INTERNET', '522200', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522260', 'BIAYA ADMIN BUNGA KYG', '522200', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522270', 'BIAYA KANTOR', '522200', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('522280', 'BIAYA LAIN-LAIN', '522200', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('523000', 'PEMASUKAN (PENGELUARAN) LAIN-LAIN', '500000', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('523100', 'PENDAPATAN LAIN LAIN', '523000', 'pendapatan', 'k', 'laba_rugi', NULL, false, false, false),
  ('523200', 'BUNGA ADMIN BANK', '523000', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('524000', 'BIAYA PAJAK', '500000', 'beban', 'd', 'laba_rugi', NULL, false, false, false),
  ('524100', 'PAJAK KANTOR', '524000', 'beban', 'd', 'laba_rugi', NULL, false, false, false);

-- Tahap 1: semua akun tanpa induk; tahap 2: hubungkan induk berdasarkan kode
INSERT INTO finance.akun (kode, nama, kategori, tipe_saldo, klasifikasi, kategori_hutang_piutang,
  wajib_kode_pembantu, wajib_proyek, is_kas_bank)
SELECT kode, nama, kategori, tipe_saldo, klasifikasi, kategori_hutang_piutang,
  wajib_kode_pembantu, wajib_proyek, is_kas_bank
FROM coa_seed ORDER BY urut
ON CONFLICT (kode) DO NOTHING;

UPDATE finance.akun a SET induk_id = p.id, updated_at = now()
FROM coa_seed s JOIN finance.akun p ON p.kode = s.induk
WHERE a.kode = s.kode AND a.induk_id IS NULL;

SELECT count(*) AS akun_dari_sheet FROM finance.akun a JOIN coa_seed s USING (kode);
COMMIT;
