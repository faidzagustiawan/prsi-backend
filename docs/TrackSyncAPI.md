# Kontrak API Sinkronisasi PR Track (`/sync/v1`)

Untuk developer PR Track. API ini dipanggil **hanya oleh worker SI Podorukun**. Track tidak memanggil SI dan tidak menyimpan alamat atau kredensial SI. Latar belakangnya ada di [RancanganSistem.md](RancanganSistem.md) bagian 5–7.

Implementasi rujukan yang lolos uji ada di `scripts/mock-track.js` (server tiruan). Bila respons Track asli sama dengan tiruan, worker SI berjalan tanpa perubahan.

## 0. Fase pilot: PR Track ke SI saja

Untuk pengujian awal, arah sinkronisasi **hanya PR Track → SI**. Data yang sudah ada di SI tidak boleh dikirim kembali ke PR Track selama fase ini.

### Endpoint yang boleh dipanggil SI

- `GET /sync/v1/events`
- `GET /sync/v1/snapshot/{entity}`
- `GET /sync/v1/checksum/{entity}`

Ketiga endpoint tersebut dipakai untuk membaca data Track secara langsung, memuat cermin SI yang masih kosong, lalu memeriksa kecocokan datanya.

### Endpoint yang harus ditahan

- `PUT /sync/v1/schedules/{si_jadwal_id}`
- `PUT /sync/v1/payment-locks/{track_payment_id}`

SI **tidak mengirim** jadwal, kunci pembayaran, atau data bisnis lain ke Track pada fase pilot. Set `SYNC_WRITE_ENABLED=false`; `TRACK_SCHEDULE_TOKEN` boleh dikosongkan. Worker akan menahan antrean `outbox_track` dan tidak menjalankan request `PUT`.

### Urutan uji yang disarankan

1. Isi `TRACK_API_URL` dan `TRACK_SYNC_TOKEN` di environment SI. Pastikan URL memakai HTTPS.
2. Jalankan satu putaran pull dengan `SYNC_ENABLED=true`. Worker mengambil snapshot bila cermin SI kosong, lalu melanjutkan event dari cursor.
3. Periksa log sinkronisasi, `sync_cursor`, tabel cermin `trk_*`, dan `GET /api/v1/sinkron/error` di SI.
4. Jalankan `POST /api/v1/sinkron/rekonsiliasi` untuk membandingkan checksum Track dengan cermin SI.
5. Ubah satu data di Track, jalankan satu putaran pull lagi, dan pastikan perubahan masuk ke SI.
6. Pastikan tidak ada request `PUT` ke Track dan tidak ada perubahan pada data Track sebelum fase tulis disetujui.

Jika pull gagal, matikan worker dengan `SYNC_ENABLED=false`. Cursor dan event yang sudah diterapkan tetap aman karena penerapan event dan kemajuan cursor dilakukan dalam satu transaksi.

## 1. Keamanan

| Aturan | Rincian |
| --- | --- |
| Transport | HTTPS saja. |
| Asal | Hanya menerima koneksi dari IP server SI (allowlist di firewall/nginx). |
| Token baca | `Authorization: Bearer <TRACK_SYNC_TOKEN>`. Hanya untuk semua `GET /sync/v1/*`. |
| Token jadwal | Tidak diperlukan pada fase pilot. Saat fase tulis diaktifkan, `Authorization: Bearer <TRACK_SCHEDULE_TOKEN>` hanya untuk `PUT /sync/v1/schedules/*` dan `PUT /sync/v1/payment-locks/*`. |
| Token | Acak minimal 32 byte, disimpan di secret server, bisa dirotasi. Token salah: `401`. |
| Kolom rahasia | Tidak pernah dikirim: `password_hash`, `apple_refresh_token`, token apa pun. |

## 2. Perubahan di database Track

### 2.1 Kolom versi

Setiap tabel yang dicerminkan mendapat `sync_version BIGINT NOT NULL DEFAULT 0`, dinaikkan trigger setiap baris berubah. Tabelnya: `companies`, `projects`, `clusters`, `units`, `users` (role customer), `property_assignments`, `payment_history`.

