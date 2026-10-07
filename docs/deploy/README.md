# Deployment backend/API

Pemilik menangani backend, database, dan arsitektur sistem saja. Frontend berada
di luar lingkup pemilik. VPS 43.173.11.71 hanya untuk backend/API. Jangan
menyimpan build frontend atau memasang SPA fallback. Lihat AGENTS.md.

## Konfigurasi aktif

- Origin API: https://podorukunsi.my.id, prefix /api/v1, health /health.
- Backend: /opt/podorukun-si/app, bind 127.0.0.1:3100.
- Service: podorukun-si-api.service, user podorukun-si.
- Environment: /opt/podorukun-si/app/.env, mode 0600, pemilik podorukun-si.
- Redis: loopback. Lampiran: /var/lib/podorukun-si/lampiran.
- Nginx: /etc/nginx/sites-available/podorukun-si; salinan lokal podorukun-si.nginx.conf.
- Cloudflare proxy aktif, SSL Full (strict); sertifikat origin Let's Encrypt.
- Timer renewal dan hook reload Nginx aktif; simulasi renewal sudah lulus.
- Pemulihan IP klien mempercayai hanya rentang resmi Cloudflare melalui
  /etc/nginx/conf.d/podorukun-si-cloudflare.conf.
- Domain frontend eksternal belum diberikan. Sesuaikan FRONTEND_URL setelah
  domain dikonfirmasi dan periksa kebutuhan cookie lintas situs.

## Database

Lima migrasi sudah diterapkan ke database SI Sumobase db13052556d1ee44f1.
Pemilik memilih satu akun untuk runtime, laporan, dan migrasi. Setup yang dipakai:
database/setup/sumobase-single-role.sql. Schema aplikasi finance;
hak CREATE akun sendiri pada public dicabut. dbGuard aktif dan
ALLOW_UNSAFE_DB_ROLE=false.

Akun pemilik masih dapat memberikan kembali haknya dan mengubah struktur finance;
laporan tidak dibatasi read-only oleh role database. Ini bukan pemisahan tiga role.
SQL sumobase-production.sql adalah alternatif tiga role yang tidak dipakai.

Runtime memakai transaction pooler, migrasi memakai direct connection. Variabel
migrator tidak disalin ke environment runtime VPS. SYNC_ENABLED=false;
data dummy bisnis belum di-seed.

Akun awal admin@gmail.com (admin); password acak tersimpan hanya di file lokal
`.env.admin-login` lokal yang tercakup aturan ignore .env.*.

## Operasional

Validasi nginx -t sebelum reload proxy. Restart backend dengan
systemctl restart podorukun-si-api, lalu periksa
curl --fail https://podorukunsi.my.id/health.

Backup backend dan konfigurasi sebelum deployment berada di
/var/backups/podorukun-si/pre-online-20261004T075303Z. Database dan unggahan
harus masuk kebijakan backup tersendiri. Jangan membalik migrasi atau menghapus
schema otomatis saat rollback aplikasi.

Verifikasi 4 Oktober 2026: 37 tes backend lulus, lint tanpa error (26 warning),
health DB/Redis normal, login/profil/refresh/logout API berhasil.
Swagger UI sudah diganti dengan Scalar lokal (devDependency). Audit dependency
produksi setelah penggantian tidak menemukan kerentanan yang dilaporkan npm.

## Deploy 5 Oktober 2026 (main `a2868ff`)

Kode `main` setelah PR #3 (kontrak sinkron v2) dipasang. Rilis ini juga membawa commit `main` 4 Oktober yang belum pernah terpasang: modul backend, Scalar/OpenAPI, dan perbaikan validasi.

Cara deploy:
1. Rilis dibangun di `app.new`, lalu `npm ci --omit=dev` (104 paket).
2. Rilis diuji di port 3199 sementara service lama tetap melayani.
3. Direktori ditukar, kemudian service di-restart.

