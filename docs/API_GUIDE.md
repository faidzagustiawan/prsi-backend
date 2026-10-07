API untuk keuangan, legal, piutang, dan sinkronisasi PR Track. Dokumentasi mengikuti
route dan validator backend. Semua contoh memakai data ilustrasi, bukan data produksi.

## Mulai di sini

- **Produksi:** `https://podorukunsi.my.id/api/v1`.
- **Development:** `http://localhost:3100/api/v1`.
- **Kesehatan:** `GET /health`, tanpa login. `200` berarti DB dan Redis sehat;
  `503` berarti salah satu dependency bermasalah.
- **Kontrak mesin:** `GET /openapi.json`. File ini dapat diimpor ke klien API.
- VPS hanya melayani backend/API. Scalar dibuka lokal atau di hosting dokumentasi terpisah.

## Login dan sesi

1. `POST /api/v1/auth/login` dengan JSON `{ "email": "keuangan@example.test", "password": "password-anda" }`.
2. Server mengirim cookie **si_access_token** (15 menit) dan **si_refresh_token**
   (7 hari). Cookie HttpOnly; Secure di produksi; SameSite=Strict. Refresh cookie
   hanya berlaku pada path `/api/v1/auth`.
3. Browser menggunakan `credentials: 'include'` pada setiap request. Cookie tidak
   dibaca JavaScript. Token tidak dikembalikan di body login dan tidak perlu
   disimpan di localStorage atau ditempel ke dokumentasi.
4. Saat API mengembalikan `401`, panggil `POST /api/v1/auth/refresh`, lalu ulangi
   request sekali. Refresh merotasi token; hindari beberapa refresh paralel.
5. Jika refresh gagal, login kembali. Logout lewat `POST /api/v1/auth/logout`.

Autentikasi JWT backend juga dapat membaca header Authorization, tetapi alur login
aplikasi hanya menerbitkan cookie. Dokumentasi ini menggunakan alur cookie tersebut.

Contoh cURL (gunakan akun milik Anda; cookie jar adalah rahasia):

```bash
curl -c cookies.txt -H 'Content-Type: application/json' \
  --data '{"email":"keuangan@example.test","password":"password-anda"}' \
  https://podorukunsi.my.id/api/v1/auth/login
curl -b cookies.txt https://podorukunsi.my.id/api/v1/auth/me
curl -b cookies.txt -c cookies.txt -X POST https://podorukunsi.my.id/api/v1/auth/refresh
curl -b cookies.txt -c cookies.txt -X POST https://podorukunsi.my.id/api/v1/auth/logout
```

## Hak akses

| Kelompok endpoint | Role |
| --- | --- |
| Login, logout, health | Tidak membutuhkan access cookie |
| Refresh | Refresh cookie yang masih berlaku |
| Profil `/auth/me` | Semua role yang login |
| Modul keuangan, proyek, legal, lampiran, laporan, piutang | `keuangan` |
| Pemantauan dan aksi sinkronisasi | `admin` atau `keuangan` |

**Admin tidak otomatis memiliki akses modul keuangan.** Akun pengujian ber-role
admin akan menerima `403` pada endpoint yang hanya mengizinkan keuangan.
Daftar role aplikasi: admin, keuangan, teknisi, marketing, kontraktor.

## CORS dan autentikasi lintas origin

Selama masa uji, `CORS_ALLOW_ALL=true` di produksi: origin mana pun (termasuk
`http://localhost:*`) diizinkan. Setelah domain frontend pasti, isi
`FRONTEND_URL` dan kembalikan `CORS_ALLOW_ALL=false`.

Cookie sesi memakai `SameSite=Strict`, sehingga browser tidak mengirimnya dari
situs lain. Frontend lintas situs memakai token Bearer:

1. `POST /api/v1/auth/login` mengembalikan `data.accessToken` (JWT, 15 menit),
   `data.refreshToken` (7 hari, sekali pakai), `tokenType` dan `expiresIn`.
2. Setiap request terautentikasi mengirim `Authorization: Bearer <accessToken>`.
3. Bila menerima `401`, panggil `POST /api/v1/auth/refresh` dengan body
   `{ "refreshToken": "..." }` satu kali, simpan kedua token baru, lalu ulangi
   request. Refresh gagal berarti login ulang.
4. `POST /api/v1/auth/logout` dengan body `{ "refreshToken": "..." }` mencabut sesi.

