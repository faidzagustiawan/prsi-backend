# Kontrak integrasi backend untuk FE

Tanggal: 10 Oktober 2026. Referensi FE: repo fikrihidayah01/FE_Podorukun-SI.
Perubahan dalam pekerjaan ini hanya backend. Deployment FE belum tetap;
origin localhost/Vercel yang persis belum diberikan. Perubahan backend belum
dipasang ke VPS. Kontrak kode lokal dapat berbeda dari versi VPS sampai deployment.

## Sumber kontrak

- Base API: `https://podorukunsi.my.id/api/v1`; health: `/health`.
- `GET /openapi.json`: seluruh endpoint, metode HTTP, parameter path/query,
  payload wajib/opsional, multipart, status dan role. Gunakan kontrak dari versi
  backend yang sedang dipakai. `npm run docs:build` mengekspor kontrak lokal.
- [API_GUIDE.md](API_GUIDE.md): aturan bisnis, pagination, error, unggahan.
- ID di seluruh contoh harus diperoleh dari API; jangan mengirim UUID contoh ke produksi.

## Autentikasi localhost/Vercel development

Gunakan Bearer lintas situs dan `credentials: 'omit'` pada mode CORS terbuka.
Login: `POST /auth/login` dengan `{email,password}`. Respons:

```json
{
  "success": true,
  "message": "Login berhasil",
  "data": {
    "user": {"id":"<uuid>","name":"<nama>","email":"<email>","role":"keuangan"},
    "accessToken":"<rahasia>",
    "refreshToken":"<rahasia>",
    "tokenType":"Bearer",
    "expiresIn":900,
    "refreshExpiresIn":604799
  }
}
```

Kirim `Authorization: Bearer <accessToken>` untuk endpoint bisnis dan `/auth/me`.
`POST /auth/refresh` menerima `{refreshToken}` dan mengembalikan pasangan token
baru dengan envelope yang sama. Sisa umur refresh tidak bertambah setelah rotasi.
`POST /auth/logout` menerima `{refreshToken}`; sertakan Bearer juga agar logout
mencabut ID sesi yang sama walau beradu dengan rotasi. Hapus token dari memori
klien setelah logout. Login ulang jika refresh 401.

Gunakan satu promise refresh bersama: semua request 401 menunggu promise yang
sama, menyimpan token baru lalu retry sekali. Jangan mendaftarkan waiter setelah
promise selesai. Jangan retry refresh/login/logout secara rekursif.

Temuan pada clone FE saat audit: `src/lib/api.ts` memakai cookie saja dengan
`credentials: 'include'`; pemimpin refresh memanggil `onRefreshed` sebelum
mendaftarkan dirinya, sehingga promise pemimpin dapat menunggu tanpa penyelesaian.
Penyesuaian ini menjadi pekerjaan teman FE. Backend menerbitkan token Bearer di body.

Role keuangan boleh mengakses semua proyek/PT sesuai keputusan pemilik.
Admin/teknisi/marketing/kontraktor menerima 403 pada transaksi keuangan.
Cookie produksi tetap HttpOnly, Secure, SameSite=Strict. Setelah origin final
dikonfirmasi, uji preflight, cookie, refresh dan CSRF menggunakan browser dari
origin tersebut sebelum menentukan alur cookie lintas situs.

## Endpoint dan alur utama

Seluruh path berikut relatif ke `/api/v1`. Respons sukses memakai
`{success:true,message,data}` kecuali dinyatakan berbeda.

