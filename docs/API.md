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

## Pola jurnal di modul (berlaku untuk hutang, pinjaman, kontrak)

Setiap transaksi modul membuat jurnal. Dokumen modul (mutasi, transaksi pinjaman, pembayaran kontrak, adendum) membawa:

`{ jurnalId, nomorJurnal, jurnalStatus: 'draft'|'diposting'|..., butuhLampiran }`

- Tanpa akun kas/bank (mis. SPK, adendum, mutasi ke persediaan): jurnal langsung `diposting`.
- Dengan akun kas/bank: jurnal `draft` dan `butuhLampiran: true`. Tampilkan tombol "Unggah bukti", lalu `POST /lampiran?entityType=jurnal&entityId=<jurnalId>`, lalu `POST /jurnal/<jurnalId>/posting`.
- Saldo (sisa pokok, sisa hutang kontrak, saldo hutang) hanya menghitung jurnal yang sudah diposting. Transaksi draft tetap tampil di daftar dengan `jurnalStatus: 'draft'`.

## Hutang (`hutangStore`)

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/hutang/ringkasan` | `?bulan&proyekId` → `{ bulan, totalHutang, perKategori: { lahan, bank, ... }, jatuhTempoDekat }` |
| GET | `/hutang/saldo` | `?bulan&proyekId&kategori` → sama dengan `getSaldoPerKodePembantu` (`SaldoKodePembantu[]`) |
| GET | `/hutang/mutasi` | `?kodePembantuId&kategori&proyekId`. Dengan `kodePembantuId`, saldo awal ikut sebagai baris terakhir (`sumber: 'saldo_awal'`) |
| GET | `/hutang/antar-proyek` | `?proyekId` → `getMutasiAntarProyek`, kedua sisi |
| POST | `/hutang/mutasi` | Lihat di bawah |
| DELETE | `/hutang/mutasi/:id` | `id` = `jurnalId`. Pasangan mirror ikut terhapus. Ditolak bila sudah ada lampiran atau periode terkunci |

Body `POST /hutang/mutasi` (sama dengan form `InputMutasiModal`):

```jsonc
{
  "proyekId": "...", "kategori": "lahan",
  "kodePembantuId": "...",            // atau "kodePembantuBaru": "Nama pihak baru"
  "tanggal": "2026-10-05", "uraian": "Bayar termin 4",
  "jenisMutasi": "debit",             // debit = kurangi hutang, kredit = tambah hutang
  "nominal": 100000000,
  "akunCoaId": "...",                 // WAJIB: akun lawan (kas/bank, persediaan, beban). Di FE masih opsional
  "referensi": "BKK/2026/10/001",
  "proyekLawanId": "..."              // hanya antar_proyek: proyek pemberi
}
```

`MutasiHutang` = bentuk store ditambah `sumber`, `jurnalId`, `nomorJurnal`, `jurnalStatus`, `butuhLampiran`. `id` = `jurnalId`. Akun hutang dipilih server dari kategori (akun COA dengan `kategoriHutangPiutang` itu).

Antar proyek: `proyekId` = peminjam, `proyekLawanId` = pemberi. Server membuat dua jurnal berpasangan (hutang di peminjam, piutang di pemberi) dan kode pembantu kedua sisi bila belum ada. Bila lewat kas/bank, cukup unggah bukti ke salah satu jurnal; posting satu sisi memposting keduanya.

## Pinjaman bank (`pinjamanBankStore`)

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/pinjaman` | `?proyekId&status=aktif\|lunas` |
| GET | `/pinjaman/jatuh-tempo` | `?hari=14` → `DueReminder[]` (`pinjaman` berisi ringkasan, ditambah `tanggal` ISO) |
| GET | `/pinjaman/:id` | Pinjaman + `entries` (pembayaran) + `topUps` + `pencairanAwal` |
| POST | `/pinjaman` | `{ proyekId, kodePembantuId \| namaBank, noAkad?, pola, tanggalPencairanAwal, nominalPencairanAwal, akunKasId, noBukti?, tanggalAcuanBunga, tanggalJatuhTempoPokok, akunHutangId?, akunBebanBungaId?, keterangan? }` |
| PATCH | `/pinjaman/:id` | `{ tanggalAcuanBunga?, tanggalJatuhTempoPokok?, pola?, noAkad?, keterangan? }` |
| DELETE | `/pinjaman/:id` | Hanya bila belum ada jurnal terposting |
| POST | `/pinjaman/:id/top-up` | `{ tanggal, nominal, akunKasId, noBukti?, keterangan? }` |
| POST | `/pinjaman/:id/pembayaran` | `{ tanggal, jenis: 'pokok'\|'bunga'\|'gabungan', nominal, nominalPokok?, nominalBunga?, periodeBunga?, akunKasId, noBukti?, keterangan? }` |
| PATCH | `/pinjaman/transaksi/:id/rincian` | `{ nominalPokok, nominalBunga }` untuk gabungan yang `menunggu_rincian` |
| DELETE | `/pinjaman/transaksi/:id` | Hapus top up / pembayaran |

