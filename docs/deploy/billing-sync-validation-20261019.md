# Bukti validasi kandidat billing sync — 19 Oktober 2026

Catatan 20 Oktober 2026: prasyarat pembuatan role di bawah digantikan oleh
[mode satu akun Track](SINGLE_ACCOUNT_SYNC.md) sesuai keputusan pemilik.
Hasil pada dokumen ini adalah baseline sebelum penambahan mode tersebut.

Status: implementasi backend lokal dan verifikasi otomatis selesai. Produksi
belum dimigrasi, rilis belum dipasang, dan sinkronisasi belum diaktifkan.

## Hasil akhir

| Pemeriksaan | Hasil |
| --- | --- |
| Unit SI, termasuk checksum/typed mirror pada PostgreSQL lokal | 58/58 lulus |
| Unit Track, termasuk kontrak request billing | 10/10 lulus |
| Regresi backend SI pada database kosong baru | 20/20 lulus |
| Integrasi SI–Track pada dua database kosong baru | 20/20 lulus |
| ESLint SI `src scripts --quiet` | Tidak ada error |
| ESLint modul sync/assignment dan skrip deployment Track | Tidak ada error |
| Guard migrasi SI | 10 berkas aman, hanya schema finance |
| Pembuatan snapshot Drizzle setelah migrasi 0009 | Tidak ada perubahan schema tambahan |

Jumlah di atas mengikuti ringkasan runner; tes integrasi masing-masing juga
menghitung satu harness induk. Database berisi fixture sintetis, bukan salinan
data produksi. PostgreSQL pengujian lokal versi 18; produksi Track yang diperiksa
versi 16.14. Gladi migrasi pada PostgreSQL 16 dan volume data sebenarnya tetap
menjadi gate rilis.

Suite lintas sistem menguji bootstrap terputus/lanjut, source identity, 503 event
melintasi halaman, transaksi sumber terlambat commit, mutual exclusion worker,
retensi 410/resnapshot, retry setelah response hilang, konflik 409, idempotensi,
semua jenis tagihan, nominal yang dimanipulasi, pengajuan paralel, pembayaran
tagihan ke-2 sebelum tagihan ke-1, jurnal/alokasi tunggal, penolakan/pengajuan ulang,
adendum, reversal, serta perbaikan selisih cermin balik saat outbox kosong.

Invariant keuangan dan seluruh typed mirror nol setelah siklus tersebut. Tes juga
membuktikan reader tidak bisa membaca password/menulis, writer tidak bisa mengubah
nominal, listener terpisah dapat berjalan dengan role terbatas, dan SQL cutover
menolak target tanpa konfirmasi serta dapat diterapkan ulang pada sumber tes.

## Cara mengulang

Siapkan kedua checkout sebagai sibling seperti workspace ini, instal dependensi
dari lockfile, lalu buat database lokal kosong baru berawalan `prsi_test_` dan
`prtrack_test_`. Suite tidak menghapus database atau memakai DATABASE_URL sebagai
fallback untuk target integrasi.

Pada backend SI, set TEST_DATABASE_URL dan TEST_TRACK_DATABASE_URL ke database
sintetis tersebut melalui lingkungan proses, lalu jalankan:

```text
node --test test/integration.billing.js
```

Regresi backend menggunakan database SI kosong lain dan TEST_DATABASE_URL:

```text
node --test test/integration.backend.js
```

Unit masing-masing repo menggunakan `npx vitest run`. Tes monitoring DB SI
memerlukan MONITOR_TEST_DB=local dan DATABASE_URL database lokal bermigrasi yang
sesuai; fixture diuji dalam transaksi rollback. Kredensial dummy tes bukan
kredensial produksi. Pada Windows, gunakan direktori TEMP/TMP yang dapat ditulis.

## Gate yang belum dibuktikan

1. Admin/provider membuat dua role integrasi Track. Akun aplikasi yang diperiksa
   memiliki tujuh tabel Track, tetapi tidak memiliki CREATEROLE. Ikuti
   [instruksi admin/provider](ADMIN_PROVIDER_SYNC.md), lalu terapkan grants setelah
   migrasi pada jendela yang disetujui.
2. Gladi PostgreSQL 16, backup/restore dan rollback pada salinan tersanitasi dengan
   volume nyata, serta koneksi HTTPS/allowlist antarhost.
3. UAT Keuangan dan keputusan saldo/pembayaran historis. Perbedaan data staging
   dengan produksi tidak diperlakukan sebagai kegagalan kesiapan fitur.
4. Tim frontend mengintegrasikan kontrak API dan menyelesaikan UAT akses/status.
5. Cutover mengikuti [runbook](billing-sync-cutover.md), pemeriksaan readiness,
   dan rekonsiliasi kedua arah sebelum membuka input.

Tidak ada persentase kesiapan produksi yang disimpulkan dari kelulusan tes lokal.
Daftar ini merupakan syarat penerimaan produksi yang masih harus dibuktikan.
