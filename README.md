# PodorukunSI - Finance Backend

API Sistem Informasi Keuangan Podorukun. Berjalan berdampingan dengan PodorukunTrack dan memakai database yang sama, tapi di schema terpisah `finance`.

**Stack:** Node.js, Fastify 5, Drizzle ORM, PostgreSQL (Neon), Redis, Zod, Vitest.

> **Baca [docs/DatabaseIsolation.md](docs/DatabaseIsolation.md) sebelum menyentuh database.**
> SI tidak boleh memengaruhi PodorukunTrack sama sekali. Isolasinya ditegakkan oleh hak akses database, guard migrasi, dan pemeriksaan saat server start.

## Struktur

```
database/setup/     SQL sekali jalan: role, schema finance, kontrak baca Track
docs/               dokumentasi isolasi database
drizzle/            migrasi hasil drizzle-kit (schema finance saja)
scripts/
  check-migrations.js   menolak migrasi yang menyentuh schema Track
  create-user.js        membuat user SI
src/
  config/           env, koneksi DB, dbGuard (cek isolasi saat start)
  plugins/          auth (JWT), redis, validator, swagger
  middleware/       authorize, validate
  modules/
    auth/           login, refresh, logout, me (user SI sendiri)
    track/          satu-satunya pintu baca data Track (finance.track_*)
  shared/
    schemas/        finance.schema.js
    utils/
test/
```

Pola modul: `*.routes.js` → `*.controller.js` → `*.service.js` → `*.repository.js`, ditambah `*.schema.js` (zod).

## Menjalankan (development)

API berjalan di port **3100**, supaya tidak bentrok dengan Track di 3000.

1. Setup database sekali jalan di **Neon branch**. Langkahnya ada di [docs/DatabaseIsolation.md](docs/DatabaseIsolation.md) bagian 4.
2. Konfigurasi dan jalankan:
   ```bash
   cp .env.example .env    # isi DATABASE_URL (si_app), SI_MIGRATOR_DATABASE_URL, secret baru
   npm install
   npm run db:generate     # membuat migrasi dari finance.schema.js
   # Migrasi pertama: ubah CREATE SCHEMA "finance" menjadi CREATE SCHEMA IF NOT EXISTS "finance"
   npm run db:migrate      # check-migrations lalu drizzle-kit migrate
   SI_NEW_USER_PASSWORD='...' npm run user:create -- --email admin@contoh.com --nama "Admin" --role super_admin
   npm run dev
   ```

Swagger UI tersedia di `http://localhost:3100/docs`, hanya bila `NODE_ENV=development`.

## Script

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Server dengan nodemon |
| `npm test` | Unit test, ditambah contract test `finance.track_*` bila `CONTRACT_DATABASE_URL` di-set |
| `npm run lint` | ESLint |
| `npm run db:generate` | Membuat migrasi dari `finance.schema.js` |
| `npm run db:check` | Guard migrasi |
| `npm run db:migrate` | Guard, lalu migrasi |
| `npm run user:create` | Membuat user SI |

## Pengaman yang aktif

- Server menolak start kalau role DB bisa mengakses tabel Track (`src/config/dbGuard.js`).
- `db:migrate` menolak migrasi yang menyentuh `public`, membuat view/trigger, berisi `DROP ... CASCADE`, GRANT, membuat schema selain `finance`, dan sejenisnya.
- Token SI memakai secret, audience, dan nama cookie sendiri. Token Track ditolak.
- Key Redis SI selalu berprefix `si:`.
