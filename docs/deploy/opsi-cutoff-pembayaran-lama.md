# Opsi cutoff untuk pembayaran PRTrack sebelum PRSI

Status: Opsi A diimplementasikan 21 Oktober 2026 atas instruksi pemilik (lihat
bagian "Implementasi Opsi A"). Keputusan Keuangan di bagian akhir tetap
diperlukan sebelum aktivasi.

## Masalah

Saat sync SI berjalan, `prosesSemua` (dipanggil worker setiap putaran) memproses
semua `trk_payments` yang belum punya status, termasuk seluruh riwayat sebelum
PRSI. Pembayaran tanpa `si_jadwal_id` yang terverifikasi di Track langsung dibuat
jurnalnya pada tanggal asli:

- rekening cocok dan bukti ada: jurnal diposting dan dialokasikan FIFO;
- rekening/bukti tidak memenuhi: `gagal_validasi`, sebagian dengan jurnal draft.

Tidak ada batas tanggal. Bila Keuangan juga mengisi saldo awal piutang/uang muka,
uang yang sama tercatat dua kali. Staging berisi 1.283 pembayaran.

### Temuan tambahan: satu pembayaran lama menghentikan pemrosesan (diperbaiki)

`buatJurnal` menolak (422) jurnal bertanggal sebelum `tanggal_mulai` saldo awal
proyek atau di periode terkunci, termasuk draft. Penolakan itu dulu tidak
ditangkap, sehingga pembayaran lama pertama yang terkena aturan menggagalkan
seluruh `prosesSemua` di setiap putaran. Direproduksi dengan tes lalu diperbaiki
21 Oktober 2026: `proses` mencatat penolakan bisnis sebagai `gagal_validasi`
beralasan tanpa jurnal (atau `perlu_ditinjau` bila sudah dijurnal) dan batch
lanjut. Tes: `integration.backend.js`, "legacy Track payments rejected by journal
rules do not stop the batch".

## Fakta yang dipakai

- Piutang menghitung "dibayar" dari `alokasi_pembayaran` yang pembayarannya
  berstatus `dijurnal`. Pembayaran lama yang tidak dialokasikan membuat tagihan
  tampak belum dibayar dan plafon tagihan SI tidak memperhitungkannya.
- SI sudah memiliki `saldo_awal_periode` per proyek dengan `tanggal_mulai` dan
  kunci, serta saldo awal per akun dan kode pembantu (customer). Jurnal sebelum
  `tanggal_mulai` sudah ditolak oleh SI.
- Cermin `trk_payments` memuat `tanggal` (tanggal bayar, diisi admin) dan
  `source_created_at` (waktu pencatatan di Track).
- Worker memproses pembayaran pada putaran yang sama dengan muat awal, jadi
  aturan cutoff harus terpasang sebelum sync pertama kali dinyalakan.

## Opsi

### A. Cutoff per proyek dari tanggal mulai saldo awal (disarankan)

Pembayaran tanpa tagihan dengan `tanggal < tanggal_mulai` proyeknya menjadi
status baru `historis`: dialokasikan seperti jalur legacy (FIFO ke jadwal aktif,
booking fee/lebih bayar tanpa jadwal) tetapi **tanpa jurnal**. Nilainya sudah
diwakili saldo awal kode pembantu customer. Pembayaran pada atau sesudah
`tanggal_mulai` tetap memakai jalur legacy biasa.

Pengaman pencatatan mundur: bila `source_created_at` sesudah waktu cutover
tetapi `tanggal` sebelum `tanggal_mulai`, statusnya `perlu_ditinjau`, bukan
`historis`, karena itu input baru yang ditanggal mundur.

Perubahan:
- `STATUS_PROSES_PEMBAYARAN` + `historis`; piutang menghitung alokasi berstatus
  `dijurnal` atau `historis`.
- Cabang `historis` di `prosesPembayaranTx` sebelum pembuatan jurnal.
- Kirim `kunci_pembayaran` ke Track untuk pembayaran historis (nomor jurnal diisi
  penanda `SALDO-AWAL`) supaya riwayat tidak diubah lagi di Track.
- Readiness: setiap proyek yang punya pembayaran lama wajib memiliki saldo awal
  terkunci sebelum `SYNC_ENABLED`; tanpa itu worker menahan pemrosesan legacy.
- Laporan rekonsiliasi per penjualan: total pembayaran historis dibandingkan
  saldo awal kode pembantu customer.

Kelebihan: memakai konsep yang sudah ada dan selaras dengan aturan jurnal SI;
tanggal bisa berbeda per proyek. Kekurangan: bergantung pada saldo awal per
customer yang lengkap; proyek tanpa saldo awal tidak bisa diaktifkan.

#### Implementasi Opsi A

- Konfigurasi `SI_LEGACY_CUTOVER_AT` (ISO 8601 dengan zona waktu; startup gagal
  bila format salah). Kosong = belum dikonfigurasi.
- Bila `SI_BILLING_ENABLED=true` dan nilai itu kosong, pembayaran tanpa tagihan
  tidak dipilih worker (tetap `belum_diproses`); proses manual mengembalikan 409.
