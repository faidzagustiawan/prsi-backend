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

## Akun sistem

Peran akun untuk jurnal otomatis penjualan. Perlu diatur sekali oleh Keuangan (seed dev sudah mengisinya).

| Method | Path | Body |
| --- | --- | --- |
| GET | `/akun-sistem` | `[{ kunci, label, akunId }]` |
| PUT | `/akun-sistem/:kunci` | `{ akunId }` |

Kunci: `titipan_booking_fee`, `uang_muka_penjualan`, `piutang_penjualan`, `penjualan`, `hpp`, `persediaan_kavling`, `pendapatan_lain`, `hutang_pengembalian`, `beban_cashback_kpr`, `beban_admin_kpr`.

## Legal: pustaka pasal (`pustakaPasalStore`)

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/pasal` | `?berlaku=semua\|cash\|kpr\|in_house&aktif=true\|false` |
| GET | `/pasal/:id/dipakai` | `{ template, dokumen }` (pengganti `hitungDipakai`) |
| POST | `/pasal` | `{ judul, isi, berlaku, ptId?, fields: [{ key, label, tipe }], aktif? }` |
| PATCH | `/pasal/:id` | Kolom yang diubah; `{ aktif: false }` = `nonaktifkan` |
| DELETE | `/pasal/:id` | Hanya bila belum dipakai template/dokumen |

## Legal: template (`templateDokumenStore`)

| Method | Path | Body |
| --- | --- | --- |
| GET | `/template-dokumen` | `?ptId` |
| POST | `/template-dokumen` | `{ ptId, tipeTransaksi: 'Cash'\|'KPR'\|'In House', nama?, polaNomor, pasalIds[], aktif? }` |
| PATCH | `/template-dokumen/:id` | Kolom yang diubah; `pasalIds` = urutan baru |
| POST | `/template-dokumen/:id/duplikat` | Salinan dibuat nonaktif |
| DELETE | `/template-dokumen/:id` | Hanya bila belum dipakai dokumen |

`polaNomor` wajib memuat `{NO}`. Token lain: `{PT}` (singkatan PT), `{TAHUN}`, `{BULAN}`, `{TIPE}`. Nomor urut per PT, tipe, dan tahun.

## Legal: dokumen SPPR (`dokumenLegalStore`)

| Method | Path | Body |
| --- | --- | --- |
| GET | `/dokumen` | `?perumahanId&status&q` |
| GET | `/dokumen/penjualan-tersedia` | `?proyekId` → penjualan PR Track yang belum punya SPPR final (kavling, pembeli, tipe) |
| GET | `/dokumen/:id` | |
| POST | `/dokumen` | `{ ptId, kavlingId, assignmentId?, templateId?, tipeTransaksi?, pembeli, hargaAwal, bphtb, ajbBbn, uangMuka, tanggalPerjanjian, fasilitasTambahan?, status? }` |
| PATCH | `/dokumen/:id` | Pengganti `updateDataUtama` (+ `assignmentId`) |
| DELETE | `/dokumen/:id` | Draft saja |
| POST | `/dokumen/:id/pasal` | `{ pustakaId }` atau `{ judul, isi, fields }`, `index?` |
| PATCH | `/dokumen/:id/pasal/:pasalId` | `{ judul?, isi?, fieldValues?: { key: nilai } }` (pengganti `updatePasalUtama` + `updatePasalField`) |
| DELETE | `/dokumen/:id/pasal/:pasalId` | |
| PUT | `/dokumen/:id/pasal-urutan` | `{ pasalIds }` semua id pasal, urutan baru (pengganti `reorderPasal`) |
| PUT | `/dokumen/:id/jadwal` | `{ tanggalAcuan, nominalPerBulan, tanggalMulai, jatuhTempoTerakhir, baris? }` |
| DELETE | `/dokumen/:id/jadwal` | |
| PATCH | `/dokumen/:id/jadwal/baris/:barisId` | `{ jumlah }` |
| POST | `/dokumen/:id/finalisasi` | Pengganti `updateStatus('final')` + `addFromLegal` |
| POST | `/dokumen/:id/tandatangani` | final → ditandatangani |

Perbedaan dari store:
- Buat dokumen dimulai dari **penjualan PR Track** (`GET /dokumen/penjualan-tersedia`), bukan `DUMMY_KAVLING`. `assignmentId` mengisi kavling, tipe, dan data pembeli awal. Tanpa `assignmentId` draft tetap bisa dibuat, tetapi finalisasi ditolak.
- Pasal disalin server dari template aktif PT + tipe (atau `templateId`). Tidak perlu mengirim `pasalDokumen` dan `ptSingkatan`.
- `noDokumen` dibuat server dari pola template.
- Jadwal dihitung server bila `baris` tidak dikirim. Tanggal acuan 29–31 jatuh ke akhir bulan yang lebih pendek.
- `riwayatStatus` dicatat server. `lampiranScan` diganti lampiran: `POST /lampiran?entityType=dokumen&entityId=<id>`.
- Respons menambah `kavling` (kode, tipe, luas), `perumahanId`, `hargaNett`.
- Placeholder `{key}` tetap diisi di frontend (`autoValues`), seperti sekarang.

Finalisasi menolak bila: tanpa `assignmentId`, nama pembeli kosong, harga awal 0, total jadwal ≠ uang muka, atau penjualan itu sudah punya SPPR final. Bila lolos, dalam satu transaksi: kartu piutang dibuat, jadwal masuk `jadwal_angsuran` dan antre dikirim ke PR Track, dan booking fee yang sudah masuk dipindah dari Titipan booking fee ke Uang muka penjualan.

## Legal: adendum SPPR

Perubahan harga, jadwal, atau kavling setelah SPPR final (pengganti catatan "Perubahan nilai uang dan jadwal memerlukan fitur Adendum" di `LegalEditorPage`).

| Method | Path | Body |
| --- | --- | --- |
| POST | `/dokumen/:id/adendum` | `{ alasan, biayaPindah?, tanggal? }`. `:id` = dokumen yang sedang `berlaku` |
| GET | `/dokumen/:id/riwayat` | Rantai SPPR + adendum: `[{ id, noDokumen, jenis: 'sppr'\|'adendum', status, berlaku, alasan, pindahKavling, nilaiSppr }]` |

Alur di frontend:
1. Pada dokumen dengan `berlaku: true`, tombol "Buat adendum" memanggil `POST /dokumen/:id/adendum`. Hasilnya dokumen draft baru (`jenisDokumen: 'ADENDUM'`, `indukId`, nomor `<SPPR asal>/ADD-01`) yang menyalin data, pasal, dan jadwal yang berlaku.
2. Ubah adendum dengan endpoint dokumen biasa: `PATCH /dokumen/:id`, pasal, dan `PUT /dokumen/:id/jadwal`. Total jadwal tetap harus sama dengan uang muka.
3. `POST /dokumen/:adendumId/finalisasi`. Nilai SPPR di piutang diganti, jadwal lama dinonaktifkan, dan jadwal baru dibuat; keduanya dikirim ke Track. Semua pembayaran yang sudah masuk dialokasikan ulang ke jadwal baru.

Pindah kavling: kavling diganti dulu di PR Track (assignment yang sama). Setelah sinkron, kartu piutang menandai `perluAdendum: true`. Adendum otomatis memakai kavling baru; `biayaPindah` dijurnal dari uang muka ke pendapatan lain-lain saat final.

Ditolak:
- adendum dari dokumen yang tidak `berlaku`;
- adendum kedua selagi masih ada adendum draft;
- `biayaPindah` tanpa pindah kavling;
- setelah BAST: pindah kavling, atau perubahan nilai SPPR.

Field baru di respons dokumen: `jenisDokumen` (`'SPPR'`/`'ADENDUM'`), `adendum` (`{ alasan, biayaPindah, pindahKavling, kavlingLamaId }`), `berlaku`.

## Piutang (`piutangStore`)

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/piutang` | `?proyekId&statusBast` → `KavlingTagihan[]` |
| GET | `/piutang/ringkasan` | `?proyekId` → `{ jumlah, totalNilaiKontrak, totalDibayar, totalSisa }` |
| GET | `/piutang/:id` | |
| POST | `/piutang/:id/bast` | `{ tanggal, nilaiHpp? }` |
| POST | `/piutang/:id/batal` | `{ tanggal, potongan, alasan? }` (belum BAST) |
| POST | `/piutang/:id/biaya-kpr` | `{ jenis: 'cashback'\|'admin', tanggal, nominal, akunKasId, noBukti? }` |
| POST | `/piutang/:id/alokasi/pindah` | `{ dariJadwalId, keJadwalId, nominal }` (pengganti `updateAlokasi`) |

