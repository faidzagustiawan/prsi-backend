# Rancangan Sistem SI Podorukun dan Integrasi PR Track

Versi draf 03/10/2026. Menggantikan `DatabaseIsolation.md` (opsi A, satu database bersama), yang tidak berlaku lagi.

Acuan: ERD SI Podorukun versi 02/10/2026 (30 tabel, 6 alur) dan keputusan arsitektur 03/10/2026.

---

## 1. Keputusan arsitektur

| | PR Track | SI Podorukun |
|---|---|---|
| Server | VPS A | VPS B |
| Database | PostgreSQL di VPS A | PostgreSQL di VPS B |
| Login | `users` Track | `users` SI, terpisah, tanpa SSO |
| Peran | Operasional proyek: unit, pembeli, progres, input pembayaran | Keuangan: jurnal, piutang, legal, hutang, tutup buku |

Aturan koneksi:

1. **Hanya SI yang membuka koneksi.** SI memanggil API Track lewat HTTPS. Track tidak menyimpan alamat, kredensial, atau akses jaringan ke SI.
2. **Arah koneksi berbeda dengan arah data.** Data boleh mengalir dua arah (Track ke SI dan SI ke Track), tetapi koneksinya selalu dimulai SI: SI menarik (GET) dan SI mengirim (POST).
3. **Tidak ada akses database lintas server.** SI tidak pernah terhubung ke database Track, begitu juga sebaliknya.
4. Bila Track mati atau dicurigai dibobol, worker dimatikan lewat satu saklar. SI tetap jalan dengan data cermin terakhir.

```
 VPS A: PR TRACK                                 VPS B: SI PODORUKUN
┌───────────────────────────┐                ┌──────────────────────────────┐
│ Aplikasi Track            │                │ Worker sinkronisasi (BullMQ) │
│   │ tulis                 │   GET /sync    │   │                          │
│   ▼                       │◄───────────────┤   │ terapkan event           │
│ DB Track                  │  token baca    │   ▼                          │
│   ├ tabel bisnis          │                │ DB SI                        │
│   └ sync_outbox (trigger) │   POST /jadwal │   ├ trk_* (cermin)           │
│                           │◄───────────────┤   ├ tabel keuangan           │
│ API sinkronisasi /sync/v1 │  token jadwal  │   └ outbox_track (kirim)     │
└───────────────────────────┘                │ API SI ── Aplikasi SI        │
     tidak ada jalur Track ke SI             └──────────────────────────────┘
```

---

## 2. Masalah utama: dua database, satu kebenaran

Dengan dua database, setiap data yang dipakai kedua sistem pasti punya dua salinan. Konsistensi dijaga oleh empat aturan:

1. **Satu pemilik per data.** Setiap kolom punya tepat satu sistem pemilik. Hanya pemilik yang boleh mengubah. Salinan di sistem lain hanya baca.
2. **Setiap perubahan tercatat sebagai event berurutan.** Tidak ada perubahan, termasuk hapus, yang bisa lolos tanpa tercatat.
3. **Penerapan idempoten dan berversi.** Event yang sama boleh diterima berkali-kali, dan event lama tidak boleh menimpa data yang lebih baru.
4. **Rekonsiliasi berkala membuktikan kedua sisi sama.** Kalau ada selisih, selisih itu terdeteksi, diperbaiki, dan dilaporkan.

Aturan 1 mencegah konflik. Aturan 2 dan 3 menjaga salinan selalu menyusul pemiliknya. Aturan 4 menangkap apa pun yang lolos dari aturan 2 dan 3.

### 2.1 Arti "konsisten" di rancangan ini

- **Konsisten pada akhirnya (eventual), dengan jeda terukur.** Cermin di SI tertinggal paling lama satu putaran worker (target ≤ 5 menit). Setiap layar SI yang memakai data cermin menampilkan "data Track per jam HH:MM".
- **Angka keuangan tidak pernah berubah diam-diam.** Jurnal yang sudah diposting tidak diubah otomatis oleh sinkronisasi. Perubahan di Track atas data yang sudah dijurnal menjadi antrean "Perlu ditinjau" (Alur 2 dan 5).
- **Tidak ada dua sistem yang mengubah data yang sama.** Karena itu tidak perlu resolusi konflik.

---

## 3. Matriks kepemilikan data

