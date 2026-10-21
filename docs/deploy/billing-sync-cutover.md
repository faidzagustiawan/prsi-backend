# Pemasangan kandidat sinkronisasi billing

Status: kode lokal dan pengujian terisolasi. Belum memasang rilis atau mengubah
database/konfigurasi produksi. Migrasi Track memerlukan jendela cutover yang
disetujui sesuai rencana kepemilikan data; aktivasi frontend tetap tim frontend.

Keputusan 20 Oktober 2026: gunakan [mode satu akun Track](SINGLE_ACCOUNT_SYNC.md)
karena provider tidak mengizinkan role tambahan. Mode restricted tetap opsi,
bukan prasyarat cutover.

## Persiapan rilis yang dapat ditinjau

1. Review perubahan pada kedua repo, migrasi SI `0009_billing_sync`, snapshot
   Drizzle, whitelist/fixture bersama, dan dokumen `docs/BILLING_SYNC.md`.
2. Di repo Track, jalankan `node staging/build-cutover.js`. Hasilnya
   `staging/generated/billing-v2-cutover.sql` berisi transaksi guarded. Generator
   tidak terhubung ke database. Review SQL dan rencana index/lock pada salinan
   terbaru dengan volume data sebenarnya. Kode staging asli tetap menolak prod.
3. Gunakan `TRACK_SYNC_DB_MODE=application`, pin `TRACK_SYNC_DB_USER`, dan satu DSN
   akun aplikasi yang sudah ada pada host Track. Tidak perlu pembuatan role/grants.
   Ikuti [panduan satu akun](SINGLE_ACCOUNT_SYNC.md). Secret disalurkan lewat kanal
   secret dan tidak dimasukkan ke argumen CLI atau Git. Bila memilih restricted
   kelak, ikuti [instruksi provider](ADMIN_PROVIDER_SYNC.md).
4. Siapkan EnvironmentFile root-only berdasarkan
   `staging/integration.env.example` dan unit `prtrack-integration.service`.
   Listener integrasi terpisah dari backend bisnis. Path Node pada unit harus
   diverifikasi saat deploy; saat ini contoh memakai Node 22.23.2 di host Track.

## Urutan staging dan UAT

1. Gunakan DB Track salinan tersanitasi dan DB SI staging terpisah. Snapshot
   salinan tidak boleh diperlakukan sebagai feed produksi. Identitas sync_feed
   harus unik untuk setiap sumber/restore baru.
2. Jalankan migrasi sync staging dan `node staging/migrate-billing.js` dengan
   identitas staging terverifikasi. Terapkan migrasi SI dengan `npm run db:migrate`.
3. Pasang listener integrasi dengan pool baca/tulis terpisah memakai akun Track
   yang sama dan mode application eksplisit. Worker SI memakai
   protokol v2, read token, write token berbeda, SESSION_DATABASE_URL session/direct,
   dbGuard aktif, ALLOW_UNSAFE_DB_ROLE=false. Untuk pengujian lintas host pakai HTTPS;
   HTTP hanya loopback development seperti suite lokal.
4. Muat tagihan, lalu aktifkan SI_BILLING_ENABLED hanya di staging. Aktifkan flag
   DB `si_billing_config.enabled` dan flag backend bisnis Track bersama sebelum
   menguji capture. Pembatasan tagihan yang sudah punya pembayaran tetap berlaku
   walau flag dikembalikan false.
5. UAT bersama Keuangan: booking fee, DP, angsuran, KPR aktual, pembayaran tagihan
   ke-2, penolakan, pengajuan ulang, adendum, pembatalan, periode terkunci, rekening
   tidak cocok, dan reversal. Sepakati penanganan saldo/pembayaran historis dan
   bukti lama. Pembayaran legacy tidak otomatis dianggap sah oleh kode baru.
6. Tim frontend memakai kontrak handoff; uji login/akses perusahaan/customer,
   dropdown tagihan, nominal terkunci, request_id yang dipertahankan saat retry,
   dan tampilan status hasil SI pada web/mobile. Backend tidak mengirim notifikasi
   pelunasan ketika yang baru diterima adalah pengajuan.
