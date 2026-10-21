# Audit dan integrasi backend — 10 Oktober 2026

## Lingkup dan keputusan

Backend lokal saja, berdasarkan AGENTS.md dan panduan deployment. Tidak ada
perubahan/build/deployment FE, penulisan database produksi, deployment VPS,
atau penggantian konfigurasi produksi. Role keuangan mengakses semua proyek/PT
sesuai konfirmasi pemilik. Origin final FE belum ada; localhost dan Vercel
development belum diberikan sebagai origin persis.

## Hasil per pekerjaan

| Pekerjaan | Hasil kode lokal | Batas penerapan |
| --- | --- | --- |
| Company PRTrack → Master PT | API daftar company aktif; POST/PATCH `trackCompanyId`; FK dan unique constraint; validasi company/proyek; field legal SI tidak disentuh sinkron | Pemetaan data nyata harus memakai pasangan ID yang diverifikasi; tidak menebak dari nama |
| Audit autentikasi | JWT 15 menit terikat ID sesi; refresh rotasi atomik, batas absolut 7 hari; live role/status/credential check; logout mencabut JWT sesi; reset/nonaktif operasional mencabut seluruh sesi dalam transaksi | Migrasi dan login ulang diperlukan saat rilis |
| CSRF/cookie/CORS | Cookie HttpOnly/Secure/Strict; validasi Origin/Referer pada cookie write; CORS terbuka khusus Bearer tanpa credentials; allowlist persis diuji | Browser dan origin FE deployment final belum dapat diverifikasi |
| Otorisasi | Semua operasi bisnis harus autentikasi + role keuangan; pemeriksaan relasi PT/proyek/unit legal; unit/customer yang dihapus ditolak | Tidak menerapkan ACL penugasan, sesuai keputusan pemilik |
| Kontrak API FE | OpenAPI 122 operasi/23 modul; panduan login diperbaiki; FE_HANDOFF merinci metode, payload, DTO, pagination, error, multipart dan alur | Sebagian response OpenAPI masih envelope generik; DTO inti dirinci di handoff |
| Uji integrasi | PostgreSQL lokal nyata: jurnal/lampiran/posting, saldo/tutup buku, SPK/adendum/pembayaran, SPPR/final/adendum/piutang/outbox, SHM/riwayat | Tidak menguji pengiriman outbox ke PRTrack nyata atau browser FE |

## Temuan dan perbaikan

1. Access JWT sebelumnya cukup diverifikasi tanda tangan dan expiry, sehingga
   logout/penonaktifan tidak mencabut akses langsung. JWT baru membawa `sid`;
   setiap request memeriksa sesi dan akun, lalu menggunakan role database terkini.
2. Refresh sebelumnya menghapus baris lalu membuat sesi baru; logout tidak
   menghubungkan JWT dengan sesi. Rotasi baru mengganti hash lewat compare-and-swap
   pada satu baris dengan ID tetap. Dua refresh memiliki satu pemenang; kegagalan
   tidak menghapus cookie yang baru dipasang respons pemenang.
3. Refresh diikat fingerprint hash password (server saja); perubahan password
   langsung menolak sesi lama. Jalur operasional `user:security` mencabut seluruh
   sesi bersama perubahan status/password dan mencatat audit tanpa kredensial.
   Gunakan jalur tersebut untuk nonaktif/reset, bukan hanya UPDATE status lewat
   klien database; UPDATE status saja tidak menghapus sesi yang belum dipakai.
4. CORS terbuka dengan credentials memungkinkan penggunaan kredensial cookie dari
   origin bebas. Kode baru mematikan Allow-Credentials ketika CORS_ALLOW_ALL aktif.
   CSRF menggunakan allowlist tersendiri yang tetap berlaku pada mode tersebut.
5. `trackCompanyId` sudah ada di skema tetapi tidak tersedia pada DTO/input dan
   belum unik. Pemetaan kini eksplisit menggunakan ID cermin lokal. PT soft-delete
   tetap menahan company agar referensi legal historis tidak ambigu.
6. PT pada SPPR bisa berbeda dari proyek kavling. Create/finalisasi/adendum kini
   memeriksa relasi tersebut; cermin assignment dengan unit/customer terhapus ditolak.
7. Tutup buku dan penulisan jurnal belum memakai kunci transaksi yang sama.
   Advisory transaction lock berdasarkan PT/bulan menserialisasi keduanya;
   draft baru di periode terkunci ditolak. Tutup buku menghitung draft proyek
   terkait juga, termasuk draft yang belum memiliki ptId saat PT baru dipetakan.
