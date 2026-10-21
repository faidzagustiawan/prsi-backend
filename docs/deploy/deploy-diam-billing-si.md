# Checklist deploy diam SI: billing sync dengan semua gate mati

Status: checklist, belum dijalankan. Disusun 21 Oktober 2026.

Tujuan: memasang kode dan migrasi billing di SI produksi **tanpa** mengaktifkan
sinkronisasi atau tagihan. Track, frontend SI, dan flag tidak disentuh. Aktivasi
tetap mengikuti [billing-sync-cutover.md](billing-sync-cutover.md).

## Isi rilis

Branch `feature/billing-sync-tagihan` (`ea99492`) berada dua commit di atas
`main` (`4a3e327`):

| Commit | Isi | Migrasi |
|---|---|---|
| `3384f98` | Alur API keuangan dan proteksi sesi | `0008_company_mapping_sessions` |
| `ea99492` | Billing sync, UI API tagihan, perbaikan worker | `0009_billing_sync` |

Catatan deploy terakhir di [README.md](README.md) mencatat migrasi sampai 0007.
Dua deploy 7 Oktober tidak tercatat, jadi status 0008 di produksi harus dicek.

Dampak yang tetap terlihat walau semua gate mati:

- **Proteksi sesi (`3384f98`):** token tanpa sesi ditolak. Bila token produksi
  saat ini belum membawa sesi, semua pengguna harus login ulang. Beri tahu
  pengguna sebelum jendela deploy.
- **0008** menambah `UNIQUE(master_pt.track_company_id)`. Migrasi gagal bila
  produksi punya pemetaan ganda (cek di pra-syarat).
- Endpoint baru terdaftar. Dengan `SI_BILLING_ENABLED=false`:
  `GET /piutang/{id}/tagihan` hanya baca (`billingEnabled:false`),
  `PUT /piutang/{id}/tagihan` dan `POST /pembayaran-track/{id}/verifikasi`
  mengembalikan 409.
- Worker tetap tidak berjalan karena `SYNC_ENABLED=false`.

## Pra-syarat (sebelum hari deploy)

- [ ] PR `feature/billing-sync-tagihan` direview dan di-merge ke `main`;
      deploy dari commit `main` hasil merge, bukan dari branch.
- [ ] Lokal pada commit tersebut: `npm ci`, `npx eslint src scripts --quiet`,
      `npx vitest run`, `node scripts/check-migrations.js`, dan kedua suite
      integrasi pada database kosong baru. Catat hasilnya.
- [ ] Gladi migrasi: restore dump schema `finance` produksi terbaru ke database
      lokal terpisah (PostgreSQL versi sama dengan Sumobase), jalankan migrator,
      catat durasi dan error. Hapus salinan setelah selesai.
- [ ] Cek produksi dengan kueri baca saja:

```sql
-- Migrasi yang sudah diterapkan (8 baris = sampai 0007, 9 baris = sampai 0008)
SELECT count(*) FROM finance.__drizzle_migrations;

-- Wajib 0 baris sebelum 0008
SELECT track_company_id, count(*) FROM finance.master_pt
WHERE track_company_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;

-- Ukuran tabel yang diubah 0009 (outbox_track ditulis ulang karena kolom bigserial)
SELECT count(*) FROM finance.outbox_track;
SELECT count(*) FROM finance.jadwal_angsuran;
```

- [ ] Jendela waktu disepakati dan pengguna SI diberi tahu soal login ulang.

## Hari deploy

