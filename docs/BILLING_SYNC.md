# Integrasi tagihan Track–SI

Implementasi backend, 19 Oktober 2026. Dokumen ini menjelaskan kode kandidat lokal;
bukan catatan bahwa produksi sudah dimigrasikan atau diaktifkan. Frontend tetap
dikerjakan tim frontend. Database aplikasi tetap terpisah.

## Kepemilikan dan kontrak

Track memiliki proyek/unit/customer/assignment dan pengajuan pembayaran aktual.
SI memiliki nilai kontrak, nominal/tenggat/jenis tagihan, keputusan verifikasi,
alokasi, jurnal, dan sisa tagihan. Cermin `finance.trk_*` hanya diperbarui sinkronisasi;
keputusan SI berada pada `status_pembayaran_si`, bukan pada payload Track.

Protokol baca memakai `/sync/v2/events`, cursor `txid:seq`, watermark xmin,
`source_id` UUID tetap, dan `contract_version: 2`. Ini versi kontrak billing;
server pilot lama yang tidak mengirim identitas/versi ditolak ketika billing aktif.
`si_jadwal_id` ditambahkan pada whitelist pembayaran dan checksum isi kedua pihak.
Fixture checksum kedua repo diperbarui bersama. Deploy kontrak harus terkoordinasi.
xmin membatasi transaksi yang sudah selesai; urutan txid bukan urutan waktu commit.
Transaksi lama dapat menahan publikasi, tetapi event tidak dilewati karena timeout.

SI mengirim full snapshot tagihan lewat `PUT /sync/v1/schedules/{siJadwalId}`:

```json
{"siJadwalId":"uuid","trackAssignmentId":"uuid","noUrut":2,"tanggal":"2026-11-10","jumlah":"100.00","jenis":"uang_muka","keterangan":"DP 2","aktif":true,"realisasi":"0.00","nilaiKontrak":"1000.00","versi":12}
```

`versi` berasal dari sequence outbox SI, bukan jam mesin. Perubahan dan outbox
ditulis dalam transaksi yang sama. Full snapshot juga dikirim untuk tagihan
nonaktif dan perubahan realisasi. Jenis: booking_fee, uang_muka, angsuran,
pencairan_kpr. ID/nomor urut berbeda fungsi: ID adalah relasi tetap, urutan label.

Hasil pembayaran memakai `PUT /sync/v1/payment-results/{trackPaymentId}`:

```json
{"trackPaymentId":"uuid","siJadwalId":"uuid","status":"dijurnal","alasan":null,"jurnal":"JT-202610-0001","versi":13}
```

Status: menunggu, ditolak, dijurnal, dikoreksi, perlu_ditinjau. Kedua PUT wajib
Bearer token tulis terpisah dan `Idempotency-Key` UUID. Kunci dan fingerprint
disimpan atomik bersama penerapan. Replay menghasilkan respons setara; penggunaan
kunci untuk payload lain 409. Versi lama diakui 200 `applied:false`; versi sama
dengan isi berbeda 409. SI tidak menganggap semua 409 sebagai keberhasilan.

## API untuk frontend

Semua prefix berikut `/api/v1`. Autentikasi/otorisasi lama dipertahankan.

| Sistem | Endpoint | Perilaku |
|---|---|---|
| SI | GET /piutang/{id}/tagihan | `{billingEnabled, spprFinal, statusPenjualan, nilaiSppr, totalAktif, pembayaranHistoris, sisaPlafon, items}`; item memuat dibayar, sisa, terkunci |
| SI | PUT /piutang/{id}/tagihan | Buat/ubah tagihan seluruh jenis, tidak terbatas DP |
| Track | GET /assignments/{id}/tagihan | Cermin tagihan, sisa, aktif, sedang_diproses; `billing_enabled` di samping `data` |
| Track | POST /assignments/{id}/payments | Pengajuan dengan tagihan, tanggal aktual, bukti, rekening |
| SI | GET /pembayaran-track | Antrean, keputusan SI, ID tagihan, jurnal |
| SI | POST /pembayaran-track/{id}/verifikasi | `{keputusan:terima|tolak, alasan?}`; tolak wajib alasan |
| SI | POST /jurnal/{id}/balik | Koreksi pembayaran terjurnal tanpa menghapus riwayat |
| SI | POST /sinkron/muat-ulang | `{sourceId:uuid}` menyiapkan resnapshot terkontrol |
| SI | POST /sinkron/kirim-ulang | Antrekan snapshot balik tagihan dan hasil pembayaran terkini |

