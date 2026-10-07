# PRSI monitoring

## Status terbaru — 7 Oktober 2026

PR #5 di-merge pemilik pada 06:40:53 UTC. Rilis backend `dd3610d` (main, termasuk PR #6 CORS/Bearer yang sudah aktif sebelumnya) sudah dipasang dengan backup finance, smoke port3199, swap, smoke port3100, dan pemeriksaan domain publik. Tidak ada migrasi, sinkronisasi satu kali, atau worker baru.

- Ketujuh entitas cocok pada count, hash versi, dan content_hash. Seluruh 14 gauge invariant bernilai 0, collection_success=1, sync_error=0, outbox_failed=0. Ini bukti Track **staging** versus mirror PRSI pada waktu pengamatan, bukan monitoring Track production.
- Token kosong/salah mendapat 401, token benar 200 lewat listener privat. Public `/internal`, `/internal/metrics`, `/internal/checksum/companies` mendapat 404; health/OpenAPI publik 200 dari Windows. Probe Python dari VPS aplikasi mendapat 403 Cloudflare untuk semua path termasuk health; hasil tersebut tidak dipakai sebagai bukti penolakan nginx.
- Bind privat saja ternyata tidak memblokir NAT IP publik Tencent: 9443 sempat menerima koneksi dan nginx memberi 403. Kini aturan INPUT khusus 9443 hanya menerima sumber 10.11.20.216. Uji ulang seluruh port internal dari Windows tidak berhasil terhubung. SSH/API dan kebijakan firewall lainnya tidak diubah. Unit `prsi-ops-firewall` memasang aturan sebelum nginx pada boot.
- Checker hanya menetapkan mismatch isi jika jumlah dan hash versi cocok, sumber stabil, tidak held, dan beda isi terjadi tiga kali. Perbedaan versi/jumlah tetap pending. `SyncLag` tidak lagi memakai umur siklus atau durasi perbedaan sebagai umur event. `SyncDifferenceObserved` memberi peringatan terpisah setelah perbedaan teramati >10 menit. Umur event sumber tetap tidak tersedia dari kontrak checksum.
- Backup harian disetujui pemilik: timer `prsi-backup.timer`, 02:00 Asia/Jakarta + jitter maksimum lima menit, retensi tujuh hari. Arsip root-only di `/var/backups/podorukun-si/daily/` berisi finance.dump, lampiran, environment dan konfigurasi nginx/job; SHA256SUMS dan COMPLETE hanya setelah validasi. Keberhasilan memperbarui `/var/lib/prsi-monitoring/backup.timestamp` (root:podorukun-si,0640). File ini menjadi PRSI_BACKUP_TIMESTAMP_FILE. Dua backup awal berhasil; terakhir `20261007T065811Z`. Backup lokal VPS ini belum merupakan salinan disaster recovery di host lain.
- Pembaruan stack pertama rollback otomatis; konfigurasi lama kembali sehat. Readiness Grafana sekarang memakai retry seperti Prometheus/Alertmanager, ditambah checker/ntfy. Pembaruan berikutnya berhasil. Backup stack `/var/backups/prsi-monitoring/20261007T065030Z`; konfigurasi sebelumnya `/opt/prsi-monitoring.prev-20261007T065328Z`.
- RAM VPS saat sampel: 701/1967 MiB, available1266 MiB; delapan container sekitar183 MiB, limit total1216 MiB. Disk9.4/40GB (25%). Loki/Alloy tetap fase2.

Backup backend pertama `/var/backups/podorukun-si/pre-monitoring-20261007T064544Z`; rilis sebelumnya `/opt/podorukun-si/app.prev-20261007T064544Z`. Aktivasi timestamp backup juga melalui deployment aman, backup `/var/backups/podorukun-si/pre-monitoring-20261007T064905Z`, previous `/opt/podorukun-si/app.prev-20261007T064905Z`. Backup nginx sebelum penolakan publik `/var/backups/podorukun-si/internal-deny-20261007T064309Z`. Pertahankan penolakan publik saat rollback.

