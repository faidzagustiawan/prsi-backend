# Scalar API reference

Dokumentasi backend terpisah dari frontend aplikasi dan tidak dipasang di VPS.
VPS hanya menyediakan kontrak JSON pada `https://podorukunsi.my.id/openapi.json`.

## Buka lokal

Di folder backend:

```sh
npm ci
npm run docs:build
npm run docs:serve
```

Buka http://127.0.0.1:3180. Alternatif: buka file
`docs/generated/scalar.html` langsung di browser. HTML memuat Scalar dan kontrak
secara inline, tanpa CDN, font eksternal, login, API key, atau proxy pihak ketiga.
File dapat dibagikan bersama `docs/generated/openapi.json` atau dihosting terpisah.
Artefak merupakan snapshot; jalankan build lagi setelah kontrak berubah.

## Sumber dan batasan

- Parameter/body diambil dari metadata middleware `validate`/`validatePatch`.
  JSON Schema memakai input Zod sehingga nama field sebelum transformasi tetap benar.
- Role diambil dari middleware `authorize`. Deskripsi endpoint berasal dari route.
- Schema dokumentasi tidak dipasang sebagai validator/serializer runtime; bentuk
  request/response aplikasi tidak diubah demi dokumentasi.
- Envelope error mencakup string dan error field Zod. Request multipart, unduhan,
  cookie refresh, status 201, dan health didokumentasikan terpisah.
- Refinement Zod lintas field dan pengecekan data oleh service tidak seluruhnya
  terwakili JSON Schema. Aturan penting ada di API_GUIDE.md.
- Endpoint tanpa skema DTO response memakai envelope dengan data fleksibel.
  Jangan menganggap field respons lengkap hanya karena ada dokumentasi request.
- Ekspor tidak menghubungi database/Redis dan tidak memakai secret produksi.
- Build memvalidasi OpenAPI sebelum menghasilkan HTML; tes membandingkan seluruh
  route terdaftar dengan operasi yang didokumentasikan.

## Mencoba request

Scalar ini menyediakan pencarian endpoint, schema, contoh kode dan unduhan kontrak.
Tombol uji browser dimatikan: cookie produksi SameSite=Strict dan origin dokumentasi
belum diizinkan untuk CORS. Alur cURL cookie jar dijelaskan dalam referensi.
Jangan melemahkan cookie/CORS atau memakai proxy publik untuk membuat tombol uji bekerja.
Interaksi browser dapat diaktifkan nanti jika origin dokumentasi yang sesuai sudah
ditentukan dan login-cookie diuji. Jangan meletakkan UI di VPS backend.

## Pemeliharaan

Tambahkan metadata response khusus/status ke `src/documentation/openapi.js` jika
endpoint baru tidak menggunakan envelope standar. Perbarui `API_GUIDE.md` bila
aturan bisnis berubah. Jalankan `npm test` dan `npm run docs:build` sebelum rilis.
UI Scalar adalah devDependency, tidak ikut `npm ci --omit=dev` di VPS.