Pola sama dengan deploy 7 Oktober (PR #8). Gunakan zona waktu UTC untuk nama
folder.

1. [ ] Tutup sesi DBeaver/klien lain. Pastikan tidak ada transaksi menggantung:

   ```sql
   SELECT pid, usename, state, xact_start FROM pg_stat_activity
   WHERE datname = current_database() AND state LIKE 'idle in transaction%';
   ```

2. [ ] Backup ke `/var/backups/podorukun-si/pre-billing-dark-<UTC>/` (root, 700):
       app tanpa `node_modules` termasuk `.env`, kedua unit systemd, dokumen
       statis `/var/www/podorukun-si-docs/`, dan dump `pg_dump -Fc -n finance`.
       Verifikasi dump dengan `pg_restore -l`.
3. [ ] Bangun rilis di `/opt/podorukun-si/app.new` dari commit `main`, salin
       `.env`, `npm ci --omit=dev`. Sertakan `src/documentation` dan
       `docs/API_GUIDE.md`.
4. [ ] Pastikan `.env` rilis baru memuat secara eksplisit:

   ```dotenv
   SYNC_ENABLED=false
   SYNC_WRITE_ENABLED=false
   SI_BILLING_ENABLED=false
   SI_LEGACY_CUTOVER_AT=
   ```

   `SI_LEGACY_CUTOVER_AT` dibiarkan kosong pada deploy diam; nilainya ditetapkan
   saat cutover setelah saldo awal tiap proyek dikunci.

   Jangan mengubah `SYNC_PROTOCOL`, token Track, atau `ALLOW_UNSAFE_DB_ROLE`.
5. [ ] Uji `app.new` di port 3199 hanya untuk `/health` (schema belum
       dimigrasi, jadi jangan uji endpoint bisnis di tahap ini).
6. [ ] `systemctl stop podorukun-si-api`. Pastikan
       `podorukun-si-worker.service` tetap inactive.
7. [ ] Jalankan migrator `drizzle-orm/postgres-js/migrator` dari `app.new`
       dengan `SESSION_DATABASE_URL` (session pooler), `statement_timeout`
       5 menit dan `lock_timeout` 60 detik untuk sesi itu. Variabel migrator
       tidak disimpan di `.env` runtime. Bila gagal: semua dibatalkan; lanjut ke
       rollback A.
8. [ ] Verifikasi: `__drizzle_migrations` 10 baris; kolom
       `finance.jadwal_angsuran.jenis`, `finance.outbox_track.sequence`,
       `finance.trk_payments.si_jadwal_id` ada.
9. [ ] Tukar direktori (`app` → `app.prev-<UTC>`, `app.new` → `app`), lalu
       `systemctl start podorukun-si-api`.

## Verifikasi sesudah deploy

- [ ] `curl --fail https://podorukunsi.my.id/health` 200 (DB dan Redis ok).
- [ ] Login ulang berhasil; refresh dan logout berjalan.
- [ ] Sebagai Keuangan: `GET /api/v1/piutang` 200;
      `GET /api/v1/piutang/{id}/tagihan` 200 dengan `billingEnabled:false`.
- [ ] `PUT /api/v1/piutang/{id}/tagihan` 409 "Fitur tagihan SI belum diaktifkan".
- [ ] `GET /api/v1/pembayaran-track` 200; `GET /api/v1/sinkron/status` tanpa
      login 401; `/login` 404.
- [ ] `podorukun-si-worker.service` inactive; journal API tanpa error.
- [ ] Bangun ulang OpenAPI statis (`npm run docs:build` di lokal) dan ganti
      berkas di `/var/www/podorukun-si-docs/`.
- [ ] Catat hasil, commit, lokasi backup, dan direktori rilis lama di
      [README.md](README.md).

## Rollback

**A. Migrasi gagal:** transaksi migrasi dibatalkan otomatis. Jalankan lagi
service lama (`systemctl start podorukun-si-api`), cari penyebab (lock, data
ganda), jangan menaikkan timeout tanpa mencari pemegang lock.

**B. Masalah setelah API baru berjalan:** migrasi 0008 dan 0009 bersifat aditif
(kolom baru nullable atau berdefault, satu constraint unik, tidak ada kolom
dihapus), sehingga rilis lama diperkirakan tetap berjalan pada schema baru:

```
sudo mv /opt/podorukun-si/app /opt/podorukun-si/app.failed && sudo mv /opt/podorukun-si/app.prev-<UTC> /opt/podorukun-si/app && sudo systemctl restart podorukun-si-api
```

Kompatibilitas rilis lama dengan schema baru **belum diuji**; uji pada gladi
migrasi (jalankan rilis lama terhadap salinan yang sudah dimigrasi). Jangan
membalik migrasi atau menghapus kolom. Restore dump schema hanya untuk kondisi
darurat dan memerlukan API berhenti.

## Di luar lingkup deploy ini

- Mengaktifkan `SI_BILLING_ENABLED`, `SYNC_ENABLED`, atau `SYNC_WRITE_ENABLED`.
- Perubahan apa pun di Track (kode, migrasi, listener integrasi).
- Frontend SI: dikelola repo `fikrihidayah01/FE_Podorukun-SI`, tidak dipasang di
  VPS. Tombol Tagihan akan tampil hanya-baca selama billing mati.
- Keputusan cutoff pembayaran lama ([opsi-cutoff-pembayaran-lama.md](opsi-cutoff-pembayaran-lama.md)).
