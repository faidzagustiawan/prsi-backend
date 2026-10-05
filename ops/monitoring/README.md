# PRSI monitoring — status 5 Oktober 2026

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

`sync_entity_match`: 1 = count/content_hash cocok saat pengamatan; -1 = pending/unknown; 0 = tiga pengamatan berbeda berurutan dengan sumber stabil dan PRSI tidak held. Nilai 0 belum membuktikan korupsi: worker bisa tertinggal atau sengaja mati. Kegagalan fetch mereset streak. Perubahan watermark saja tidak mereset streak karena transaksi unrelated juga memajukan xmin. Counter kejadian mismatch dan waktu match terakhir disimpan atomik dalam volume `checker-state`; setelah restart tetap perlu sampel baru. State rusak dipertahankan dan memicu `sync_checker_storage_success=0`.

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