- Bila nilai terisi, pembayaran tanpa tagihan hanya diproses untuk proyek dengan
  saldo awal **terkunci**; proyek lain ditahan dengan cara yang sama.
- Terverifikasi di Track, `tanggal < tanggal_mulai`, dicatat sebelum cutover,
  nominal positif dan jenis dikenal → `historis`: alokasi FIFO seperti jalur
  legacy, tanpa jurnal, kunci dikirim ke Track dengan penanda `SALDO-AWAL`, dan
  tagihan terdampak dikirim ulang agar realisasi Track ikut.
- Dicatat sesudah cutover dengan tanggal sebelum saldo awal, atau nominal ≤ 0 /
  jenis tidak dikenal → `perlu_ditinjau` tanpa jurnal.
- Pembayaran historis yang berubah di Track sesudahnya → `perlu_ditinjau`.
- Piutang menghitung `historis` sebagai dibayar. SPPR yang difinalkan sesudahnya
  mengalokasikan pembayaran historis assignment itu ke tagihan baru lebih dulu.
- Invariant baru `historical_payment_with_journal` harus 0.
- Tes: `integration.backend.js`, "option A cutoff ...". Alokasi historis saat
  finalisasi SPPR dengan pembayaran historis yang sudah ada belum diuji khusus.
- Belum ada laporan rekonsiliasi historis vs saldo awal kode pembantu; kueri
  `status_proses='historis'` per penjualan dapat dipakai sementara.

### B. Cutoff global berdasarkan waktu pencatatan

Satu nilai `SI_LEGACY_CUTOFF_AT` (timestamp cutover). Pembayaran tanpa tagihan
dengan `source_created_at` sebelum nilai itu menjadi `historis`; sisanya jalur
legacy. Baris tanpa `source_created_at` dianggap historis.

Kelebihan: paling sederhana, satu konfigurasi, input mundur sesudah cutover
otomatis tidak dianggap historis. Kekurangan: tidak mengikuti tanggal saldo awal
per proyek, sehingga pembayaran sesudah cutover dengan tanggal sebelum
`tanggal_mulai` tetap gagal dijurnal dan harus ditangani manual.

### C. Daftar eksplisit yang disetujui Keuangan

Saat cutover, worker ditahan setelah muat awal. Skrip mengisi tabel baru
`finance.pembayaran_historis` dengan semua pembayaran tanpa tagihan yang ada,
beserta ringkasan per proyek/customer untuk ditandatangani Keuangan. Hanya
pembayaran dalam daftar menjadi `historis`.

Kelebihan: paling mudah diaudit dan deterministik. Kekurangan: perlu migrasi,
skrip, dan gate tambahan (`prosesSemua` tidak boleh berjalan di antara muat awal
dan pengisian daftar); langkah manual di jendela cutover bertambah.

### D. Tanpa cutoff (perilaku sekarang)

Seluruh riwayat dijurnal ulang dari Track; Keuangan tidak mengisi saldo awal
piutang/uang muka untuk pembayaran tersebut. Memerlukan periode lama terbuka,
rekening tujuan terisi pada data lama, dan perbaikan bug di atas. Data lama yang
belum memiliki rekening akan masuk `gagal_validasi` secara massal. Tidak
disarankan.

## Perbandingan

| | A | B | C | D |
|---|---|---|---|---|
| Risiko pencatatan ganda | Rendah | Rendah | Paling rendah | Tinggi bila saldo awal diisi |
| Ikut tanggal saldo awal proyek | Ya | Tidak | Sesuai daftar | Tidak relevan |
| Input mundur sesudah cutover | Ditinjau | Diproses normal | Diproses normal | Diproses normal |
| Perubahan kode | Sedang | Kecil | Sedang–besar | Hanya perbaikan bug |
| Langkah manual saat cutover | Kunci saldo awal | Set satu nilai | Isi dan setujui daftar | Tinjau `gagal_validasi` |

## Wajib di semua opsi

1. Selesai: penolakan pembuatan jurnal dicatat per pembayaran dan tidak
   menghentikan `prosesSemua` (lihat temuan di atas). Tanpa opsi cutoff,
   pembayaran lama sebelum saldo awal akan menumpuk sebagai `gagal_validasi`.
2. Gate: bila billing aktif dan aturan cutover belum dikonfigurasi, worker tidak
   memproses pembayaran tanpa tagihan.
3. Pembayaran tanpa tagihan yang belum terverifikasi di Track dan auto-injeksi
   KPR tetap `menunggu`, sama seperti sekarang.
4. Gladi pada salinan tersanitasi: hitung jumlah dan nominal per status
   (historis, dijurnal, gagal_validasi, menunggu) per proyek, lalu bandingkan
   dengan saldo awal.

## Keputusan yang diperlukan dari Keuangan

1. Apakah saldo awal piutang/uang muka per customer akan diisi di SI, dan
   per tanggal berapa untuk setiap proyek?
2. Pembayaran lama berupa refund (nominal negatif): ikut dihitung neto sebagai
   historis, atau ditangani manual?
3. Pembayaran lama yang belum diverifikasi admin Track pada saat cutover:
   diverifikasi dulu sebelum cutover, atau diproses normal sesudahnya?
4. Siapa yang menandatangani rekonsiliasi historis vs saldo awal.
