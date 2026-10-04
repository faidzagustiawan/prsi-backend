# Kontrak API SI Podorukun (fase 1)

Untuk frontend [FE_Podorukun-SI](https://github.com/fikrihidayah01/FE_Podorukun-SI). Bentuk data mengikuti tipe di `src/store/*.ts` frontend, jadi store zustand bisa diganti pemanggilan API tanpa mengubah komponen.

Swagger lengkap tersedia di `http://localhost:3100/docs` saat `NODE_ENV=development`.

## Aturan umum

- Base URL: `http://localhost:3100/api/v1` (dev).
- **Login memakai cookie httpOnly.** Semua `fetch` wajib `credentials: 'include'`. Token tidak pernah ada di body, jadi tidak perlu disimpan di localStorage.
- Access token berlaku 15 menit. Bila respons `401`, panggil `POST /auth/refresh` sekali, lalu ulangi request. Bila refresh juga `401`, arahkan ke login.
- Semua endpoint keuangan butuh role `keuangan`. Role lain mendapat `403`.
- Respons sukses: `{ success: true, message, data, meta? }`. `meta` ada di daftar berhalaman: `{ page, limit, total }`.
- Respons gagal: `{ success: false, message, errors: string[] }`. `422` = aturan bisnis, `errors` berisi semua pesan per baris (tampilkan sebagai daftar).
- Nominal uang: `number` rupiah, maksimal 2 desimal. Tanggal: `YYYY-MM-DD`. Bulan: `YYYY-MM`. Semua id: UUID string.

## Auth

| Method | Path | Body | Keterangan |
| --- | --- | --- | --- |
| POST | `/auth/login` | `{ email, password }` | `data.user` = `AuthUser` `{ id, name, email, role }` |
| POST | `/auth/refresh` | – | Memperbarui cookie |
| POST | `/auth/logout` | – | |
| GET | `/auth/me` | – | `AuthUser` yang sedang login |

Role: `admin`, `keuangan`, `teknisi`, `marketing`, `kontraktor`. `LoginPage` perlu diganti dari pilih-role ke form email + password.

## Proyek (baca saja, dari PR Track)

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/proyek` | `[{ id, nama, kode, status, ptId }]`. Pengganti `proyekStore` |
| GET | `/proyek/:id/kavling` | `[{ id, kode, tipe, luasTanah, luasBangunan, status }]` |

Proyek dan kavling dikelola di PR Track, tidak ada endpoint tulis.

## Master PT (`masterPtStore`)

| Method | Path | Body |
| --- | --- | --- |
| GET | `/master-pt` | – |
| GET | `/master-pt/:id` | – |
| POST | `/master-pt` | `{ namaPt, singkatan?, namaDirektur, ttl?, pekerjaan?, alamat?, noKtp?, perumahanId? }` |
| PATCH | `/master-pt/:id` | Kolom yang diubah saja |
| DELETE | `/master-pt/:id` | Ditolak bila sudah dipakai jurnal |

Tambahan dari store: `singkatan` (dipakai untuk nomor dokumen legal). Satu perumahan hanya bisa terikat ke satu PT. PT dari `perumahanId` menentukan tutup buku jurnal proyek itu.

## Akun / COA (`coaStore`)

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/akun` | `?status=aktif\|nonaktif&kategori=` |
| GET | `/akun/:id` | – |
| GET | `/akun/:id/riwayat` | `RiwayatAkun[]`, terbaru dulu |
| POST | `/akun` | `Akun` tanpa `id`, ditambah `noRekening?` |
| PATCH | `/akun/:id` | Kolom yang diubah saja |
| DELETE | `/akun/:id` | Hanya akun yang belum dipakai dan tanpa sub-akun |

Riwayat dicatat server (field `oleh` = nama user login); store tidak perlu mencatatnya sendiri. Kode, kategori, tipe saldo, dan klasifikasi terkunci setelah akun dipakai jurnal. `noRekening` di akun kas/bank dipakai untuk mencocokkan rekening tujuan pembayaran dari PR Track.

## Kode pembantu (`hutangStore.kodePembantus`)

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/kode-pembantu` | `?proyekId=&kategori=&aktif=true\|false&q=` |
| POST | `/kode-pembantu` | `{ nama, kategori, proyekId? }`. `kode` dibuat server (mis. `LH-0002`) |
| PATCH | `/kode-pembantu/:id` | `{ nama?, proyekId?, aktif? }` |
| DELETE | `/kode-pembantu/:id` | Hanya yang belum dipakai |

Bentuk: `{ id, kode, nama, kategori, proyekId, customerId, aktif }`. Kategori = `KategoriHutangPiutang` + `pembeli`. Dropdown kode pembantu di Jurnal Umum (sekarang `DUMMY_KODE_PEMBANTU`) diganti endpoint ini.

## Saldo awal (`saldoAwalStore`)

| Method | Path | Body |
| --- | --- | --- |
| GET | `/saldo-awal/:proyekId` | Selalu ada; `id = null` bila belum pernah disimpan |
| PUT | `/saldo-awal/:proyekId` | `{ tanggalMulai?, saldo: [{ akunId, kodePembantuId?, debit, kredit }] }` (ganti semua) |
| PUT | `/saldo-awal/:proyekId/akun/:akunId` | `{ kodePembantuId?, debit, kredit }` (satu baris; 0/0 menghapus) |
| POST | `/saldo-awal/:proyekId/kunci` | Pengganti `tutupBuku`. Total debit harus sama dengan kredit |

Bentuk: `{ id, proyekId, tanggalMulai, status, dikunciPada, saldo[], totalDebit, totalKredit }`. Jurnal bertanggal sebelum `tanggalMulai` ditolak.

## Jurnal (`jurnalStore`)

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/jurnal` | `?page&limit&proyekId&status&sumber&bulan=YYYY-MM&q` |
| GET | `/jurnal/:id` | – |
| POST | `/jurnal` | `{ tanggal, keterangan, proyekId, status: 'draft'\|'diposting', rows: [{ akunId, kodePembantuId?, keterangan?, debit, kredit }] }` |
| PUT | `/jurnal/:id` | Sama dengan POST |
| POST | `/jurnal/:id/posting` | Posting draft |
| POST | `/jurnal/:id/balik` | `{ tanggal?, keterangan? }`. Membuat jurnal pembalik |
| DELETE | `/jurnal/:id` | Draft, atau diposting selama periodenya terbuka |

Bentuk `Jurnal` sama dengan store, ditambah `ptId`, `refType`, `refId`, `mirrorId`, `dibalikOlehId`, `totalDebit`, `totalKredit`, `dipostingPada`. `nomorJurnal` dibuat server, mis. `JU-202609-0001`.

Status: `draft`, `diposting`, `dikoreksi` (jurnal asal yang sudah dibalik), `balik` (jurnal pembalik). Sumber: `manual`, `pr_track`, `pinjaman`, `kontraktor`, `penjualan`, `mirror`.

Cek saat posting (server): debit = kredit dan tidak nol; minimal 2 baris; setiap baris hanya debit atau kredit; akun detail (bukan induk) dan aktif; kode pembantu bila akun mewajibkan; periode PT belum dikunci; lampiran wajib bila ada akun kas/bank.

**Alur lampiran berubah dari store.** Lampiran tidak lagi disimpan sebagai base64 di jurnal:

1. `POST /jurnal` dengan `status: 'draft'`.
2. Untuk setiap berkas: `POST /lampiran?entityType=jurnal&entityId=<id>` (multipart, field `file`).
3. `POST /jurnal/:id/posting`.

Bila tidak ada akun kas/bank, `POST /jurnal` dengan `status: 'diposting'` langsung bisa dipakai.

Koreksi (Alur 5): jurnal otomatis (sumber selain `manual`) hanya dikoreksi dari modul asalnya. Jurnal manual boleh diubah atau dihapus selama periodenya terbuka; setelah periode dikunci, pakai `/balik` lalu buat jurnal baru yang benar.

## Lampiran

| Method | Path | Keterangan |
| --- | --- | --- |
| POST | `/lampiran?entityType=jurnal&entityId=` | multipart `file`; PDF/JPG/PNG/WEBP, maks 10 MB; jenis dicek dari isi berkas |
| GET | `/lampiran?entityType=jurnal&entityId=` | Daftar |
| GET | `/lampiran/:id/unduh` | Berkas; `?inline=1` untuk pratinjau di tab baru |
| DELETE | `/lampiran/:id` | Hanya selama jurnal masih draft |

Bentuk: `{ id, nama, tipe: 'pdf'\|'gambar', mime, ukuranBytes, url, createdAt }`. Pakai `url` untuk pratinjau (dengan cookie), bukan `dataUrl`.

## Periode / tutup buku

| Method | Path | Body |
| --- | --- | --- |
| GET | `/periode?ptId=` | Periode yang sudah dibuat; yang tidak ada = terbuka |
| POST | `/periode/tutup` | `{ ptId, bulan }`. Ditolak bila masih ada jurnal draft di bulan itu |

## Laporan

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/laporan/saldo-akun?proyekId&sampai` | Neraca saldo per akun |
| GET | `/laporan/buku-besar?akunId&dari&sampai&proyekId?&kodePembantuId?` | Mutasi dan saldo berjalan; `meta.saldoAwal`, `meta.saldoAkhir` |
| GET | `/laporan/saldo-kode-pembantu?bulan&proyekId?&kategori?` | Sama dengan `getSaldoPerKodePembantu` di `hutangStore`: `{ kodePembantu, saldoAwal, totalDebit, totalKredit, mutasiBulan, saldoAkhir }[]` |

Saldo positif mengikuti saldo normal akun: hutang positif bila kredit lebih besar dari debit. Semua angka dihitung dari jurnal, jadi selalu cocok dengan daftar jurnal.

## Belum tersedia (fase berikutnya)

Hutang (mutasi, pinjaman bank, kontrak kontraktor, SHM), legal (pustaka pasal, template, dokumen SPPR), piutang (jadwal angsuran, alokasi pembayaran), dan sinkronisasi pembayaran dari PR Track. Store-nya tetap dipakai sampai endpoint-nya siap.