PUT tagihan: `{id?, noUrut, tanggal, jumlah, jenis, keterangan?, aktif}`.
`id` adalah UUID SI. Batas nominal mengikuti validator uang SI. Jumlah tagihan
aktif ditambah pembayaran historis tidak boleh melampaui nilai SPPR. Tagihan
yang pernah menerima pengajuan tidak boleh ditimpa lewat endpoint ini.

Pengajuan Track:

```json
{"request_id":"uuid-baru-per-pengajuan","si_jadwal_id":"uuid-tagihan","tanggal_bayar":"2026-10-15","rekening_tujuan":"123456","bukti_pembayaran":["https://storage.example/bukti.jpg"],"catatan":"Transfer"}
```

Frontend menyimpan request_id dan memakainya kembali saat retry pengajuan yang
sama. Backend menentukan nominal dari sisa tagihan; nominal opsional yang berbeda
ditolak. Tanggal/bukti/rekening wajib. Tagihan bukan milik assignment, nonaktif,
lunas, atau punya pengajuan terbuka ditolak. Lock baris DB mencegah dua pengajuan
serentak. Pengajuan belum dianggap pembayaran diterima; jangan menampilkan sukses
pelunasan sebelum status SI dijurnal. Endpoint mobile lama tetap memakai bentuk
respons yang sama, dengan status sesuai keputusan SI untuk pembayaran bertagihan.

Mode ini menerima pembayaran sebesar seluruh sisa satu tagihan. Pembayaran parsial
dibentuk sebagai tagihan terpisah oleh SI. Refund memakai koreksi jurnal dan
proses keuangan, bukan angka negatif pada pengajuan tagihan.

## Pembukuan dan riwayat

SI memverifikasi isi pembayaran terkini dengan fingerprint, memeriksa rekening
kas/bank, jenis, nominal, assignment, tagihan aktif dan bukti. Jurnal draft yang
belum lolos validasi tidak mengubah saldo terbuku. Posting melalui layar jurnal
juga memeriksa keputusan SI. Alokasi memakai ID tagihan eksplisit, sehingga tagihan
ke-2 dapat lunas ketika tagihan ke-1 belum dibayar. Pengiriman ulang tidak membuat
jurnal/alokasi ganda. Penolakan membebaskan tagihan untuk pengajuan baru.

Adendum billing tidak memindahkan alokasi historis. Tagihan DP lama dinonaktifkan,
pembayaran historis dikreditkan terhadap nominal jadwal pengganti, dan tagihan
non-DP dipertahankan. Pengajuan yang belum selesai harus ditangani terlebih dahulu.
Riwayat tagihan ada di DTO piutang `riwayatTagihan`. Setelah jurnal balik, alokasi
dilepas, hasil dikoreksi dikirim, dan jurnal asal/pembalik tetap tersimpan. Bila
tagihan asal sudah diganti adendum, susun tagihan pengganti secara eksplisit;
sistem tidak menghidupkan otomatis tagihan nonaktif.

Nilai kontrak SI dicerminkan terpisah di Track (`si_contract_total`). Total customer
menghitung pembayaran bertagihan hanya setelah dijurnal. Auto-injeksi KPR lama
tidak dihitung sebagai kas aktual setelah kontrak SI diterima. Assignment KPR baru
pada mode SI tidak membuat pembayaran auto-injeksi. Perubahan tipe pembayaran
melalui API lama ditolak pada mode SI dan memerlukan penanganan adendum.