| Data | Pemilik | Salinan di | Arah | Catatan |
|---|---|---|---|---|
| PT (`companies`) | Track | SI `trk_companies` | Track ke SI | Data direktur untuk SPPR: lihat 9.4 |
| Proyek, cluster | Track | SI `trk_projects` | Track ke SI | ERD belum punya cluster, lihat 9.3 |
| Unit / kavling | Track | SI `trk_units` | Track ke SI | Batas tanah untuk SPPR: lihat 9.4 |
| Pembeli (`users` role customer) | Track | SI `trk_customers` | Track ke SI | Hanya kolom yang perlu. Tidak pernah `password_hash` |
| Penjualan (`property_assignments`) | Track | SI `trk_assignments` | Track ke SI | Harga dan DP: lihat 9.1 |
| Pembayaran (`payment_history`) | Track (fase 1) | SI `trk_payments` | Track ke SI | Pindah ke SI di fase 2, lihat bagian 8 |
| Status kunci pembayaran | SI | Track | SI ke Track | Pembayaran yang sudah dijurnal dikunci di Track |
| Jadwal angsuran | SI | Track | SI ke Track | Track menampilkan ke pembeli, hanya baca |
| BAST keuangan, batal, cashback KPR | SI | – | – | `penjualan_keuangan` |
| Jurnal, akun, periode, saldo | SI | – | – | Tidak dikirim ke Track |
| SPPR / dokumen legal | SI | – | – | |
| Pinjaman, kontraktor | SI | – | – | |
| Akun login | masing-masing | – | – | Tidak disinkronkan |

Aturan turunan:
- Aplikasi SI **tidak punya endpoint tulis** untuk tabel `trk_*`. Hanya worker yang boleh menulis, dan itu dipaksa di level DB dengan role terpisah (6.4).
- Track **tidak punya endpoint tulis** untuk data milik SI. Endpoint jadwal hanya bisa diakses token jadwal.
- Atribut tambahan milik SI untuk data Track (misalnya BAST) disimpan di tabel 1:1 milik SI yang menunjuk `trk_*.id` (contohnya `penjualan_keuangan`). Kolom itu tidak ditambahkan ke cermin.

---

## 4. Kondisi Track saat ini: celah yang harus ditutup dulu

Hasil pemeriksaan kode Track (`backend/src`) per 03/10/2026:

| # | Temuan | Dampak ke konsistensi |
|---|---|---|
| T1 | `payment_history` tidak punya `updated_at` | Tidak bisa ditarik dengan cursor waktu. Hasil edit nominal tidak terdeteksi |
| T2 | Pembayaran dihapus permanen (`DELETE FROM payment_history`), termasuk hapus massal saat tipe pembayaran diganti | Hapus tidak terlihat oleh sinkronisasi berbasis cursor. SI tetap menganggap uang itu ada |
| T3 | `projects` dihapus permanen. `units` ikut terhapus (cascade) bila cluster dihapus | Sama seperti T2, untuk data master |
| T4 | `updated_at` diisi oleh kode aplikasi, tidak di semua jalur raw SQL, tanpa trigger | Cursor `updated_at` bisa melewatkan perubahan |
| T5 | Pembayaran negatif (refund) diam-diam mengubah `harga_total` atau `dp` di `property_assignments` dan menambah baris auto-inject KPR | Angka harga berubah tanpa jejak. SI bisa salah mengakui penjualan |
| T6 | Baris `is_auto_inject` (pencairan KPR) dibuat otomatis saat assignment KPR dibuat, sebelum uang benar-benar cair | Kalau dijurnal sebagai kas, kas jadi fiktif |
| T7 | Belum ada `status_verifikasi`, `rekening_tujuan`, `jenis` di `payment_history` | Alur 2 (validasi dan penentuan akun) tidak bisa jalan |
| T8 | Tidak ada API sinkronisasi dan tidak ada endpoint jadwal | Belum ada jalur data sama sekali |
| T9 | ID Track UUID. ERD memakai `ID*` | `track_id` di SI bertipe `UUID` |
| T10 | Hirarki Track: companies, projects, clusters, units. ERD tidak punya cluster | Proyek di ERD bisa berarti project atau cluster, perlu dipastikan |

Karena T1–T4, rancangan ini **tidak memakai cursor `updated_at`** seperti di draf ERD, melainkan outbox berurutan (bagian 5).

---

## 5. Jalur Track ke SI: outbox berurutan

### 5.1 Di Track: tabel `sync_outbox` diisi trigger