Rollback rilis terakhir (dijalankan hanya bila diperlukan; tidak mengembalikan database):

```sh
sudo bash -c 'set -e; cd /opt/podorukun-si; test ! -e app.failed-manual-20261007; mv app app.failed-manual-20261007; mv app.prev-20261007T064905Z app; systemctl restart podorukun-si-api; curl --fail --max-time 15 http://127.0.0.1:3100/health'
```

Untuk kembali ke rilis sebelum monitoring gunakan previous `064544Z`, lalu verifikasi health; listener tetap tertutup publik. Skrip deploy mempunyai rollback otomatis bila health/smoke pascaswap gagal. Jalur gagal backend belum sengaja dipicu pada produksi; rollback stack monitoring benar-benar teramati. Restore finance ke database aktif tidak dilakukan. Arsip lolos pg_restore --list dan hash; uji restore terisolasi penuh masih diperlukan sebelum mengklaim disaster recovery tervalidasi.

Validasi kode: 55 tes non-DB lulus, lint0 error/31 warning lama, db:check6 migrasi aman. Pengulangan tiga tes DB/vectors terhalang ECONNREFUSED localhost:5433: PostgreSQL Windows berhenti dan akun sesi tidak punya hak menyalakan service. Fixture tidak diubah (SHA256 tetap 474c7a7a23997417bf7df93ce5a1ba107e848707927207218fdc048a822f5ea2); kelulusan57 tes pada5 Oktober tetap bukti historis, bukan hasil ulang hari ini.

Dashboard diprovisi dan query data nyata terverifikasi lewat API. Screenshot baru terhalang runtime browser: `windows sandbox failed: setup refresh had errors`; screenshot5 Oktober tetap tersedia dan tidak dianggap tampilan setelah deploy. Notifikasi FIRING/RESOLVED dan restore SQLite memakai bukti pengujian5 Oktober; tidak diulang tanpa kebutuhan. Pemilik belum mengetahui mode SSL zona faidz.fun: perlu cek **SSL/TLS → Overview → Full (strict)**, tanpa perubahan otomatis oleh sesi ini.

Langganan HP: tambahkan server `https://ntfy.faidz.fun` di aplikasi ntfy, login `owner` memakai password root-only di `/etc/prsi-monitoring/secrets/ntfy-password`, lalu subscribe topik `prsi-alerts`. Grafana login `admin`, password `/etc/prsi-monitoring/secrets/grafana-password`. Jangan menyalin password ke chat.

Bukti baru: `docs/deploy/evidence/monitoring-20261007/`. Verifikasi akhir menunjukkan tujuh target up, dua probe_success=1, tujuh checker match=1, dan tidak ada alert aktif. Sebelum verifikasi akhir, API ditemukan inactive dengan lifecycle stop normal (15:00:27 waktu server/CST); kemudian pulih. Log juga mencatat stop/start singkat15:10. Penyebab penghentian belum teratribusi; bukan bukti crash atau gagal query. Service dipastikan berjalan kembali dan monitoring menangkap kondisi gagal. Jangan menyimpulkan stabilitas jangka panjang hanya dari sampel akhir ini.

Infrastruktur dan perbandingan staging telah aktif; konfirmasi Cloudflare, screenshot terbaru, pengulangan tes DB lokal, penelusuran penghentian API, dan latihan restore penuh masih terbuka. Tidak ada izin cutover Track production.

## Catatan historis — 5 Oktober 2026

Branch `codex/integrity-monitoring`, base `5c40db5`. Backend baru belum dipasang: pemilik yang merge, deployment hanya setelah merge. Track production, frontend, Cloudflare zone, dan worker permanen tidak diubah.

## Hasil aktual

Validasi akhir: **57/57 tes lulus**, lint 0 error/31 warning, enam migrasi aman.

