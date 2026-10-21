# Validasi mode satu akun Track — 20 Oktober 2026

Perubahan lokal: listener mendukung TRACK_SYNC_DB_MODE=application dengan pin
TRACK_SYNC_DB_USER. Akun aplikasi Track yang sudah ada dipakai untuk kedua pool.
Kredensial Track tetap pada host Track; SI hanya memakai kontrak HTTP. Tidak ada
perubahan pada dbGuard SI, kredensial bisnis, schema tambahan, atau data produksi
dalam perubahan mode ini. Migrasi billing kandidat sebelumnya tetap diperlukan.

## Hasil

| Pemeriksaan akhir | Hasil |
| --- | --- |
| Integrasi dua database kosong baru, fixture sintetis | 21/21 lulus |
| Unit Track | 10/10 lulus |
| ESLint src/sync-server.js --quiet | Tidak ada error |
| Pemeriksaan sintaks listener dan suite integrasi | Lulus |
| git diff --check kedua repo | Tidak ada error whitespace |

Jumlah runner integrasi mencakup satu harness induk. Baseline SI/regresi backend
tercatat pada billing-sync-validation-20261019.md; source runtime SI tidak diubah
untuk mode satu akun. PostgreSQL lokal versi 18.4; gladi PostgreSQL 16.14 dan
deployment lintas host tetap belum dibuktikan.

Tes baru membuat fixture akun aplikasi nonadmin pada cluster lokal, memberikan
kepemilikan tujuh tabel sumber dan hak tabel integrasi sesuai migrasi oleh pemilik,
lalu memastikan rolcreaterole=false. Pembuatan fixture oleh harness bukan bagian
dari startup listener/deployment dan tidak memerlukan role baru di produksi.

Terbukti melalui proses listener sebenarnya:

- Akun aplikasi ditolak pada mode default restricted, dan diterima hanya pada
  mode application dengan pin akun/sumber yang benar.
- Mode tidak dikenal, pin kosong/salah, akun superuser, DSN writer berbeda,
  sumber salah, dan token baca/tulis sama menghentikan startup.
- SI HTTP client dapat membaca snapshot customer yang hanya memuat whitelist,
  tanpa password_hash.
- Token baca tidak dapat menulis jadwal atau membaca snapshot billing khusus
  writer. Payload dengan field SQL tambahan ditolak dan tidak ada endpoint SQL.
- Writer dapat menerima jadwal, mengulang key yang sama, dan menolak key yang
  dipakai untuk payload berbeda. Dengan write flag false endpoint tulis ditutup.
- Mode restricted tetap dapat berjalan dengan role terbatas yang lama.

Suite yang sama juga mengulang alur pembayaran/jurnal, adendum/reversal, retry,
source mismatch, bootstrap/resnapshot, retensi, commit terlambat, rekonsiliasi
balik, guard migrasi, dan invariant keuangan/cermin yang sebelumnya lulus.

## Batas penerimaan produksi

Role tambahan tidak lagi menjadi gate. Tetap perlukan backup/restore, gladi pada
PostgreSQL 16, HTTPS/allowlist lintas host, UAT Keuangan dan saldo historis, UAT
frontend, serta cutover yang disetujui. Pembatasan mode aplikasi berada pada API,
bukan ACL database; akun pemilik tetap mempunyai hak database luas.

Ikuti SINGLE_ACCOUNT_SYNC.md dan billing-sync-cutover.md. Kode/config produksi
belum diubah dan sinkronisasi produksi belum diaktifkan dalam pekerjaan ini.
