# Integrasi SI–Track memakai akun Track yang sudah ada

Keputusan pemilik, 20 Oktober 2026: provider tidak mengizinkan penambahan role.
Gunakan akun aplikasi Track yang sudah ada untuk listener integrasi pada VPS
Track. Pembuatan dua role integrasi dan berkas grants bukan prasyarat jalur ini.
Dokumen ini menggantikan langkah provisioning provider pada kandidat sebelumnya.

## Batas akses

```text
SI (database SI sendiri) → HTTPS + token API → listener Track → database Track
```

Kredensial database Track hanya disimpan pada host Track. SI tidak mengakses
database Track langsung. dbGuard SI tetap aktif; ALLOW_UNSAFE_DB_ROLE tetap false.
Backend bisnis, database SI, dan kontrak API billing tidak berubah karena pilihan
mode ini. Frontend tetap mengikuti kontrak API pada docs/BILLING_SYNC.md.

Mode aplikasi memerlukan identitas akun eksplisit. Listener memastikan akun itu
memiliki tujuh tabel sumber Track dan bukan superuser, CREATEDB, CREATEROLE,
REPLICATION, atau BYPASSRLS. Koneksi baca dan tulis memakai satu connection string
dengan dua pool terpisah, masing-masing maksimum tiga koneksi. Pool baca memakai
transaksi read-only sebagai pencegahan kesalahan, bukan pembatas hak akun.
Kedua pool menetapkan statement timeout dan idle transaction timeout 15 detik,
serta lock timeout 5 detik pada sesi listener, tanpa mengubah default akun bisnis.

Karena akun pemilik memiliki akses luas, pembatasan integrasi ditegakkan oleh
kode API. Bila listener atau kredensialnya dibobol, dampak ke database lebih luas
dibanding mode role terbatas. Mode ini tidak memberikan isolasi ACL per kolom.
Jangan memberi endpoint untuk SQL bebas, nama tabel bebas, atau konfigurasi
database melalui request. Listener hanya mendaftarkan kontrak sync dan billing
yang telah ditentukan; snapshot memakai whitelist kolom dan payload tulis strict.

## Konfigurasi di VPS Track

Gunakan EnvironmentFile root-only terpisah berdasarkan
`Podorukuntrack/backend/staging/integration.env.example`. Jangan menyalin isi
file secret ke chat/Git. Listener tidak memuat dotenv atau memulai worker bisnis.

```dotenv
TRACK_SYNC_DB_MODE=application
TRACK_SYNC_DB_USER=<akun-aplikasi-track-terkonfirmasi>
TRACK_SYNC_HOST=127.0.0.1
TRACK_SYNC_PORT=3202
TRACK_SYNC_ALLOWED_IPS=127.0.0.1
TRACK_SYNC_WRITER_DATABASE_URL=
SYNC_WRITE_ENABLED=false
SI_BILLING_ENABLED=false
```

TRACK_SYNC_DB_USER diisi akun yang dikonfirmasi pemilik melalui DBeaver (nama tidak dicatat di Git);
konfirmasi ulang bila akun/database provider berubah. Isi TRACK_SYNC_DATABASE_URL
dengan kredensial akun Track melalui kanal secret pada host Track. Isi
TRACK_SYNC_SOURCE_ID dari sync_feed database target setelah migrasi. Sediakan
TRACK_SYNC_TOKEN dan TRACK_SCHEDULE_TOKEN yang berbeda, masing-masing minimal
32 karakter, serta TRACK_MONITOR_TOKEN bila monitoring digunakan. Nilai secret
sengaja tidak dimasukkan contoh ini.

TRACK_SYNC_WRITER_DATABASE_URL dikosongkan pada mode application. Jika diisi,
nilainya harus sama persis dengan TRACK_SYNC_DATABASE_URL; listener tidak menerima
database/akun writer terpisah secara tidak sengaja. Bila menyalin env dari rilis
lama, hapus nilai writer lama sebelum menggunakan mode application.

Tanpa TRACK_SYNC_DB_MODE, kode tetap memakai mode restricted dan menolak akun
pemilik luas. Salah eja mode, pin akun salah, pin sumber salah, akun admin, atau
token baca/tulis sama akan menghentikan startup. Penolakan ini tidak boleh
diselesaikan dengan mengubah dbGuard SI atau menaikkan hak akun.

## Urutan penerapan

1. Review kode dan gladi pada PostgreSQL 16 terpisah dengan salinan tersanitasi.
   Terapkan migrasi sync/billing Track sebagai akun aplikasi pemilik tabel dan
   migrasi SI sebagai migrator SI. Tidak perlu menjalankan integration-roles.sql
   atau integration-grants.sql. Jangan memakai akun Track untuk migrasi SI.
2. Pada jendela produksi yang disetujui, backup/restore dan terapkan migrasi
   guarded sesuai runbook. Pembuatan tabel/trigger masih diperlukan walaupun tidak
   membuat role baru. Kredensial dan hak akun bisnis tidak perlu diubah.
3. Pasang EnvironmentFile dan unit prtrack-integration.service; mulai dengan
   SYNC_WRITE_ENABLED=false. Konfirmasi health dan endpoint baca dengan read token.
   Proses melaporkan mode application tanpa menampilkan kredensial.
4. Pasang HTTPS/Nginx untuk /sync/ menuju listener loopback. Batasi alamat SI pada
   Nginx/firewall; Fastify trustProxy=false melihat alamat proxy lokal. Allowlist
   loopback pada aplikasi tidak menggantikan allowlist IP SI di reverse proxy.
   Jangan menerbitkan listener atau database langsung ke internet.
5. Pada SI, isi URL API dan token terpisah, protokol v2 dan session DSN SI yang
   benar. Selesaikan bootstrap/resnapshot dan rekonsiliasi terkendali sesuai
   runbook. Jangan menaruh DSN Track pada env SI.
6. Luluskan UAT Keuangan/saldo lama dan frontend, lalu aktifkan gate billing dan
   write secara terkoordinasi. Periksa jurnal, alokasi, total Track, retry dan
   rekonsiliasi kedua arah sebelum membuka input.

Menjalankan SQL pembuatan role di DBeaver tidak diperlukan untuk jalur ini.
Jangan menjalankan migrasi produksi ad hoc hanya untuk mencoba konfigurasi.

## Rollback konfigurasi

Tahan input/worker dan kiriman sebelum mengganti konfigurasi. Mematikan
SYNC_WRITE_ENABLED menghentikan endpoint tulis pada listener setelah restart.
Jangan menghapus tabel/riwayat atau melepas kunci pembayaran saat rollback.

Mode restricted tetap tersedia jika provider kelak menyediakan dua role: pasang
grants yang direview, gunakan dua DSN terbatas, set TRACK_SYNC_DB_MODE=restricted,
lalu uji startup sebelum membuka kiriman. Rilis listener lama belum mendukung
mode application dan akan menolak akun luas; jangan rollback ke rilis tersebut
tanpa lebih dahulu menghentikan integrasi atau menyediakan role terbatas.