- Checksum PRSI mengikuti spesifikasi Track setelah persetujuan pemilik: projects tanpa kode, customers nama/email/nomor_telepon saja, tanggal_pembelian sebagai date. Field opsional tetap dapat disimpan mapping bisnis; perubahan ini hanya menentukan checksum.
- Fixture Track 21 baris tetap utuh. Kedua salinan PRSI (`test/fixtures` dan `sync-tests/fixtures`) memiliki SHA-256 `474c7a7a23997417bf7df93ce5a1ba107e848707927207218fdc048a822f5ea2`.
- Tes PostgreSQL hanya pada localhost `podorukun_si_dev`, diaktifkan dengan `MONITOR_TEST_DB=local`. Seluruh query invariant dan tujuh mirror dikompilasi terhadap schema dev nyata; fixture sementara/rollback menguji pelanggaran, FK lokal-ke-Track, whitespace, timestamp, JSON, dan tombstone.
- VPS monitoring menjalankan delapan container. Prometheus menyimpan 30 hari, maksimum 8 GB. Total batas RAM 1216 MiB; sampel setelah restart sekitar 230 MiB, sampel awal 544 MiB. Penggunaan dinamis dan tidak termasuk OS. Disk 9.2/40 GB (25%).
- Prometheus dan Alertmanager lolos validator. Dua `probe_success` bernilai 1: API publik PRSI dan health Track privat.
- Exporter aplikasi terpasang pada `10.11.26.196:9100`; hanya localhost/10.11.20.216 diizinkan systemd. Collector systemd sukses dan kedua service API aktif. Akun sistem `prsi-node-exporter` tanpa login diperlukan; DynamicUser gagal autentikasi D-Bus pada host ini.
- Alert nyata diuji dengan menghentikan exporter VPS monitoring saja. ntfy menerima FIRING dan RESOLVED untuk MonitoringTest, selesai 23:21 WIB. Target dan aturan tes dipulihkan.
- Probe dari Windows eksternal: seluruh port internal aplikasi (3100,3201,9100,9443) dan monitoring (3000,8085,9090,9093,9100,9115,9199) timeout.
- Backend aktif tidak direstart. `ALLOW_UNSAFE_DB_ROLE=false`, `SYNC_ENABLED=false`, `SYNC_WRITE_ENABLED=false` terverifikasi; dbGuard tidak diubah.

## Akses

- Grafana: https://monitor.faidz.fun/d/prsi-monitoring, admin; password root-only `/etc/prsi-monitoring/secrets/grafana-password` pada VPS monitoring.
- ntfy: https://ntfy.faidz.fun, owner, topik `prsi-alerts`; password `/etc/prsi-monitoring/secrets/ntfy-password`.
- Track checksum: `http://10.11.26.196:3201/sync/v2/checksum/{entity}`. Checker memakai `/etc/prsi-monitoring/secrets/track-token`, disalin dari root-only `/etc/prtrack-monitoring/track-staging-token`. Ini token checksum, bukan token baca sync.
- PRSI checksum setelah deploy: `http://10.11.26.196:9443/internal/checksum/{entity}`. Token `/etc/prsi-monitoring/secrets/prsi-token` perlu disalurkan melalui kanal secret ke file root-only VPS aplikasi sebelum deploy.
- `/internal/metrics` dan `/internal/checksum/*` membutuhkan bearer token, tidak tampil di OpenAPI, serta dibatasi rate limit. Nginx publik wajib 404 untuk `/internal` dan `/internal/*` sebelum backend baru diaktifkan. Listener ops privat hanya mengizinkan 10.11.20.216.
- Tidak pernah menaruh secret di command arguments, sudo env, log, Git, screenshot atau chat. Jangan menampilkan `docker inspect` environment atau `docker compose config` tanpa `--quiet`.

## Interpretasi checksum dan invariant

Track memberi `{count,hash,content_hash,watermark}`; PRSI memberi `{count,hash,content_hash,cursor,held}`. Semua checksum satu endpoint memakai snapshot repeatable-read read-only. Hash dihitung dari raw dan track_id dalam PostgreSQL agar numeric/mikrodetik utuh, bukan angka/Date JavaScript.