```sql
CREATE TABLE sync_outbox (
  seq         BIGSERIAL PRIMARY KEY,          -- urutan global, tidak pernah mundur
  entity      VARCHAR(30) NOT NULL,           -- companies, projects, clusters, units, customers, assignments, payments
  entity_id   UUID        NOT NULL,
  op          CHAR(1)     NOT NULL,           -- I, U, D
  row_version BIGINT      NOT NULL,           -- naik setiap baris berubah
  payload     JSONB,                          -- isi baris setelah berubah (kolom whitelist); NULL bila D
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- Trigger `AFTER INSERT OR UPDATE OR DELETE` dipasang di setiap tabel yang dicerminkan. Trigger berjalan di dalam transaksi yang sama dengan perubahan bisnisnya. Jadi kalau perubahan tersimpan, event-nya pasti tersimpan, dan kalau transaksi batal, event-nya ikut batal. Cara ini menutup T1–T4 tanpa harus mengubah semua jalur raw SQL di Track.
- `payload` hanya berisi kolom whitelist. Kolom rahasia (`password_hash`, `apple_refresh_token`, token) tidak pernah masuk.
- Hapus menghasilkan event `D` (tombstone), jadi SI tahu barisnya hilang.
- `row_version` disimpan di kolom baru `sync_version BIGINT` pada tiap tabel dan dinaikkan oleh trigger yang sama.
- Retensi: event lebih tua dari 30 hari dan sudah melewati cursor SI boleh dihapus.

Catatan `seq` dan transaksi paralel: `BIGSERIAL` bisa ter-commit tidak berurutan (seq 101 commit sebelum 100). Karena itu API hanya mengembalikan event dengan `created_at < now() - 5 detik`, dan worker menyimpan cursor `seq` terakhir yang **berurutan tanpa lubang**. Lubang yang tidak terisi setelah 10 menit dicatat (bisa berasal dari transaksi yang di-rollback) lalu dilewati.

### 5.2 API Track: `GET /sync/v1/events`

```
GET /sync/v1/events?after_seq=12345&limit=500
Authorization: Bearer <token baca-saja>