| Metode/path | Input penting | Respons `data` / perilaku |
| --- | --- | --- |
| GET `/master-pt/companies` | Tidak ada | Array `{id,trackId,nama,kode}`; `id` lokal untuk pemetaan |
| GET `/master-pt` / GET `/master-pt/{id}` | UUID pada detail | Array/objek PT |
| POST `/master-pt` | `namaPt,namaDirektur`; opsional `trackCompanyId,perumahanId,singkatan,ttl,pekerjaan,alamat,noKtp` | 201, PT baru |
| PATCH `/master-pt/{id}` | Hanya field berubah; `trackCompanyId:null` melepas pemetaan | PT, legal field lainnya dipertahankan |
| GET `/proyek` | Tidak ada | Array `{id,nama,kode,status,ptId}` |
| GET `/proyek/{id}/kavling` | UUID proyek | Array kavling `{id,kode,tipe,luasTanah,luasBangunan,status}` |
| GET `/jurnal` | `page,limit,proyekId,status,sumber,bulan,q` | Array jurnal dan `meta:{page,limit,total}` |
| POST `/jurnal` | `tanggal,keterangan,proyekId,rows`; `status:draft` | 201, jurnal |
| PUT `/jurnal/{id}` | Body jurnal lengkap | Jurnal diperbarui; periode terkunci ditolak |
| POST `/jurnal/{id}/posting` | Tanpa body | Jurnal diposting; kas/bank memerlukan bukti |
| POST `/jurnal/{id}/balik` | Opsional `tanggal,keterangan` | 201, jurnal balik di periode terbuka |
| POST `/lampiran?entityType=jurnal&entityId={id}` | Multipart satu field `file` | 201, metadata lampiran |
| GET `/lampiran?entityType=jurnal&entityId={id}` | Owner query wajib | Array lampiran; `entityType:dokumen` juga didukung |
| GET `/lampiran/{id}/unduh` | Opsional `inline=1` | Binary atau 302 ke sumber Track; autentikasi tetap wajib |
| DELETE `/lampiran/{id}` | UUID | Hanya saat state pemilik membolehkan; jurnal diposting ditolak |
| GET `/saldo-awal/{proyekId}` | UUID proyek | Set saldo awal; `id:null` bila belum tersimpan |
| PUT `/saldo-awal/{proyekId}` | `tanggalMulai?,saldo:[{akunId,kodePembantuId?,debit,kredit}]` | Mengganti seluruh set terbuka |
| POST `/saldo-awal/{proyekId}/kunci` | Tanpa body | Total debit/kredit harus sama; perubahan berikutnya 409 |
| GET `/periode` | Opsional `ptId` | Array periode; yang belum ada berarti terbuka |
| POST `/periode/tutup` | `{ptId,bulan:"YYYY-MM"}` | Periode terkunci; draft/antrean gagal ditolak |
| POST `/kontrak` | `noSpk,proyekId,unitId,tanggalSpk,rab,nilaiKontrak,akunPersediaanId`; `kontraktorId` atau `namaKontraktor`; `akunHutangId?` | 201, kontrak dan jurnal pengakuan |
| POST `/kontrak/{id}/adendum` | `noAdendum,tanggal,nilaiBaru,alasan` | 201, kontrak dengan `adendums` terbaru |
| POST `/kontrak/{id}/pembayaran` | `tanggal,nominal,akunKasId,noBukti?,keterangan?` | 201, kontrak dengan `pembayarans`; unggah bukti pada `jurnalId` pembayaran |
| POST `/dokumen` | `ptId,kavlingId,tanggalPerjanjian`; `assignmentId?`, data pembeli/harga/tipe/template | 201, SPPR draft; PT harus terkait proyek kavling |
| PUT `/dokumen/{id}/jadwal` | `tanggalAcuan,nominalPerBulan,tanggalMulai,jatuhTempoTerakhir,baris?` | Dokumen dengan jadwal |
| POST `/dokumen/{id}/finalisasi` | Tanpa body | Dokumen final, kartu piutang/jadwal/outbox atomik |
| POST `/dokumen/{id}/adendum` | `alasan,biayaPindah?,tanggal?` | 201, dokumen adendum draft; edit/finalisasi memakai endpoint dokumen biasa |
| POST `/shm` | `nomorShm,unitId,status,lokasi`; data PBG/pinjaman opsional | 201, SHM dengan riwayat |
| PATCH `/shm/{id}/status` | `keStatus,lokasi,keterangan?,pinjamanBankId?,statusKustom?` | SHM dan riwayat baru; dijaminkan wajib pinjaman valid |

## Bentuk respons bisnis