Watermark xmin Track bukan cursor event terakhir. Checker tidak membandingkannya dengan cursor PRSI dan tidak mengarang status held Track. `sync_cursor_lag_seconds` tetap NaN karena umur/posisi sumber tidak tersedia. `sync_observed_difference_seconds` adalah lama perbedaan yang teramati, bukan umur event.

`sync_entity_match`: 1 = count/content_hash cocok saat pengamatan; -1 = pending/unknown; 0 = tiga pengamatan isi berbeda berurutan dengan sumber stabil, jumlah dan hash id:version sama, serta PRSI tidak held. Bila versi/jumlah berbeda atau hash versi tidak tersedia, status tetap pending karena lag belum dapat dikesampingkan. Nilai 0 bukan pembuktian matematis korupsi. Kegagalan fetch mereset streak. Perubahan watermark saja tidak mereset streak karena transaksi unrelated juga memajukan xmin. Counter kejadian mismatch dan waktu match terakhir disimpan atomik dalam volume `checker-state`; setelah restart tetap perlu sampel baru. State rusak dipertahankan dan memicu `sync_checker_storage_success=0`.

Hash versi disediakan untuk diagnosis; kecocokan isi tidak mensyaratkan versi sama. Hash tujuh request bukan snapshot global. MD5/pemisah tanpa escaping/sentinel null mengikuti kontrak bersama dan tidak membuktikan kesamaan matematis mutlak. Jangan mengganti fixture atau encoding sepihak.

Invariant membaca count saja, cache setiap lima menit, transaksi read-only dengan timeout per query. Scrape tidak menjalankan SQL. Jika query gagal, cache lama ditandai gagal/stale, tidak dinyatakan sehat. Angka nol perlu dibaca bersama collection_success, age, dan up.

Batas invariant:
- Typed mirror dibandingkan dengan hasil transformasi mapping, termasuk trim JavaScript dan timestamp milidetik. Raw masih mempertahankan mikrodetik untuk content checksum. Numeric typed mengikuti presisi schema, sehingga rounding/loss di typed dapat terdeteksi.
- `review_older_than_seven_days` memakai updated_at: mendeteksi review yang tidak disentuh tujuh hari, bukan tanggal pertama masuk review. Pemrosesan ulang dapat mereset waktunya; belum ada history status khusus.
- Pemeriksaan periode tertutup mendeteksi draft/posting/perubahan header setelah penutupan. Status dikoreksi diizinkan untuk reversal yang sah; tanpa audit snapshot detail, pemeriksaan ini tidak menjamin semua edit historis terdeteksi.
- Pemeriksaan neraca adalah keseimbangan agregat jurnal/saldo awal yang terbuku, bukan audit kebenaran klasifikasi akun atau seluruh aturan akuntansi.
- Backup age hanya sehat bila ada file epoch dari backup yang benar-benar berhasil, dikonfigurasi dengan PRSI_BACKUP_TIMESTAMP_FILE. Belum ada bukti backup harian otomatis aplikasi pada pekerjaan ini; nilai unknown harus tetap terlihat.

## Backup, deploy monitoring, dan rollback yang sudah diuji

VPS monitoring: `/var/backups/prsi-monitoring/20261005T161347Z` berisi config+secret dan enam volume awal. Stack dihentikan singkat untuk salinan konsisten, lalu dihidupkan kembali melalui trap. Arsip diperiksa dan SHA256SUMS disimpan. Script sekarang juga menyertakan checker-state bila ada.

Latihan deploy menggunakan `MONITOR_ROLLBACK_TEST=true` memaksa kegagalan setelah pertukaran direktori. Trap mengembalikan direktori lama dan merecreate container; Prometheus ready dan database Grafana ok terverifikasi. Setelah itu kandidat berhasil dideploy normal. Konfigurasi sebelumnya: `/opt/prsi-monitoring.prev-20261005T161538Z`.

Backup checker lanjutan: `/var/backups/prsi-monitoring/checker-20261005T163110Z` (kode dan counters sebelum perbaikan persistence).