8. Panduan login menyatakan token tidak dikirim di body, bertentangan dengan API.
   Dokumentasi sekarang merinci Bearer dan cookie serta umur sesi yang tepat.

Referensi pengaman CSRF: [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
Pemilihan kredensial Bearer/cookie mengikuti kode paket @fastify/jwt yang terpasang;
lihat juga [dokumentasi resminya](https://github.com/fastify/fastify-jwt).

## Verifikasi

- `npm test`: 55 tes Vitest backend lulus; 3 tes opsional monitoring DB/vektor Track
  dilewati karena membutuhkan konfigurasi/fixture khusus.
- `npm run test:integration`: 19 tes termasuk induk, seluruhnya lulus pada
  PostgreSQL 18.4 lokal kosong. Meliputi uji negatif, rollback state, role,
  cookie CSRF, CORS allowlist/credentials, JWT expiry/legacy, refresh replay,
  logout, reset password, nonaktif/aktif ulang, dan concurrency.
- `npm run lint`: 0 error, 32 warning complexity.
- `npm run db:check`: 9 migrasi hanya menyentuh schema finance.
- `npm run docs:build`: OpenAPI valid, 122 operasi, 23 modul.
- `git diff --check`: tanpa masalah whitespace.

Tes integrasi hanya menerima `TEST_DATABASE_URL` pada loopback dan nama
database `prsi_test_*`. Database harus kosong; tes menolak tabel finance
yang sudah ada dan tidak menghapus data. Contoh parameter aman:

```powershell
$env:TEST_DATABASE_URL = 'postgres://audit_test@127.0.0.1:55439/prsi_test_backend_new'
npm run test:integration
```

Gunakan database pengujian terpisah dengan akun lokal sendiri. Tes menimpa
konfigurasi koneksi dalam prosesnya dan melewati start layanan/Redis untuk
memusatkan verifikasi pada HTTP + PostgreSQL. dbGuard produksi tidak diubah.

## Migrasi dan rollout backend

Migrasi: `drizzle/0008_company_mapping_sessions.sql`, snapshot dan journal.
Menambah `refresh_tokens.credential_hash` nullable serta unique constraint
`master_pt.track_company_id`. Tidak melakukan deduplikasi/hapus data otomatis.

Sebelum penerapan, backup database dan periksa duplikasi (termasuk soft-delete):

```sql
SELECT track_company_id, count(*)
FROM finance.master_pt
WHERE track_company_id IS NOT NULL
GROUP BY track_company_id HAVING count(*) > 1;
```

Jika ada hasil, verifikasi pemetaan bersama pemilik sebelum migrasi; jangan
menghapus/menggabungkan PT legal otomatis. Pertahankan satu akun Sumobase,
dbGuard aktif, ALLOW_UNSAFE_DB_ROLE=false. Migrasi melalui jalur koneksi migrator
sesuai docs/deploy/README.md; jangan memakai drizzle-kit push.

Rilis harus memasang migrasi sebelum aplikasi baru. JWT lama tanpa sid dan
refresh lama tanpa credential_hash ditolak; informasikan login ulang kepada
pengguna. Batas refresh sekarang absolut sejak login, bukan perpanjangan setiap rotasi.
Rollback aplikasi lama akan mengembalikan kelemahan pencabutan sesi; jika perlu
rollback, cabut seluruh sesi dan jangan menghapus schema finance otomatis.

Untuk operasi akun:

```text
npm run user:security -- <UUID-user> --status inactive
npm run user:security -- <UUID-user> --status active
npm run user:security -- <UUID-user> --reset-password
```

Reset memerlukan SI_NEW_USER_PASSWORD pada environment sementara, minimal 12
karakter. Jangan menaruh password di argumen, log, Git, atau dokumen. Script
memeriksa dbGuard dan menghapus environment password pada akhir proses.

Setelah origin FE persis tersedia, isi allowlist dan matikan CORS_ALLOW_ALL,
lalu uji login/me/refresh/logout, preflight, Origin/Referer, cookie dan unggahan
dari browser FE. [FE_HANDOFF.md](FE_HANDOFF.md) mencatat penyesuaian FE yang
dibutuhkan untuk localhost/Vercel serta temuan antrean refresh pada clone referensi.
