# Permintaan provisioning role integrasi Track

**Jalur opsional.** Sejak keputusan pemilik 20 Oktober 2026, deployment memakai
[akun aplikasi Track yang sudah ada](SINGLE_ACCOUNT_SYNC.md). Pembuatan role pada
dokumen ini tidak diperlukan untuk mode application; simpan sebagai opsi jika
provider kelak mendukung isolasi role.

Disiapkan 19 Oktober 2026. Dokumen ini dapat diberikan kepada admin/provider;
tidak berisi password, token, atau connection string. Provisioning role belum
mengaktifkan sinkronisasi atau mengganti konfigurasi aplikasi produksi.

## Target yang harus dikonfirmasi admin

Hasil pemeriksaan metadata read-only pada host Track `43.173.8.59`:

| Parameter | Nilai terverifikasi |
| --- | --- |
| Database | `dbbdacdf0a5a910684` |
| Versi PostgreSQL | 16.14 |
| Pemilik tujuh tabel Track | Akun aplikasi Track (nama di kanal secret) |
| Akun aplikasi memiliki CREATEROLE | Tidak |
| Akun aplikasi superuser | Tidak |

Admin harus memastikan server/database yang dipilih cocok sebelum menjalankan
SQL. Jangan menaikkan akun aplikasi menjadi superuser atau member role admin.

## Permintaan untuk admin/provider

1. Review dan jalankan berkas repo Track `staging/integration-roles.sql` memakai
   akun yang diizinkan membuat role. Berkas ini hanya membuat role yang belum ada
   dan mengatur timeout/default transaksi; tidak memerlukan tabel baru.
2. Buat dua kredensial independen untuk `prtrack_integration_reader` dan
   `prtrack_integration_writer` melalui panel secret provider. Jika memakai psql,
   gunakan prompt interaktif `\password prtrack_integration_reader` dan
   `\password prtrack_integration_writer`; jangan menulis password dalam berkas,
   shell history, argumen proses, tiket, atau chat.
3. Setelah kredensial tersimpan di kanal secret, izinkan login:

   ```sql
   ALTER ROLE prtrack_integration_reader LOGIN;
   ALTER ROLE prtrack_integration_writer LOGIN;
   ```

4. Jangan memberikan membership role lain. Kedua role harus NOSUPERUSER,
   NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS, NOINHERIT, dengan batas
   enam koneksi. Bila nama role sudah ada, audit pemakaian/haknya terlebih dahulu;
   skrip sengaja tidak mencabut hak role yang sudah ada secara otomatis.
5. Pastikan kebijakan provider/pg_hba mengizinkan koneksi dari listener integrasi
   Track dengan TLS sesuai provider. Listener berada pada host Track; role ini
   tidak memerlukan akses database langsung dari VPS SI.

Default reader adalah transaksi read-only, statement timeout 15 detik, idle
transaction timeout 15 detik. Writer memakai statement timeout 15 detik,
lock timeout 5 detik, idle transaction timeout 15 detik.

## Langkah pemilik tabel setelah migrasi terjadwal

Setelah migrasi Track yang direview berhasil, pemilik tabel/fungsi menjalankan
`staging/integration-grants.sql` pada database yang sama. Jangan menjalankannya
sebelum tabel `sync_feed`, `sync_outbox`, `si_schedules`, dan `si_sync_inbox` tersedia.
Jika pemilik tabel tidak diizinkan memberi USAGE schema public, admin menjalankan
baris GRANT USAGE tersebut. Jangan mengubah hak PUBLIC secara global.

Reader hanya boleh membaca kolom whitelist tujuh entitas, feed/outbox, dan fungsi
checksum. Kolom password user tidak termasuk. Writer mendapat hak untuk jadwal,
inbox idempotensi, kolom keputusan SI pada pembayaran, kolom total kontrak/total
terbayar assignment, serta outbox/sequence. Writer tidak boleh mengubah nominal,
assignment, atau bukti pembayaran dan tidak mendapat DELETE/TRUNCATE.

## Bukti pascaprovisioning

Admin dapat mengembalikan hasil metadata berikut tanpa secret:

```sql
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
       rolreplication, rolbypassrls, rolinherit, rolconnlimit, rolconfig
FROM pg_roles
WHERE rolname IN ('prtrack_integration_reader','prtrack_integration_writer');

SELECT member::regrole AS member, roleid::regrole AS inherited_role
FROM pg_auth_members
WHERE member IN (
  SELECT oid FROM pg_roles
  WHERE rolname IN ('prtrack_integration_reader','prtrack_integration_writer')
);
```

Query membership harus kosong. Setelah grants, verifikasi ACL efektif berikut:

```sql
SELECT
  has_column_privilege('prtrack_integration_reader','public.users','nama','SELECT') AS reader_nama,
  has_column_privilege('prtrack_integration_writer','public.payment_history','status_si','UPDATE') AS writer_status,
  has_column_privilege('prtrack_integration_writer','public.payment_history','jumlah_bayar','UPDATE') AS writer_nominal,
  has_table_privilege('prtrack_integration_reader','public.payment_history','INSERT') AS reader_insert,
  has_table_privilege('prtrack_integration_writer','public.payment_history','DELETE') AS writer_delete;
```

Hasil wajib: `true, true, false, false, false`. Periksa juga bahwa semua kolom
password/secret di tabel users tidak bisa dibaca reader, termasuk hak yang
diterima lewat PUBLIC. Uji login masing-masing role melalui kanal operasional
tanpa menampilkan connection string. Startup listener menolak hak berbahaya;
uji startup dengan flags tulis/billing tetap false.

## Serah terima dan aktivasi

Kirim nama endpoint database/TLS dan referensi dua secret melalui secret manager
ke operator, bukan isi secret lewat tiket. Operator mengisi EnvironmentFile
root-only berdasarkan `staging/integration.env.example`; read token dan write
token API juga harus berbeda dari kredensial database dan dari satu sama lain.

`SYNC_ENABLED`, `SYNC_WRITE_ENABLED`, dan `SI_BILLING_ENABLED` tetap false sampai
gladi lintas host, UAT Keuangan, keputusan saldo historis, dan integrasi frontend
lulus sesuai [runbook cutover](billing-sync-cutover.md). Pertahankan dbGuard dan
`ALLOW_UNSAFE_DB_ROLE=false` pada SI. Provisioning ini bukan persetujuan cutover.

Jika akses login perlu ditarik sebelum aktivasi, admin dapat memakai `ALTER ROLE
... NOLOGIN` pada masing-masing role. Jangan DROP role/tabel atau mencabut hak
global sebagai langkah pemulihan otomatis; periksa koneksi aktif terlebih dahulu.