`KavlingTagihan` sama dengan store, ditambah:
- `perluAdendum`: kavling di PR Track sudah dipindah tetapi SPPR belum diadendum (BAST ditolak selama true);
- `assignmentId`, `status`, `tanggalBast`, `nomorSppr`, `totalDibayar`, `sisa`, `nilaiCashbackKpr`, `nilaiAdminKpr`;
- `pembayaran[]` (semua pembayaran Track beserta `statusProses`);
- per periode: `jadwalId`, `status` (sudah dihitung server, sama dengan `computeStatus`).

`dibayar` per periode hanya berasal dari pembayaran yang sudah dijurnal. Kartu piutang tidak bisa diubah langsung; angkanya berubah lewat pembayaran Track, koreksi alokasi, BAST, atau batal.

## Pembayaran PR Track (Alur 2)

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/pembayaran-track` | `?statusProses=belum_diproses\|menunggu\|dijurnal\|gagal_validasi\|perlu_ditinjau&assignmentId` |
| POST | `/pembayaran-track/proses` | Proses semua yang belum/menunggu (nanti dijalankan worker) |
| POST | `/pembayaran-track/:id/proses` | Proses ulang satu pembayaran |

Untuk layar antrean Keuangan (tombol "Sinkron" di halaman Piutang):
- `menunggu`: belum diverifikasi di Track, atau auto-injeksi KPR.
- `gagal_validasi` tanpa `jurnalId`: data Track salah (penjualan, jenis, rekening tujuan). Perbaiki di Track, lalu proses ulang.
- `gagal_validasi` dengan jurnal draft: bukti kurang, terindikasi duplikat, atau periode terkunci. Lengkapi lalu posting jurnalnya (`POST /jurnal/:id/posting`); alokasi berjalan otomatis setelah posting.
- `perlu_ditinjau`: berubah di Track setelah dijurnal. Jurnal tidak diubah otomatis. Balik jurnalnya (`POST /jurnal/:id/balik`), lalu proses ulang.

Tutup buku (`/periode/tutup`) ditolak selama masih ada `gagal_validasi` atau `perlu_ditinjau` di bulan itu.

## Sinkronisasi PR Track (role keuangan atau admin)

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/sinkron/status` | `{ aktif, cursorSeq, dataTrackPer, jedaMenit, errorTerbuka, outbox, antreanPembayaran, rekonsiliasiTerakhir, peringatan[] }` |
| GET | `/sinkron/log` | 50 putaran terakhir |
| GET | `/sinkron/error` | Event Track yang belum berhasil diterapkan |
| POST | `/sinkron/jalankan` | Satu putaran sekarang (tombol "Sinkron" di Piutang). Maks 6x/menit. `409` bila sinkronisasi dimatikan |
| POST | `/sinkron/rekonsiliasi` | Cek checksum sekarang |

Tampilkan `dataTrackPer` ("data Track per jam HH:MM") di layar yang memakai data PR Track, dan `peringatan` di dashboard Keuangan.

## Belum tersedia

Endpoint `/sync/v1` di sisi PR Track (kontraknya di [TrackSyncAPI.md](TrackSyncAPI.md)); sampai siap, dev memakai `npm run mock:track`.