200 {
  "events": [ { "seq": 12346, "entity": "payments", "entity_id": "…", "op": "U",
                "row_version": 7, "payload": { … } } ],
  "next_after_seq": 12845,
  "has_more": true,
  "server_time": "2026-10-03T08:00:00Z"
}
```

Ditambah endpoint snapshot untuk muat awal dan perbaikan:

```
GET /sync/v1/snapshot/{entity}?page_after_id=…&limit=500
```

Snapshot mengembalikan baris lengkap beserta `row_version` dan `max_seq` pada saat snapshot diambil.

### 5.3 Di SI: worker menerapkan event

Satu putaran worker:

1. Ambil kunci proses (`pg_advisory_lock`) supaya putaran tidak jalan ganda.
2. Baca `cursor_seq` dari tabel `sync_cursor`.
3. Ambil event per halaman. Untuk setiap event, di **satu transaksi DB SI**:
   - Validasi ulang tipe, wajib isi, dan relasi (induk ada di cermin).
   - Upsert ke `trk_<entity>` dengan kunci `track_id`, **hanya jika** `row_version` event > `row_version` tersimpan. Event lama atau duplikat diabaikan, dan itulah yang membuatnya idempoten.
   - `op = D`: set `is_deleted = true`. Baris tidak dihapus.
   - Simpan `raw`, `synced_at`, `track_seq`.
   - Panggil hook domain (misalnya pembayaran baru masuk antrean jurnal, Alur 2).
   - Majukan `cursor_seq`.
4. Event yang gagal validasi masuk `sync_error` (seq, entity, alasan) dan diulang di putaran berikut. Bila relasi induknya belum ada (urutan terbalik), event ditahan sampai induknya tiba.
5. Catat ringkasan ke `sync_log`.

Karena cursor dan perubahan cermin di-commit bersama, worker yang mati di tengah jalan aman: putaran berikut melanjutkan dari event terakhir yang benar-benar diterapkan.

### 5.4 Muat awal

1. Catat `max_seq` Track.
2. Tarik snapshot per entitas sesuai urutan relasi: companies, projects, clusters, units, customers, assignments, payments.
3. Set `cursor_seq = max_seq` dari langkah 1, lalu jalankan event normal. Event yang tumpang tindih dengan snapshot aman karena ada pemeriksaan `row_version`.

---

## 6. Jalur SI ke Track: outbox kirim

Dipakai untuk data milik SI yang perlu tampil di Track: jadwal angsuran dan status kunci pembayaran.

### 6.1 Tabel `outbox_track` di SI

| Kolom | Isi |
|---|---|
| `id` | BIGINT, juga dipakai sebagai idempotency key |
| `jenis` | `jadwal_angsuran`, `kunci_pembayaran` |
| `ref_id` | id baris SI |
| `payload` | JSON yang dikirim |
| `status` | Tertunda, Terkirim, Gagal |
| `percobaan`, `galat_terakhir`, `dikirim_pada` | |

Baris outbox ditulis **dalam transaksi yang sama** dengan perubahan bisnis di SI (misalnya SPPR final membentuk jadwal dan baris outbox sekaligus). Tidak ada perubahan SI yang lupa terkirim.

### 6.2 API Track

```
PUT /sync/v1/schedules/{si_jadwal_id}      Idempotency-Key: <outbox.id>
PUT /sync/v1/payment-locks/{track_payment_id}
```

- `PUT` dengan id dari SI: dikirim berulang hasilnya sama.
- Track menyimpan versi dari SI. Kiriman dengan versi lebih lama ditolak (`409`), dan SI menganggapnya sudah diterapkan.
- Jadwal yang diganti adendum dikirim sebagai `aktif = false`, tidak dihapus.

### 6.3 Kunci pembayaran

Setelah pembayaran dijurnal, SI mengirim `kunci_pembayaran`. Track lalu menolak edit dan hapus atas pembayaran itu dengan pesan "Sudah dibukukan Keuangan, ajukan koreksi ke Keuangan". Sumber "Perlu ditinjau" tertutup dari sisi Track. Untuk jeda singkat sebelum kunci terkirim, Alur 2 tetap menandai Perlu ditinjau.

### 6.4 Perlindungan di DB SI

- Role `si_worker`: satu-satunya yang boleh `INSERT/UPDATE` tabel `trk_*`.
- Role `si_app` (API SI): hanya `SELECT` pada `trk_*`, kecuali kolom milik SI (`trk_payments.jurnal_id`, `status_proses`). Lebih rapi lagi kalau kolom itu dipindah ke tabel 1:1 `status_pembayaran_si`, dan rancangan ini menyarankan itu.

---

## 7. Rekonsiliasi: bukti kedua sisi sama

Outbox mencegah kehilangan data. Rekonsiliasi membuktikan tidak ada yang hilang.

### 7.1 Rekonsiliasi data cermin (harian, 02:00)

Track menyediakan `GET /sync/v1/checksum/{entity}?company_id=…` yang mengembalikan per PT:

```
{ "count": 412, "sum_version": 98123, "hash": "md5 dari string_agg(id||':'||sync_version ORDER BY id)" }
```

Hal yang sama dihitung SI atas `trk_*` (yang tidak `is_deleted`). Kalau hasilnya beda:
1. Bagi per rentang id (bucket), lalu cari bucket yang berbeda.
2. Tarik snapshot bucket itu dan terapkan dengan aturan `row_version` yang sama.
3. Catat di `sync_log` dengan arah `Rekonsiliasi`, lalu beri peringatan ke Admin SI kalau selisihnya > 0.

Untuk pembayaran ada tambahan: total nominal per assignment di Track harus sama dengan total di `trk_payments`.

### 7.2 Rekonsiliasi keuangan (sebelum tutup buku, Alur 6)

- Total pembayaran `trk_payments` terverifikasi per PT per bulan = total jurnal sumber PR Track per PT per bulan.
- Jumlah pembayaran berstatus Menunggu, Gagal validasi, dan Perlu ditinjau = 0.
- Usulan dari ERD: cocokkan rekening koran dengan jurnal PR Track per rekening.
- Periode baru bisa dikunci kalau semua selisih nol.

### 7.3 Rekonsiliasi kiriman ke Track

`GET /sync/v1/schedules?updated_after_seq=…` mengembalikan versi jadwal yang tersimpan di Track. SI membandingkannya dengan `jadwal_angsuran` aktif, dan yang berbeda dikirim ulang.

### 7.4 Pemantauan

| Metrik | Ambang peringatan |
|---|---|
| Jeda cermin (now − waktu event terakhir diterapkan) | > 15 menit |
| `sync_error` terbuka | > 0 selama 1 jam |
| `outbox_track` Gagal | percobaan ≥ 5 |
| Selisih rekonsiliasi | > 0 |

---

## 8. Input uang: tahapan

Aturan "satu sumber kebenaran" tetap berlaku: setiap angka diinput di satu tempat saja.

**Fase 1 (sekarang):** pembayaran diinput dan diverifikasi admin di Track, sesuai ERD. SI hanya membaca, memvalidasi ulang, dan menjurnal. Begitu dijurnal, pembayaran dikunci di Track (6.3).

**Fase 2 (setelah SI stabil):** input dan verifikasi pembayaran pindah ke SI. Track hanya menampilkan riwayat pembayaran dari kiriman SI (outbox kirim). Arah koneksi tetap SI ke Track, hanya jenis kirimannya yang bertambah. Form input pembayaran di Track dimatikan, jadi tidak ada lagi input ganda.

Perpindahan fase dilakukan per PT pada awal periode dan dicatat di konfigurasi `sumber_pembayaran` per PT. Ini supaya tidak ada bulan yang setengah datanya diinput di Track dan setengahnya di SI.

---

## 9. Perlu diputuskan sebelum dibangun

9.1 **Harga dan DP.** Saat ini `harga_total` dan `dp` milik Track dan bisa berubah (lihat T5, refund mengubah harga). Usulan: SI membekukan harga di `dokumen` SPPR saat final. Setelah itu, perubahan harga di Track menjadi Perlu ditinjau dan wajib adendum. Fase 2: harga diinput di SI.

9.2 **Baris auto-inject KPR (T6).** Usulan: baris `is_auto_inject` tidak dijurnal sebagai kas. Pencairan KPR dijurnal saat bank benar-benar mencairkan, berdasarkan input Keuangan di SI atau pembayaran berjenis Pencairan KPR yang sudah diverifikasi.

9.3 **Cluster.** Apakah `trk_projects` = project Track, dengan cluster sebagai tabel cermin baru `trk_clusters`? Usulan: ya, tambah `trk_clusters` (tabel ke-31) supaya hirarki sama dengan Track.

9.4 **Data untuk SPPR yang tidak ada di Track:** data direktur PT, batas kavling, tempat/tanggal lahir, pekerjaan, KTP pembeli. Pilihannya: (a) Track menambah kolom tersebut, atau (b) SI menyimpannya di tabel 1:1 milik SI. Usulan: (b) untuk data yang hanya dipakai Keuangan (direktur, batas kavling), dan (a) untuk identitas pembeli, karena pembeli dikelola di Track.

9.5 **Role SI.** ERD mencantumkan Admin dan Keuangan. Keputusan 01/10 mencantumkan 4 role (Keuangan, Teknisi, Marketing, Kontraktor). Mana yang berlaku?

9.6 **Pekerjaan di sisi Track:** `sync_outbox` + trigger, kolom `sync_version`, kolom T7, API `/sync/v1/*`, token, IP allowlist, dan kunci pembayaran. Perlu ditentukan siapa yang mengerjakan dan jadwalnya. SI baru bisa diuji ujung ke ujung setelah ini ada. Sebelum itu, SI dikembangkan memakai server tiruan (mock) API Track dengan kontrak yang sama.

---

## 10. Dampak ke tabel ERD

| Perubahan | Alasan |
|---|---|
| `track_id` → `UUID` | T9 |
| Semua `trk_*`: tambah `row_version BIGINT`, `track_seq BIGINT` | Penerapan berversi (5.3) |
| Tabel baru `sync_cursor` (entitas global, `cursor_seq`) | Menggantikan cursor `updated_since` di `sync_log` |
| Tabel baru `sync_error` | Event gagal yang menunggu diulang |
| Tabel baru `outbox_track` | Menggantikan `status_kirim` di `jadwal_angsuran`, dan bisa dipakai untuk jenis kiriman lain |
| Tabel baru `trk_clusters` (bila 9.3 disetujui) | T10 |
| `trk_payments.jurnal_id`, `status_proses` dipindah ke `status_pembayaran_si` (1:1) | Cermin murni hanya ditulis worker (6.4) |
| `sync_log.arah`: tambah `Rekonsiliasi` | 7.1 |

---

## 11. Urutan kerja backend SI

1. Bersihkan sisa opsi A (setup SQL 001–003, modul `track` yang membaca DB Track, guard schema `public`).
2. Skema DB SI sesuai ERD + bagian 10, dengan migrasi Drizzle.
3. Kontrak API Track `/sync/v1` (OpenAPI) + server tiruan untuk pengembangan dan test.
4. Worker tarik: event, snapshot, cursor, idempoten, dan test urutan acak/duplikat/hapus.
5. Service jurnal (Alur 4) + Alur 2.
6. Outbox kirim + jadwal angsuran + kunci pembayaran.
7. Rekonsiliasi + metrik + peringatan.
8. Modul penjualan/legal, hutang, dan tutup buku.
