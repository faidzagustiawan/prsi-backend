# Isolasi Database PodorukunSI terhadap PodorukunTrack

PodorukunSI (sistem informasi keuangan) memakai database PostgreSQL (Neon) yang sama dengan PodorukunTrack, di schema terpisah `finance` (opsi A). Tujuan utama dokumen ini: **SI tidak boleh memengaruhi penggunaan Track sama sekali.**

Setiap aturan di bawah ditegakkan oleh database (hak akses role), bukan hanya oleh disiplin developer.

## 1. Aturan dasar

| Aturan | Ditegakkan oleh |
|---|---|
| SI tidak pernah menulis ke `public.*` (data, DDL, trigger, view) | Role SI tanpa hak tulis di `public`; `check-migrations.js` |
| SI hanya membaca kolom Track yang di-whitelist | Column-level `GRANT SELECT` di `002` |
| Kolom sensitif Track (`password_hash`, `apple_refresh_token`, dst) tidak bisa dibaca SI | Tidak pernah di-grant |
| Backend SI (runtime) tidak punya akses ke tabel `public` sama sekali | `si_app` hanya bisa memanggil fungsi `finance.track_*` |
| Migrasi Track tidak pernah terblokir oleh SI | Tidak ada view, FK, atau trigger ke `public`; akses lewat fungsi plpgsql (tanpa dependency kolom) |
| SI tidak memegang lock lama yang membuat Track mengantre | `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` per role |
| SI tidak menghabiskan koneksi atau CPU Track | `CONNECTION LIMIT` per role; laporan berat di read replica |
| Akun dan token SI terpisah dari Track | Tabel `finance.users`, `JWT_SECRET`/`COOKIE_SECRET` sendiri, subdomain sendiri |

## 2. Role database

| Role | Dipakai oleh | Hak |
|---|---|---|
| `si_migrator` | Migrasi (drizzle-kit), pembuatan fungsi kontrak | Pemilik schema `finance`; SELECT per kolom whitelist di `public`; `CREATE` di database (dibutuhkan drizzle-kit, hanya bisa membuat schema baru; guard menolak schema selain `finance`) |
| `si_app` | Backend SI (runtime) | CRUD di `finance`; EXECUTE `finance.track_*`; **tanpa** akses tabel `public` |
| `si_report` | Query laporan di read replica Neon | Read-only di `finance`; EXECUTE `finance.track_*` |

Role Track (`neondb_owner`) tidak diubah.

Catatan: sejak Postgres 15, `PUBLIC` masih punya `USAGE` di schema `public`. Artinya role SI bisa melihat nama-nama tabel, tapi tidak bisa membaca isinya karena tidak ada hak SELECT. Grant `PUBLIC` sengaja tidak diubah supaya tidak menyentuh konfigurasi Track.

## 3. Cara SI membaca data Track

Hanya lewat fungsi kontrak di `database/setup/003_track_functions.sql`:

- `finance.track_companies()`
- `finance.track_units(company_id)`
- `finance.track_assignments(company_id)`
- `finance.track_payments_since(company_id, since, limit)`: polling pembayaran baru untuk dijurnal otomatis. Tidak ada trigger di tabel Track.

Kenapa memakai fungsi plpgsql dan bukan view:
- Postgres mencatat dependency view terhadap kolom tabel. View SI akan membuat migrasi Track (drop, rename, atau ubah tipe kolom) **gagal**.
- Fungsi plpgsql tidak mencatat dependency itu. Kalau Track mengubah kolom, yang rusak adalah fungsi SI, dan itu terdeteksi oleh contract test SI. Deploy Track tetap jalan normal.

Data Track disimpan di SI hanya sebagai UUID (`unit_id`, `assignment_id`, `payment_id`), **tanpa foreign key** ke `public`. Validasi dilakukan di aplikasi.

## 4. Setup awal (sekali)

Sebelum menjalankan, cocokkan daftar kolom di `002` dengan DB live. Daftar itu dibuat dari dump 2026-07-18; kolom yang tidak ada akan membuat script rollback.

```bash
psql "$OWNER_DATABASE_URL" -v si_migrator_password='...' -v si_app_password='...' -v si_report_password='...' -f database/setup/001_roles_and_schema.sql
psql "$OWNER_DATABASE_URL" -f database/setup/002_track_read_contract.sql
psql "$SI_MIGRATOR_DATABASE_URL" -f database/setup/003_track_functions.sql
```

Jalankan dulu di **Neon branch** (salinan database), lalu di production.

## 5. Workflow migrasi SI

1. `drizzle-kit generate`. Config sudah memakai `schemaFilter: ['finance']`.
   - **Migrasi pertama saja:** ubah `CREATE SCHEMA "finance";` menjadi `CREATE SCHEMA IF NOT EXISTS "finance";`, karena schema sudah dibuat oleh `001`. Guard akan menolak kalau ini lupa diubah.
2. `node scripts/check-migrations.js`. Gagal kalau ada SQL yang menyentuh `public`, view, trigger, `DROP ... CASCADE`, GRANT, FK ke luar `finance`, atau objek tanpa prefix `finance`.
3. Review SQL secara manual.
4. Buat Neon branch dari production sebagai titik restore, lalu `drizzle-kit migrate` dengan role `si_migrator`.

Dilarang:
- `drizzle-kit push` ke production.
- Development memakai URL database production. Development selalu di Neon branch.
- Rollback SI dengan point-in-time restore seluruh database, karena data Track ikut mundur. Rollback SI dilakukan dengan migrasi balik di schema `finance`.

## 6. Environment

| Variabel | SI | Track |
|---|---|---|
| Database runtime | `DATABASE_URL` = `si_app` | `neondb_owner` |
| Database laporan | `REPORT_DATABASE_URL` = `si_report` di read replica | - |
| Database migrasi | `SI_MIGRATOR_DATABASE_URL` | - |
| `JWT_SECRET`, `COOKIE_SECRET` | Nilai sendiri, **tidak boleh sama** dengan Track | - |
| Domain | Subdomain sendiri, cookie name sendiri | - |

## 7. Dampak ke tim Track

- Kode, schema, role, dan grant Track: **tidak berubah**.
- Migrasi Track: tidak pernah terblokir oleh SI.
- Kalau Track mengubah kolom yang ada di whitelist (bagian 1 di `002`), beri tahu tim SI. Fungsi `finance.track_*` dan grant kolomnya perlu disesuaikan. Contract test SI akan gagal sampai itu dikerjakan, tapi Track tidak terdampak.

## 8. Risiko yang tersisa (konsekuensi opsi A)

- Kalau Neon sendiri down atau kuotanya habis, kedua aplikasi ikut kena.
- Kuota storage dan compute Neon dipakai bersama. Pantau per role lewat `pg_stat_statements`.
- Perubahan schema Track yang dipakai SI tetap butuh penyesuaian di SI.