### 2.2 Kolom tambahan `payment_history`

Diperlukan untuk Alur 2 (validasi dan penentuan akun di SI):

```sql
ALTER TABLE payment_history
  ADD COLUMN jenis              varchar(20),   -- booking_fee | uang_muka | angsuran | pencairan_kpr
  ADD COLUMN status_verifikasi  varchar(20) NOT NULL DEFAULT 'menunggu', -- menunggu | terverifikasi | ditolak
  ADD COLUMN rekening_tujuan    varchar(30),   -- nomor rekening perusahaan penerima transfer
  ADD COLUMN diverifikasi_oleh  varchar(150),
  ADD COLUMN diverifikasi_pada  timestamptz,
  ADD COLUMN dikunci_si         boolean NOT NULL DEFAULT false;  -- diisi lewat /payment-locks
```

SI hanya menjurnal pembayaran berstatus `terverifikasi`. `rekening_tujuan` dicocokkan dengan nomor rekening akun kas/bank di SI; hanya angkanya yang dibandingkan.

### 2.3 Tabel `sync_outbox` dan trigger

```sql
CREATE TABLE sync_outbox (
  seq         BIGSERIAL PRIMARY KEY,
  entity      varchar(30) NOT NULL,   -- companies, projects, clusters, units, customers, assignments, payments
  entity_id   uuid        NOT NULL,
  op          char(1)     NOT NULL,   -- I, U, D
  row_version bigint      NOT NULL,
  payload     jsonb,                  -- NULL bila D
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

Satu trigger `AFTER INSERT OR UPDATE OR DELETE` per tabel:
- Untuk `I`/`U`, trigger menaikkan `sync_version` lebih dulu: kolom diisi di trigger `BEFORE UPDATE`, atau `sync_version + 1` dihitung di trigger yang sama.
- Trigger lalu menulis satu baris `sync_outbox` dengan payload berisi **kolom whitelist di bagian 4 saja**.
- Untuk `users`, hanya baris `role = 'customer'` yang ditulis, dengan entity `customers`.

Karena trigger berjalan dalam transaksi yang sama dengan perubahan bisnisnya, event tidak pernah hilang, termasuk perubahan lewat raw SQL dan `DELETE`. Event lebih tua dari 30 hari boleh dihapus.

## 3. Endpoint

Semua respons JSON. Galat: `{ "message": "..." }` dengan status HTTP yang sesuai.

### `GET /sync/v1/events?after_seq=<n>&limit=<n>`

Event dengan `seq > after_seq`, urut naik, maksimal `limit` (SI memakai 500, maksimal 1000). **Hanya event yang `created_at`-nya lebih tua dari 5 detik**, supaya transaksi yang belum commit tidak membuat SI melompati seq.

```json
{
  "events": [
    { "seq": 1201, "entity": "payments", "entity_id": "uuid", "op": "U", "row_version": 7,
      "payload": { "...": "kolom bagian 4" }, "created_at": "2026-10-03T08:00:00Z" }
  ],
  "next_after_seq": 1201,
  "has_more": false,
  "server_time": "2026-10-03T08:00:05Z"
}
```

`next_after_seq` = seq event terakhir di halaman, atau `after_seq` bila kosong. Lubang seq (transaksi rollback) tidak perlu ditangani Track; SI menunggu 10 menit lalu melewatinya.

> **v1 tidak lossless.** Pilot 5 Oktober 2026 mereproduksi dua kasus kehilangan event:
> 1. Transaksi yang lebih lama dari batas tunggu lubang commit di belakang cursor.
> 2. INSERT di belakang halaman snapshot.
>
> Kontrak baru memakai v2 (bagian 3.1). v1 hanya dipertahankan untuk peralihan.

### 3.1 Kontrak v2: cursor urutan commit (`SYNC_PROTOCOL=v2`)

**Perubahan database Track (aditif, kompatibel dengan v1):**

```sql
ALTER TABLE sync_outbox ADD COLUMN txid xid8;                 -- txid transaksi penulis
UPDATE sync_outbox SET txid = '0' WHERE txid IS NULL;         -- event pra-v2 diurutkan paling awal
ALTER TABLE sync_outbox ALTER COLUMN txid SET DEFAULT pg_current_xact_id();
ALTER TABLE sync_outbox ALTER COLUMN txid SET NOT NULL;
CREATE INDEX sync_outbox_txid_seq_idx ON sync_outbox (txid, seq);
```

Trigger tidak berubah, karena `txid` terisi otomatis dari default kolom. Implementasi rujukan ada di `staging/sync.sql` repo Track.

#### `GET /sync/v2/events?after=<txid>:<seq>&limit=<n>`

Event diurutkan menurut `(txid, seq)`. Track hanya mengirim event dengan `txid < pg_snapshot_xmin(pg_current_snapshot())`, dibaca dalam satu transaksi `REPEATABLE READ READ ONLY`.

Semua txid di bawah xmin milik transaksi yang sudah selesai, dan setiap transaksi yang masih berjalan pasti memperoleh txid ≥ xmin. Akibatnya:
- commit yang terlambat selalu jatuh **di depan** cursor, tidak pernah di belakangnya;
- tidak ada lubang yang perlu ditunggu atau dilewati, dan filter 5 detik tidak lagi diperlukan;
- event satu baris bisa tiba tidak berurutan antartransaksi, tetapi SI menyaringnya dengan `row_version`.

```json
{
  "events": [ { "seq": 1201, "entity": "payments", "entity_id": "uuid", "op": "U", "row_version": 7,
                "payload": { "...": "..." }, "created_at": "…", "cursor": "88123:1201" } ],
  "next_after": "88123:1201",
  "has_more": false,
  "held_by_open_transaction": false,
  "watermark": "88124",
  "server_time": "…"
}
```

- `held_by_open_transaction: true` berarti ada event yang sudah commit tetapi tertahan oleh transaksi Track yang lebih tua dan belum selesai. Event itu datang di putaran berikutnya.
- SI mencatat lamanya tertahan di `sync_cursor.gap_since` dan memberi peringatan setelah `SYNC_HELD_WARN_SEC`.
- Track sebaiknya memasang `idle_in_transaction_session_timeout` supaya transaksi yang menggantung tidak menahan sinkronisasi.

#### `GET /sync/v2/start`

Mengembalikan `{ "after": "<xmin>:0" }`. Saat muat awal, SI mengambil cursor ini **sebelum** halaman snapshot pertama, lalu memutar ulang semua event setelahnya. Perubahan selama paginasi, termasuk INSERT dengan UUID di belakang halaman, tetap masuk lewat event.

`/sync/v2/snapshot/{entity}` dan `/sync/v2/checksum/{entity}` sama persis dengan v1.

#### Peralihan v1 ke v2

Saat `sync_cursor.cursor_txid` masih NULL, SI memulai dari `0:<cursor_seq>`. Event pra-v2 ber-txid 0 sehingga tidak dikirim ulang, sementara semua event v2 dikirim. Event yang dulu terlewat oleh v1 ikut terkirim; event yang sudah diterapkan diabaikan lewat `row_version`.

#### Retensi

`sync_prune_outbox(interval '30 days')` dijalankan oleh role pemilik dari job terjadwal Track, dengan batas bawah 7 hari.

### `GET /sync/v1/snapshot/{entity}?page_after_id=<uuid>&limit=<n>`

Semua baris yang belum dihapus, urut `id::text COLLATE "C"`, mulai setelah `page_after_id`. Setiap baris = kolom bagian 4 + `id` + `row_version`.

```json
{ "rows": [ { "id": "uuid", "row_version": 3, "...": "..." } ], "has_more": true, "max_seq": 1201 }
```

`max_seq` = seq tertinggi di `sync_outbox` saat halaman diambil. Dipakai SI untuk muat awal dan perbaikan rekonsiliasi.

### `GET /sync/v1/checksum/{entity}`

```sql
SELECT COUNT(*)::int AS count,
       COALESCE(md5(string_agg(id::text || ':' || sync_version::text, ',' ORDER BY id::text COLLATE "C")), md5('')) AS hash