7. Gladi cutover dan rollback aplikasi minimal sekali di salinan. Bandingkan
   count, hash, isi, nominal per assignment, jurnal, dan alokasi.

## Cutover produksi setelah persetujuan

1. Bekukan input pembayaran/admin untuk jendela yang disepakati. Backup DB Track,
   schema finance SI, rilis, env, Nginx, dan unit. Verifikasi arsip/restore di
   lingkungan terpisah. Tidak perlu mengubah arah trafik VPS yang baru dimigrasi.
2. Migrasi Track kandidat memerlukan session settings
   `prtrack.target_database=<nama_database_yang_dikonfirmasi>` dan
   `prtrack.sync_migration_approved=billing-v2-20261019`. Verifikasi host/database/
   role sebelum mengisi setting; jangan menggunakan env production pada development.
   Script memakai lock_timeout 5 detik dan satu transaksi. Bila lock gagal, semua
   perubahan dibatalkan; jangan menaikkan timeout tanpa mencari pemegang lock.
3. Terapkan migrasi SI 0009 dengan koneksi migrator. Gunakan kredensial aplikasi
   Track hanya pada VPS Track, pin akun dan TRACK_SYNC_SOURCE_ID dari sumber
   sebenarnya, serta siapkan token API baca/tulis berbeda. Pasang kode Track/SI
   dengan seluruh gate tetap false. Test service/route tanpa mengirim uang/pesan.
4. Konfigurasi HTTPS `/sync/` ke listener 127.0.0.1:3202. Firewall/Nginx hanya
   mengizinkan SI; tidak ada wildcard binding. Jika melalui Cloudflare, validasi
   pemulihan IP asli dari rentang Cloudflare tepercaya sebelum memakai allowlist.
   Jangan mempercayai X-Forwarded-For dari semua pengirim. Token tetap wajib.
5. Pindah sumber SI melalui POST `/api/v1/sinkron/muat-ulang` dengan sourceId yang
   dikonfirmasi. Muat ulang tidak menghapus jurnal atau UUID lokal. Selesaikan
   rekonsiliasi ke sumber produksi; review `perlu_ditinjau` untuk data historis
   yang berbeda. Jangan menganggap cursor staging valid untuk produksi.
6. Jalankan `node scripts/sync-readiness.js` pada konfigurasi kandidat SI.
   Verifikasi mode application memakai akun Track yang dikonfirmasi tanpa hak admin.
   Periksa antrean/error, source identity, dan checksum tujuh entitas.
7. Baru setelah UAT saldo/riwayat dan UI lulus, aktifkan flag DB Track,
   SI_BILLING_ENABLED kedua backend, SYNC_ENABLED/SYNC_WRITE_ENABLED SI, serta
   SYNC_WRITE_ENABLED listener Track. Jalankan pembayaran fixture yang disepakati
   Keuangan, verifikasi jurnal/alokasi/customer total, lalu koreksi melalui reversal.
8. Buka kembali input dan pantau umur putaran, event held, outbox gagal, 409,
   jurnal tidak seimbang, salah tagihan, dan selisih rekonsiliasi.

## Rollback

Sebelum transaksi baru bertagihan: tahan semua kiriman/worker, matikan flag, dan
kembalikan rilis. Migrasi aditif dipertahankan; jangan DROP kolom/tabel atau restore
seluruh database Track secara otomatis.

Sesudah transaksi bertagihan: tahan input dan worker lebih dahulu, pertahankan
riwayat dan bukti, rekonsiliasi dengan Keuangan, lalu koreksi memakai jurnal balik.
Kembalikan rilis hanya ke versi yang memahami kolom baru. Mematikan flag tidak
membuka edit/hapus pembayaran bertagihan/terkunci dan tidak menghapus keputusan SI.
Jangan membuka input legacy sebelum mencegah pembayaran ganda atas tagihan sama.

## Batas bukti

Tes otomatis memakai dua PostgreSQL lokal dengan fixture sintetis. Kesiapan
provider produksi, deployment lintas host, UAT pengguna, saldo historis, dan UI
harus dibuktikan dalam gladi. Dokumen ini tidak menyatakan tahapan tersebut lulus.