Restore Grafana/ntfy ke `/var/tmp/prsi-monitor-restore-20261005T162746Z` berhasil; integrity_check grafana.db, auth.db, cache.db semuanya ok. Ini bukan latihan restore penuh TSDB Prometheus. Direktori restore mengandung kredensial dan harus tetap root-only.

Backup sebelum pemasangan exporter: `/var/backups/podorukun-si/node-exporter-20261005T162205Z`. Rollback exporter: stop/disable hanya `prsi-node-exporter.service`; jangan menghentikan backend. Bila binary/unit sebelumnya ada, pulihkan dari backup lalu daemon-reload. Tidak ada firewall global aplikasi yang diubah.

Untuk perubahan monitoring berikutnya: buat backup dulu (`bash backup-stack.sh`), siapkan kandidat lengkap di direktori terpisah, lalu `bash candidate/deploy-stack.sh /absolute/candidate`. Script memvalidasi config, menukar direktori, memeriksa readiness, dan mengembalikan config lama jika gagal. Rollback database/volume tidak otomatis karena perubahan ini hanya konfigurasi/kode monitoring.

## Deployment backend — menunggu pemilik merge

1. Pemilik review dan merge PR. Fetch origin/main dan verifikasi commit release merupakan ancestor main. Buat uncompressed `git archive --format=tar <commit>`; jangan menyalin working tree atau `.env` ke archive.
2. Backup konfigurasi nginx. Pasang deny exact `/internal` dan prefix `/internal/` dari `app-public-internal.nginx.conf` ke SETIAP server publik; `nginx -t` sebelum reload. Jangan membuka endpoint internal ke domain publik.
3. Salurkan prsi-token ke file root-only pada VPS aplikasi melalui SSH/secret manager. Jangan memakai token Track untuk PRSI.
4. Jalankan deploy-app.sh dari rilis reviewed dengan MERGED_COMMIT_CONFIRMED berisi SHA yang sudah diverifikasi merged, serta argumen path archive dan path token (bukan isi token). Script menolak archive berbeda, traversal, symlink, atau credential di archive.
5. Script membuat backup aplikasi/config dan dump finance read-only, menyiapkan direktori terpisah, menjaga tiga safety gate false, memasang dependency, smoke port3199, menukar direktori, restart backend, lalu smoke dan public404. Kegagalan setelah swap memulihkan direktori lama dan mencoba health ulang. Tidak menjalankan migrasi atau worker.
6. Pasang listener nginx ops dari app-ops.nginx.conf setelah smoke backend lulus; backup, nginx -t, reload dengan rollback konfigurasi jika gagal. Listener 10.11.26.196:9443 hanya untuk 10.11.20.216. Tidak ada proxy Track: checker langsung memakai port3201.
7. Verifikasi target PRSI up, collection sukses/fresh, tujuh checksum, semua invariant, public404, dan port publik tetap tidak terjangkau. Simpan bukti. Jangan menyatakan tujuh entitas cocok sebelum benar-benar teramati.

Skrip backend sudah direview dan lolos sintaks; deployment/rollback aplikasi terhadap layanan aktif BELUM dijalankan karena menunggu merge. Smoke baru akan membuktikan kompatibilitas query pada PostgreSQL target. Pengujian SQL sesi ini hanya memakai database dev localhost.

## Yang masih tertunda

- Merge oleh pemilik, deployment backend, token PRSI di VPS aplikasi, listener nginx privat, dan verifikasi publik 404 pascadeploy.
- Bukti E2E tujuh entitas cocok serta invariant nol. Saat ini dashboard secara benar menampilkan unknown/pending; scrape checker up bukan bukti data cocok.
- Bila mirror tertinggal, tindakan sinkronisasi satu kali perlu otorisasi terpisah; jangan mengaktifkan worker permanen atau mengubah gate false.
- Konfirmasi Cloudflare Full (strict) untuk domain monitoring/ntfy oleh pemilik; setting zona tidak disentuh.
- Kebijakan backup aplikasi harian dan timestamp evidence; Loki/Alloy tetap fase2.

Bukti nonsecret dan screenshot: `docs/deploy/evidence/monitoring-20261005/`.