FROM <tabel> WHERE <baris belum dihapus>;
```

`COLLATE "C"` wajib. Tanpanya, urutan mengikuti collation database (en_US mengabaikan `-` di UUID), dan hash akan beda dengan SI.

```json
{ "count": 412, "hash": "3f2a…" }
```

### `PUT /sync/v1/schedules/{si_jadwal_id}`

Jadwal angsuran buatan SI untuk ditampilkan ke pembeli. Header `Idempotency-Key: <uuid>`.

```json
{ "siJadwalId": "uuid", "trackAssignmentId": "uuid", "noUrut": 1, "tanggal": "2026-10-31",
  "jumlah": 30000000, "keterangan": "DP 1", "aktif": true, "versi": 1790000000000 }
```

- Simpan per `si_jadwal_id` (upsert). Kiriman dengan `versi` lebih kecil dari yang tersimpan: `409`.
- `aktif: false` = jadwal diganti adendum atau penjualan batal. Sembunyikan dari pembeli, jangan dihapus.
- Hanya `versi` dan `aktif` yang wajib pada kiriman nonaktif.
- Respons: `{ "data": { "track_id": "<id jadwal di Track>" } }`.
- Kiriman ulang dengan kunci yang sama menghasilkan hal yang sama.

### `PUT /sync/v1/payment-locks/{track_payment_id}`

Pembayaran sudah dibukukan Keuangan.

```json
{ "trackPaymentId": "uuid", "jurnal": "JT-202610-0001", "terkunci": true, "versi": 1790000000000 }
```

Set `payment_history.dikunci_si = true`. Setelah itu Track **menolak edit dan hapus** pembayaran itu dengan pesan "Sudah dibukukan Keuangan, ajukan koreksi ke Keuangan". Ini juga berlaku untuk hapus massal saat tipe pembayaran diganti. Pembayaran tidak ditemukan: `404`.

## 4. Kolom payload per entitas

| entity | tabel Track | kolom |
| --- | --- | --- |
| `companies` | companies | `nama_pt`, `kode_pt`, `alamat` |
| `projects` | projects | `company_id`, `nama_proyek`, `status`, `kode` (opsional) |
| `clusters` | clusters | `project_id`, `nama_cluster` |
| `units` | units | `cluster_id`, `nomor_unit`, `tipe_rumah`, `luas_tanah`, `luas_bangunan`, `status_pembangunan` |
| `customers` | users (role customer) | `nama`, `email`, `nomor_telepon`; opsional: `tempat_lahir`, `tanggal_lahir`, `pekerjaan`, `alamat`, `no_ktp` |
| `assignments` | property_assignments | `user_id`, `unit_id`, `tipe_pembayaran` (`cash_lunas`/`cash_cicil`/`kredit_kpr`), `harga_total`, `dp`, `status_kepemilikan`, `tanggal_pembelian` |
| `payments` | payment_history | `assignment_id`, `jumlah_bayar`, `tanggal_bayar`, `catatan`, `bukti_pembayaran` (URL atau array URL), `is_auto_inject`, `created_at`, `jenis`, `status_verifikasi`, `rekening_tujuan`, `diverifikasi_oleh`, `diverifikasi_pada` |

Nominal dikirim sebagai string desimal (`"1500000.00"`) atau number. Tanggal `YYYY-MM-DD`, timestamp ISO 8601. FK dikirim sebagai UUID Track; SI menerjemahkannya sendiri.

SI memvalidasi ulang setiap payload. Payload yang tidak lolos dicatat di sisi SI dan tidak menghentikan sinkronisasi; baris itu menunggu versi Track berikutnya yang benar.

## 5. Uji kecocokan

1. Jalankan worker SI dengan `TRACK_API_URL` mengarah ke Track staging.
2. `POST /api/v1/sinkron/rekonsiliasi` di SI: semua entitas harus `cocok: true` setelah muat awal.
3. Ubah, hapus, dan tambah data di Track staging, lalu jalankan `POST /api/v1/sinkron/jalankan`. Cermin SI harus ikut berubah, dan `GET /api/v1/sinkron/error` harus kosong.