- PT: `id,trackCompanyId,namaPt,singkatan,namaDirektur,ttl,pekerjaan,alamat,
  noKtp,perumahanId?,createdAt,updatedAt`. `trackCompanyId` menunjuk ID cermin
  lokal, bukan UUID sumber. Satu company satu PT; relasi perumahan harus cocok.
- Jurnal: `id,nomorJurnal,tanggal,keterangan,noReferensi,proyekId,ptId,sumber,
  status,refType,refId,mirrorId,dibalikOlehId,totalDebit,totalKredit,rows,lampiran,
  dibuatOleh,dipostingPada,createdAt,updatedAt`. Baris:
  `{id,akunId,kodePembantuId,keterangan,debit,kredit}`.
- Lampiran: `id,nama,tipe,mime,ukuranBytes,url,createdAt`; `tipe` adalah
  `pdf` atau `gambar`. Header Authorization tidak otomatis ikut link `<a>`;
  klien Bearer perlu fetch unduhan terautentikasi lalu menangani blob/redirect.
- Saldo awal: `id,proyekId,tanggalMulai,status,dikunciPada,saldo,totalDebit,totalKredit`.
- Periode: `id,ptId,bulan,status,ditutupOleh,ditutupPada`.
- Kontrak: `id,noSpk,proyekId,unitId,kavling,tipe,tanggalSpk,kontraktorId,
  namaKontraktor,rab,nilaiKontrak,nilaiTerkini,totalDibayar,sisaHutang,keterangan,
  akunPersediaanId,akunHutangId,status,jurnalId,nomorJurnal,jurnalStatus,
  butuhLampiran,createdAt`; detail memuat `adendums,pembayarans`.
  Pembayaran draft belum menambah `totalDibayar` sampai jurnal diposting.
- Dokumen: `id,noDokumen,ptId,kavlingId,kavling,perumahanId,assignmentId,
  templateId,pembeli,tipeTransaksi,hargaAwal,bphtb,ajbBbn,uangMuka,hargaNett,
  tanggalPerjanjian,status,pasalDokumen,jadwalPembayaran?,fasilitasTambahan?,
  lampiran,riwayatStatus,jenisDokumen,indukId,adendum,berlaku,createdAt`.
- SHM: `id,nomorShm,unitId,kavling,proyekId,status,statusKustom?,lokasi,
  pinjamanBankId?,namaBank?,noPbg?,statusPbg,statusPbgKustom?,riwayat,createdAt`.

Properti nullable/opsional mengikuti respons endpoint; jangan menganggap seluruh
field selalu berisi string. Modul lain tetap dirinci pada OpenAPI dan API_GUIDE.
Beberapa skema respons OpenAPI masih berupa envelope generik; daftar DTO di atas
menjelaskan modul alur integrasi yang diverifikasi.

## Error, pagination dan file

- 400: input/referensi/duplikasi umum; 401: sesi tidak valid; 403: role/origin;
  404: tidak ditemukan; 409: konflik state/pemetaan; 422: aturan bisnis;
  429: throttle; 500: kegagalan server.
- Error: `{success:false,message,errors:[]}`. Elemen `errors` bisa string atau
  `{field,message}`. Tampilkan pesan server dan jangan refresh pada 403/422/500.
- Jurnal memakai page 1, limit 50, maksimum 200. Array Master PT/proyek/kontrak/
  SHM/periode tidak memakai pagination. Periksa parameter tiap endpoint di OpenAPI.
- Unggahan: PDF/JPEG/PNG/WEBP, maksimum 10 MiB, satu file/request, signature file
  diverifikasi backend. Saat memakai FormData jangan menetapkan Content-Type manual.
- Alur kas/bank: buat draft → unggah lampiran ke jurnal → posting → baca ulang
  dokumen/jurnal. PUT jurnal mengirim body lengkap; PATCH entitas lain hanya field berubah.

## Status verifikasi

Tes integrasi opt-in memakai PostgreSQL lokal kosong `prsi_test_*`, tidak memakai
database produksi. Lihat [BACKEND_AUDIT_20261010.md](BACKEND_AUDIT_20261010.md).
Tes otomatis tidak menggantikan uji browser FE dari origin deployment final.
