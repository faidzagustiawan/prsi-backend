# PodorukunSI - Finance Backend

API Sistem Informasi Keuangan Podorukun. Berjalan di VPS dan database sendiri, terpisah dari PodorukunTrack. Data Track masuk lewat API Track ke tabel cermin `trk_*`; Track tidak punya akses ke SI.

**Stack:** Node.js, Fastify 5, Drizzle ORM, PostgreSQL, Redis, Zod, Vitest.

> Baca [docs/RancanganSistem.md](docs/RancanganSistem.md) untuk arsitektur dan aturan konsistensi data dengan Track, [docs/API.md](docs/API.md) untuk kontrak API frontend, dan [docs/TrackSyncAPI.md](docs/TrackSyncAPI.md) untuk kontrak API yang harus disediakan PR Track.

## Struktur

```
database/setup/     SQL sekali jalan: role si_migrator / si_app / si_report, schema finance
docs/               rancangan sistem, kontrak API
drizzle/            migrasi hasil drizzle-kit (schema finance saja)
scripts/
  check-migrations.js   guard migrasi
  create-user.js        membuat user SI
  seed-dev.js           data contoh lokal
src/
  config/           env, koneksi DB, dbGuard (cek hak role saat start)
  plugins/          auth (JWT cookie), redis, validator, swagger
  middleware/       authorize, validate
  modules/          auth, proyek, master-pt, akun, kode-pembantu, saldo-awal,
                    periode, jurnal, lampiran, laporan, hutang, pinjaman,
                    kontrak, shm, akun-sistem, legal (pasal, template,
                    dokumen), penjualan (piutang, pembayaran PR Track), sinkron
  sync/             worker sinkronisasi PR Track: klien, pemetaan, tarik, kirim, rekonsiliasi
  worker.js         proses worker (npm run worker)
  shared/
    schemas/        finance (users, audit), track (cermin trk_*), akuntansi, hutang, penjualan
    constants.js    nilai pilihan tetap (VARCHAR + validasi aplikasi)
    utils/
test/
```

Semua jurnal, dari modul mana pun, dibuat lewat `buatJurnal()` di `modules/jurnal/jurnal.service.js`.

## Menjalankan (development)

API berjalan di port **3100**.

1. Jalankan `database/setup/001_roles_and_schema.sql` sekali sebagai owner database.
2. Konfigurasi dan jalankan:
   ```bash
   cp .env.example .env    # isi DATABASE_URL (si_app), SI_MIGRATOR_DATABASE_URL, secret baru
   npm install
   npm run db:migrate      # check-migrations lalu drizzle-kit migrate
   npm run seed:dev        # data contoh: proyek, PT, COA, kode pembantu
   SI_NEW_USER_PASSWORD='...' npm run user:create -- --email keuangan@contoh.com --nama "Keuangan" --role keuangan
   npm run dev
   ```

Swagger UI tersedia di `http://localhost:3100/docs`, hanya bila `NODE_ENV=development`.

## Script

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Server dengan nodemon |
| `npm test` | Unit test |
| `npm run lint` | ESLint |
| `npm run db:generate` | Membuat migrasi dari `src/shared/schemas/*.schema.js` |
| `npm run db:check` | Guard migrasi |
| `npm run db:migrate` | Guard, lalu migrasi |
| `npm run seed:dev` | Data contoh lokal |
| `npm run worker` | Worker sinkronisasi PR Track (butuh `SYNC_ENABLED=true`) |
| `npm run mock:track` | Server tiruan API Track di port 3900 (dev) |
| `npm run user:create` | Membuat user SI |

## Pengaman yang aktif

- Server menolak start kalau role DB runtime adalah superuser atau bisa mengakses schema lain (`src/config/dbGuard.js`).
- `db:migrate` menolak migrasi di luar schema `finance`, view/trigger, `DROP ... CASCADE`, GRANT, dan sejenisnya.
- Token SI memakai secret, audience, dan nama cookie sendiri.
- Key Redis SI selalu berprefix `si:`.
- `SYNC_ENABLED=false` memutus semua koneksi ke Track; worker dan tombol sinkron berhenti, SI tetap jalan dengan cermin terakhir.