Perbedaan dari store:
- `akunKasId` wajib di form tambah pinjaman (rekening penerima pencairan).
- `totalPencairan`, `sisaPokok`, `penebusan`, `status` dihitung server dari jurnal terposting; jangan dihitung ulang di FE.
- Gabungan tanpa `nominalPokok` + `nominalBunga` disimpan `statusRincian: 'menunggu_rincian'` dan tidak bisa diposting sampai rinciannya diisi.
- Bunga dengan tanggal acuan 29-31 jatuh ke akhir bulan bila bulannya lebih pendek.

## Kontrak kontraktor (`kontrakStore`)

| Method | Path | Body |
| --- | --- | --- |
| GET | `/kontrak` | `?proyekId&status=aktif\|batal` |
| GET | `/kontrak/:id` | Kontrak + `adendums` + `pembayarans` |
| POST | `/kontrak` | `{ noSpk, proyekId, unitId, tipe?, tanggalSpk, kontraktorId \| namaKontraktor, rab, nilaiKontrak, keterangan?, akunPersediaanId, akunHutangId? }` |
| POST | `/kontrak/:id/adendum` | `{ noAdendum, tanggal, nilaiBaru, alasan }` (nilai lama diisi server) |
| POST | `/kontrak/:id/pembayaran` | `{ tanggal, nominal, akunKasId, noBukti?, keterangan? }` |
| DELETE | `/kontrak/pembayaran/:id` | |
| POST | `/kontrak/:id/batal` | `{ tanggal?, alasan? }`. Sisa yang belum dibayar dibalik ke persediaan |

Perbedaan dari store: kavling dipilih dari `GET /proyek/:id/kavling` dan dikirim sebagai `unitId` (respons tetap membawa `kavling` = kode unit). `kontraktorId` = id kode pembantu kategori kontraktor. Respons menambah `nilaiTerkini` (setelah adendum), `totalDibayar`, `sisaHutang`.

## SHM / PBG (`shmStore`)

| Method | Path | Body |
| --- | --- | --- |
| GET | `/shm` | `?proyekId&pinjamanId` (`getShmByPinjaman`) |
| GET | `/shm/opsi` | `{ statusKustom[], lokasi[], statusPbgKustom[] }` untuk saran isian |
| GET | `/shm/:id` | |
| POST | `/shm` | `{ nomorShm, unitId, status, statusKustom?, lokasi, pinjamanBankId?, noPbg?, statusPbg, statusPbgKustom? }` |
| PATCH | `/shm/:id/status` | `{ keStatus, lokasi, keterangan?, pinjamanBankId?, statusKustom? }` (pengganti `updateStatus`) |
| PATCH | `/shm/:id/pbg` | `{ noPbg?, statusPbg, statusPbgKustom? }` |
| DELETE | `/shm/:id` | Ditolak selama SHM dijaminkan |

Satu kavling satu SHM, nomor SHM unik. Status `dijaminkan` wajib `pinjamanBankId`; `namaBank` diisi server dari pinjaman. `lokasiKustom` tidak dipakai: `lokasi` teks bebas, sarannya dari `/shm/opsi`. Riwayat dicatat server.

## Belum tersedia (fase berikutnya)

Legal (pustaka pasal, template, dokumen SPPR), piutang (jadwal angsuran, alokasi pembayaran), dan sinkronisasi pembayaran dari PR Track. Store-nya tetap dipakai sampai endpoint-nya siap.