Konfigurasi:
- `.env` hanya ditambah `SYNC_WRITE_ENABLED=false`.
- `SYNC_ENABLED=false` tetap. `SYNC_PROTOCOL` tidak di-set, sehingga default `v1`.
- `TRACK_SCHEDULE_TOKEN` tidak diubah. Gate menahan PUT selama `SYNC_WRITE_ENABLED=false`.

Hasil verifikasi:
- Health lokal dan publik 200 (database dan Redis ok).
- `/openapi.json` 200, `/api/v1/sinkron/status` tanpa login 401, `/login` 404.
- Journal tanpa warning.

Backup:
- Folder `/var/backups/podorukun-si/pre-v2-deploy-20261005T102757Z/` berisi app tanpa `node_modules`, `.env`, kedua unit systemd, dan dump schema finance.
- Direktori rilis lama: `/opt/podorukun-si/app.prev-20261005T102908Z`.

Rollback aplikasi (migrasi 0005 bersifat aditif, jadi tidak perlu dibalik):

```
cd /opt/podorukun-si && sudo mv app app.failed && sudo mv app.prev-20261005T102908Z app && sudo systemctl restart podorukun-si-api
```

`podorukun-si-worker.service` masih berstatus enabled tetapi inactive. Unit itu langsung keluar karena `SYNC_ENABLED=false`.

## Deploy 7 Oktober 2026 (`3eecdef`, PR #6)

CORS terbuka untuk masa uji frontend dan token Bearer di body login/refresh.
Commit `3eecdef` berbasis `main` `5c40db5`; PR #6 belum di-merge saat deploy.

Cara deploy sama dengan 5 Oktober: rilis di `app.new`, `npm ci --omit=dev`
(104 paket), uji port 3199, tukar direktori, restart `podorukun-si-api`.

Konfigurasi: `.env` hanya ditambah `CORS_ALLOW_ALL=true`. Kembalikan ke `false`
dan isi `FRONTEND_URL` setelah domain frontend dikonfirmasi.

Nginx menyajikan `/openapi.json` dan `/docs/scalar.html` dari berkas statis di
`/var/www/podorukun-si-docs/`, bukan dari app. Berkas ini dibangun ulang dengan
`npm run docs:build` dan diganti pada deploy ini (sebelumnya versi 4 Oktober).

Hasil verifikasi publik: health 200 (DB/Redis ok); preflight dari
`http://localhost:5173` 204 dengan `access-control-allow-origin` sesuai;
refresh tanpa body dan dengan body ditangani; Bearer tidak valid 401;
`/login` 404; OpenAPI publik memuat `bearerAuth` dan token di respons login.

Backup: `/var/backups/podorukun-si/pre-cors-bearer-20261007T060338Z/` (app tanpa
`node_modules` termasuk `.env`, unit systemd, dokumen statis lama; 700/600 root).
Rilis lama: `/opt/podorukun-si/app.prev-20261007T060531Z`.

Rollback aplikasi:

```
sudo mv /opt/podorukun-si/app /opt/podorukun-si/app.failed && sudo mv /opt/podorukun-si/app.prev-20261007T060531Z /opt/podorukun-si/app && sudo systemctl restart podorukun-si-api
```

## Dokumentasi API

Backend menyediakan GET /openapi.json. Endpoint ini hanya mengembalikan kontrak
JSON; tidak ada UI dokumentasi di VPS. Scalar dibangun/dibuka pada komputer lokal
melalui scripts/build-api-docs.js dan scripts/serve-api-docs.js.
Lihat docs/SCALAR.md. Jangan unggah docs/generated atau paket Scalar ke VPS.
Saat deployment sertakan src/documentation dan docs/API_GUIDE.md yang dibaca
generator OpenAPI. Pasang dependency VPS dengan npm ci --omit=dev.

Frontend yang sempat dipasang dilepas atas instruksi pemilik. /login dan
asset frontend harus mengembalikan 404; tidak ada penyajian SPA di VPS.