Tidak perlu `credentials: 'include'`. Simpan token di memori bila memungkinkan;
token di `localStorage` terbuka bagi XSS. Klien sesitus tetap dapat memakai
cookie. Scalar lokal adalah referensi baca; gunakan cURL/klien API untuk
mencoba produksi. Tidak ada proxy pihak ketiga.

## Format data

- ID adalah UUID. ID contoh harus diganti dengan ID nyata dari API.
- Uang menggunakan angka rupiah, maksimal dua desimal; gunakan JSON number,
  tanpa pemisah ribuan. Aturan keseimbangan jurnal tetap diperiksa server.
- Tanggal: `YYYY-MM-DD`; periode: `YYYY-MM`; timestamp: ISO 8601.
- Daftar yang mendukung pagination memakai `page` (default 1), `limit`
  (default 50, maksimum 200), serta `meta.page`, `meta.limit`, `meta.total`.
  Endpoint lain dapat mengembalikan array tanpa pagination.
- PATCH hanya mengubah field yang dikirim. Body kosong ditolak pada route yang
  memakai validator PATCH. PUT mengikuti body lengkap pada endpoint terkait.

Respons sukses umumnya `{ success: true, message, data, meta? }`.
Respons gagal `{ success: false, message, errors }`. Item errors dapat berupa
string **atau** `{ field, message }` untuk validasi Zod; jangan mengasumsikan satu bentuk.
Health dan unduhan berkas memakai bentuk respons tersendiri.

Skema request diambil dari validator aktual, termasuk input sebelum transformasi.
Refinement lintas field dan pengecekan database tidak seluruhnya terwakili dalam
OpenAPI; baca aturan bisnis di bawah. Untuk endpoint yang belum memiliki skema
DTO response, `data` sengaja bersifat fleksibel dan tidak diberi field rekaan.

## Kode status dan batas permintaan

| Status | Penanganan |
| --- | --- |
| 200 / 201 | Berhasil / data dibuat |
| 400 | Perbaiki input, duplikasi, atau referensi data |
| 401 | Refresh sekali; login ulang jika gagal |
| 403 | Periksa role dan origin |
| 404 | Periksa ID atau path |
| 409 | Konflik state/integrasi |
| 413 | Unggahan terlalu besar |
| 422 | Aturan bisnis gagal; tampilkan pesan dari server |
| 429 | Tunggu sebelum mengulangi permintaan |
| 500 / 502 / 503 | Gangguan server/dependency; jangan mengulang transaksi tulis secara buta |

Batas umum 300 request/menit per IP. Login dibatasi 20/menit per IP, ditambah
throttle per email (10 percobaan gagal dalam 15 menit). Refresh 60/menit.
Aksi sinkronisasi 6/menit; rekonsiliasi 2/menit. Endpoint menunjukkan limit khusus.

## Alur bisnis utama

**Jurnal:** pilih proyek dan akun, buat draft dengan baris debit/kredit, unggah
lampiran jika ada kas/bank, kemudian posting. Periode terkunci tidak menerima
perubahan; koreksi memakai jurnal balik di periode berjalan. Request memakai
`keterangan`, yang dipetakan menjadi `uraian` oleh backend.

**Lampiran:** `POST /lampiran?entityType=jurnal&entityId=<uuid>` atau
`entityType=dokumen`. Multipart field `file`, satu PDF/JPEG/PNG/WEBP, maksimal
10 MiB. Unduhan dapat berupa berkas atau redirect ke sumber Track.

**SPPR:** buat draft, lengkapi pembeli, harga, pasal, dan jadwal. Finalisasi
memerlukan penjualan Track serta konsistensi nilai/jadwal; perubahan setelah
final dilakukan lewat adendum. Penjualan yang sudah BAST membatasi perubahan.

**Piutang:** pembayaran berasal dari cermin PR Track dan diproses ke jurnal.
Nilai kartu mengikuti pembayaran yang sudah dijurnal, alokasi, BAST, atau pembatalan.
Jangan membuat transaksi contoh di produksi hanya untuk menguji dokumentasi.

**Track:** SI membaca tabel cermin pada database sendiri; tidak mengakses DB Track
langsung. Proyek/kavling dikelola di Track. Sinkronisasi produksi saat ini nonaktif;
data cermin dapat kosong. Aksi sinkron tidak boleh dianggap berhasil menarik data
jika integrasi belum dikonfigurasi.