Pembayaran lama tanpa ID tagihan mempertahankan jalur legacy, termasuk verifikasi
Track dan perlakuan pembukuannya. Data historis tidak disahkan atau dipasangkan
ke tagihan secara otomatis; rekonsiliasi saldo awal dan keputusan verifikasinya
harus masuk UAT/cutover keuangan. Jangan memindahkan dana historis dua kali.

## Pemulihan dan operasi

Listener Track mendukung mode application (keputusan pemilik 20 Oktober 2026):
akun Track yang sudah ada dipakai pada host Track tanpa membuat role tambahan.
SI hanya mengakses API, bukan database Track. Mode dipilih eksplisit dan pin akun
pemilik tujuh tabel diperiksa; akun dengan hak admin ditolak. Pembatasan data
ditegakkan di API dan pool baca read-only, bukan ACL kolom database. Mode restricted
dengan dua role tetap tersedia. Lihat docs/deploy/SINGLE_ACCOUNT_SYNC.md untuk
konfigurasi, batas pengamanan, dan rollback. dbGuard SI tetap aktif.

Bootstrap v2 menyimpan cursor awal, sumber, indeks entitas, dan batas halaman.
Penerapan satu halaman dan checkpoint satu transaksi. Restart melanjutkan sisa
snapshot, lalu replay perubahan sejak cursor awal. Resnapshot mempertahankan UUID
lokal/FK/jurnal; baris hilang menjadi tombstone. Salah sumber berhenti sebelum
menerapkan event. Retensi hanya memangkas prefix transaksi yang sudah selesai;
cursor yang terpotong mendapat 410 dan tidak dilompati diam-diam. Operator memakai
muat-ulang dengan sourceId yang dikonfirmasi, kemudian menjalankan worker kembali.
Sesudah bootstrap/resnapshot selesai, SI mengantrekan ulang keadaan tagihan dan
hasil pembayaran terkini untuk membangun cermin Track yang kosong. Snapshot balik
juga dapat diantrekan lewat kirim-ulang; flag tulis tetap berlaku. Versi baru dan
lock per penjualan/pembayaran mencegah replay menimpa perubahan bisnis lebih baru.
Rekonsiliasi juga membaca snapshot jadwal dan hasil pembayaran Track melalui
`GET /sync/v1/billing-snapshot/{schedules|results}` dengan write token. Isi dan
nominal dibandingkan dengan keadaan bisnis SI, termasuk ketika outbox kosong.
Selisih ditandai `beda` dan keadaan SI diantrekan ulang. Perbandingan ditunda jika
antrean belum habis, SI berubah selama pemeriksaan, atau ada pengajuan baru Track
yang belum ditarik. Status sinkron menampilkan hasil pemeriksaan billing ini.
Bootstrap yang belum selesai menahan pembukuan/kiriman. Penolakan kontrak atau
cursor kedaluwarsa juga menahan keduanya; kegagalan jaringan sementara tetap
memungkinkan pemrosesan antrean lokal yang sudah aman sesuai alur sebelumnya.

Advisory lock worker memerlukan SESSION_DATABASE_URL session/direct, bukan
transaction pooler. Di produksi variabel ini wajib. Dua putaran tidak berjalan
bersamaan. SYNC_WRITE_ENABLED=false menahan seluruh PUT. SI_BILLING_ENABLED=false
menahan fitur verifikasi/tagihan baru; SYNC_ENABLED=false menghentikan koneksi.

## Validasi otomatis

`npm run test:billing` pada repo SI membutuhkan dua database baru/kosong lokal:
TEST_DATABASE_URL bernama prsi_test_* dan TEST_TRACK_DATABASE_URL prtrack_test_*.
Tidak ada fallback URL produksi dan tidak ada penghapusan database otomatis.
Repo Track adalah sibling `../../../Podorukuntrack/backend` pada checkout gabungan
ini. Gunakan checkout kedua repo dengan susunan yang sama untuk suite lintas repo.
Suite menguji bootstrap terputus, keputusan/alokasi/jurnal, replay, penolakan,
adendum, reversal, konflik, response loss, commit terlambat saat worker berjalan,
503 event, dua putaran bersamaan, retensi, hak kolom, dan invariant keuangan/cermin.
