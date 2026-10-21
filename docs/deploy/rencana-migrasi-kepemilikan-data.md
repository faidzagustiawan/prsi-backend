# Rencana pengembangan dan migrasi kepemilikan data PRTrack ↔ PRSI

Status: rencana. Disusun 5 Oktober 2026.

> **Aturan utama.** PRTrack production **tidak boleh diubah** sampai hari cutover disetujui pemilik. Larangan ini mencakup kode, migrasi, trigger (termasuk `sync.sql`), dan konfigurasi. Semua pekerjaan dilakukan di branch dan lingkungan staging. Satu-satunya akses ke production sebelum cutover adalah **membaca**, yaitu `pg_dump` read-only untuk membuat salinan tersanitasi.

## 1. Tujuan

Setiap data hanya punya satu pemilik yang boleh melakukan CRUD. Sistem lain hanya melihat.

| Data | Pemilik (CRUD) | Sistem lain |
|---|---|---|
| Company, project, cluster, unit, progres, dokumentasi | PRTrack | PRSI hanya lihat |
| Akun customer (login, kontak) | PRTrack | PRSI hanya lihat |
| Penjualan: harga, DP, tipe bayar\* | PRSI | PRTrack hanya lihat |
| Pembayaran, verifikasi, rekening, pencairan KPR, jadwal angsuran | PRSI | PRTrack hanya lihat |
| Jurnal, piutang, SPPR/legal | PRSI | Tidak dikirim, atau ringkasan saja |
| Pengajuan bukti transfer dari customer\* | PRTrack (sebagai pengajuan) | PRSI memverifikasi dan membuat pembayaran sah |

\* Harus diputuskan di Fase 0.

Cutover dinyatakan berhasil bila:
- customer tidak merasakan gangguan: aplikasi tetap bisa dibuka, riwayat pembayaran tetap tampil, dan tidak perlu update aplikasi;
- data uang di kedua sistem identik (count, total nominal per penjualan, hash);
- seluruh tahap bisa dibalik dalam hitungan menit.

## 2. Prinsip tanpa gangguan customer

1. **Expand/contract.** Migrasi hari H hanya **menambah** (tabel, kolom, trigger, flag) dan tetap kompatibel dengan kode lama. Penghapusan struktur lama (contract) dilakukan paling cepat 2–4 minggu setelah stabil.
2. **API customer tidak berubah bentuk.** Respons endpoint yang dipakai aplikasi customer (riwayat pembayaran, total dibayar, jadwal) harus identik sebelum dan sesudah cutover. Cara memastikannya: snapshot JSON respons untuk sampel customer dibandingkan otomatis.
3. **UUID tetap.** Pembayaran dan penjualan yang dipindah ke PRSI memakai UUID yang sama dengan Track, sehingga referensi di aplikasi, notifikasi, dan dokumen tidak putus.
4. **Saklar mode, bukan big-bang kode.** Kode baru sudah terpasang dan diuji sebelum hari H, lalu diaktifkan lewat flag `FINANCE_OWNERSHIP_MODE=legacy|finance`. Rollback dilakukan dengan mengembalikan flag.
5. **Pembatasan di database, bukan hanya UI.** Di Track, tabel uang hanya bisa ditulis role sinkronisasi (trigger/grant). Di PRSI, tabel `trk_*` hanya bisa ditulis sesi worker.
6. **Jendela lalu lintas rendah.** Cutover dijalankan dini hari. Yang dibekukan hanya **input admin terkait uang**, selama beberapa menit; jalur baca customer tidak pernah mati.
7. **Titik balik instan.** Sesaat sebelum migrasi, buat branch/snapshot Neon dan backup Sumobase.

## 3. Lingkungan development dan staging

Semua lingkungan berikut terpisah dari production. VPS `43.173.11.71` tetap khusus backend dan tidak menjalankan frontend.

| Lingkungan | Isi | Catatan |
|---|---|---|
| Track staging data | PostgreSQL salinan tersanitasi, `127.0.0.1:55440` (sudah ada) | Disegarkan dari dump read-only terbaru sebelum setiap gladi |
| Track staging aplikasi | Backend bisnis Track dari branch fitur, port loopback terpisah | Belum ada: saat ini staging hanya menjalankan modul sync. Integrasi WA, push, mail, payment gateway, dan storage harus dimatikan atau di-stub |
| PRSI staging | Instance API dan worker PRSI dengan **DB terpisah**, bukan DB dummy yang dipakai API aktif | Port loopback terpisah. Worker boleh menjadi service **khusus staging** |
| Frontend Track/PRSI | Dikerjakan tim masing-masing | Di luar lingkup pemilik backend. Uji UI dilakukan tim frontend terhadap API staging |

Tim PRTrack bekerja di branch, misalnya `feature/finance-ownership`. Workflow deploy production Track hanya terpicu push ke `main`, jadi branch ini tidak boleh di-merge sebelum Fase 6.

## 4. Fase

### Fase 0. Keputusan dan kontrak (PRTrack + PRSI)

1. Matriks kepemilikan final, termasuk tiga butir bertanda \* di bagian 1.
2. Kontrak sinkronisasi v2 dua arah:
   - **Track ke PRSI:** master data, ditarik oleh PRSI seperti sekarang.
   - **PRSI ke Track:** penjualan, pembayaran, jadwal, `total_dibayar`.
   - Kedua arah memakai **publication sequence menurut urutan commit** dan **snapshot epoch**, untuk menutup risiko H1/H2 dari pilot 5 Oktober.
3. Kontrak respons API customer yang dibekukan (daftar endpoint dan contoh JSON).
4. Kebijakan kasus tepi:
   - customer keluar role padahal masih punya penjualan aktif;
   - assignment berubah atau dihapus setelah SPPR dibuat;
   - koreksi pembayaran yang sudah dijurnal.

Output fase ini: dokumen yang disetujui kedua tim.

### Fase 1. Implementasi di branch (tanpa production)

**PRTrack** (dikerjakan tim PRTrack; pemilik PRSI mereview kontraknya):
- Migrasi v2 bersifat additive: tabel uang menjadi cermin yang ditulis role sinkronisasi; tabel pengajuan bukti transfer; outbox dengan publication sequence; guard trigger yang menolak tulis non-sinkron pada mode `finance`.
- Endpoint penerima data PRSI (idempoten, berversi). Alternatifnya Track menarik dari PRSI; keputusan arah ada di kontrak v2.
- Flag mode. Pada mode `finance`, endpoint admin CRUD pembayaran/harga mengembalikan pesan "dikelola Keuangan".
- `total_dibayar` dan auto-inject KPR berasal dari PRSI, bukan trigger lokal.
- API customer tetap sama bentuknya.

**PRSI** (lingkup pemilik):
- Modul CRUD penjualan, pembayaran, dan verifikasi sebagai sumber sah.
- Outbox PRSI ke Track dengan publication sequence. Gate `SYNC_WRITE_ENABLED` tetap ada.
- Pull v2 memakai `publish_seq` dan `start_watermark`; logika gap/timeout dihapus.
- Alat impor sekali jalan: pembayaran dan penjualan dari Track ke PRSI dengan UUID sama, idempoten, plus laporan selisih.
- Guard trigger pada `trk_*`. Pemrosesan pembayaran incremental. Apply event per halaman.
- Deteksi perubahan assignment setelah dokumen dibuat (`perlu_ditinjau`).

### Fase 2. Uji di staging

| Kelompok | Kriteria lulus |
|---|---|
| Fungsional PRSI | CRUD uang, verifikasi, jurnal otomatis, koreksi, dan adendum berjalan |
| Pembatasan kepemilikan | Tulis langsung ke tabel uang Track (SQL mentah maupun API admin) **ditolak** pada mode `finance`; tulis ke `trk_*` dari luar worker ditolak |
| Sinkron dua arah | Skenario A–G pilot diulang untuk kedua arah, ditambah H1/H2 dengan transaksi terbuka. Selisih 0 setelah rekonsiliasi |
| Regresi API customer | Snapshot JSON sampel customer **identik** antara mode `legacy` dan `finance` |
| Impor | Count, total nominal per penjualan, dan hash cocok 100%. Impor kedua menghasilkan 0 perubahan |
| Kegagalan | Track/PRSI mati di tengah putaran, worker dibunuh, jaringan putus: data pulih tanpa duplikat |
| Beban | Backlog 10.000 event dan update massal selesai dalam batas waktu yang disepakati |
| Keamanan | Token dari secret file, tidak ada token di argumen atau log. Allowlist IP. HTTPS antarserver |
| Rollback | Mode `finance` → `legacy` mengembalikan kemampuan input Track tanpa kehilangan data |

### Fase 3. Uji penerimaan (UAT)

Admin Track dan tim Keuangan memakai staging selama minimal 1–2 minggu dengan skenario kerja nyata: input pembayaran di PRSI, cek tampilan di Track, koreksi, dan pengajuan bukti transfer. Hasilnya berupa daftar isu, dan fase ini selesai bila tidak ada isu kritis yang tersisa.

### Fase 4. Gladi resik cutover (minimal 2 kali)

Setiap gladi dijalankan pada **salinan tersanitasi terbaru** dari production (dump read-only) dan menjalankan runbook hari H persis langkah demi langkah:
- ukur durasi tiap langkah;
- latih rollback penuh minimal satu kali;
- perbarui runbook bila ada langkah yang meleset.

Fase ini lulus bila dua gladi berturut-turut berhasil tanpa langkah manual tak tertulis.

### Fase 5. Go/no-go (H-1)

Cutover hanya dijalankan bila semua syarat berikut terpenuhi:
- Fase 2 sampai 4 lulus dan ditandatangani PRTrack, PRSI, dan pemilik.
- Kode Track dan PRSI versi final sudah lulus gladi. Setelah itu kode dibekukan.
- Backup production siap: Neon branch/snapshot dan backup Sumobase. Prosedur restore sudah diuji di gladi.
- Jendela waktu disepakati, admin internal sudah diberi tahu, dan customer tidak perlu diberi tahu.
- Monitoring dan alert aktif: lag cursor, sync_error, selisih rekonsiliasi.

### Fase 6. Hari H, satu jendela (misalnya 01.00–03.00)

| Waktu | Langkah | Cek |
|---|---|---|
| T-30 | Buat Neon branch/snapshot dan backup Sumobase | File/branch terverifikasi |
| T-20 | Deploy kode Track dan PRSI versi final dengan mode **`legacy`** (perilaku sama seperti sekarang) | Health OK, snapshot API customer identik |
| T-10 | Terapkan migrasi additive Track (`lock_timeout` pendek, index `CONCURRENTLY`) | Tidak ada error lock, aplikasi customer normal |
| T0 | Bekukan **input uang oleh admin** Track | Customer tidak terdampak |
| T+5 | Impor pembayaran dan penjualan ke PRSI (UUID sama) | Count, nominal, dan hash 100% cocok |
| T+15 | Ubah flag ke **`finance`** di Track dan PRSI; aktifkan jalur PRSI ke Track | Guard menolak tulis langsung; checksum dua arah cocok |
| T+20 | Smoke test: snapshot API customer identik; input pembayaran uji oleh Keuangan untuk customer uji muncul di Track ≤ 2 menit, lalu dibatalkan lewat alur koreksi | Semua lulus |
| T+30 | **Go/no-go akhir**. Bila gagal: flag ke `legacy`, input admin Track dibuka lagi, data impor di PRSI dinonaktifkan | Keputusan dicatat |
| T+40 | Buka kembali operasional: admin Track hanya lihat untuk data uang, Keuangan input di PRSI | Monitoring berjalan |

Rollback tidak memerlukan restore database karena migrasi bersifat additive dan flag bisa dibalik. Restore Neon/Sumobase hanya untuk kondisi darurat.

### Fase 7. Hypercare dan contract

- Hari 1–14: rekonsiliasi harian, alert aktif, dan review harian bersama Keuangan dan PRTrack.
- Minggu ke 2–4: setelah stabil, hapus struktur lama (contract) melalui rilis terpisah yang juga lewat staging.

## 5. Tanggung jawab

| Pihak | Tugas |
|---|---|
| Pemilik (backend/DB/arsitektur PRSI) | Kontrak v2, backend PRSI, alat impor, staging PRSI, runbook dan rekonsiliasi |
| Tim PRTrack | Migrasi dan kode Track di branch, staging aplikasi Track, deploy Track hari H |
| Tim frontend masing-masing | UI "hanya lihat" di Track dan UI input di PRSI |
| Keuangan dan admin Track | UAT dan validasi angka hari H |

## 6. Langkah berikutnya yang bisa dikerjakan sekarang (tanpa menyentuh production)

1. Susun draf kontrak v2 dan matriks kepemilikan untuk dibahas dengan PRTrack.
2. Siapkan PRSI staging dengan DB terpisah dari DB dummy API aktif.
3. Mulai modul pembayaran PRSI sebagai sumber sah, serta alat impor (uji pada staging).
4. Rekam snapshot respons API customer dari staging Track sebagai baseline regresi. Ini membutuhkan aplikasi Track staging penuh dari tim PRTrack.

## 7. Pekerjaan berikutnya: pembayaran berdasarkan tagihan PRSI

Keputusan pemilik, 13 Oktober 2026. Status per 21 Oktober 2026: diimplementasikan
di backend dan FE web kedua sistem, teruji lokal; belum diuji di staging dan
belum aktif di produksi.

PRSI menentukan nominal dan tenggat pembayaran rumah. Pada input pembayaran
di PRTrack, pengguna memilih tagihan melalui dropdown; nominal berasal dari
tagihan tersebut dan tidak lagi diisi atau diubah manual. PRTrack tetap
mencatat tanggal pembayaran aktual dan bukti transfer. Pembayaran dikirim ke
PRSI beserta ID tagihan untuk diproses dan dibukukan pada tagihan yang dipilih.

Keputusan ini memperjelas rencana sebelumnya yang menyebut Track hanya melihat
data uang: Track tetap menyediakan pencatatan pembayaran berdasarkan pilihan
tagihan. Pengelolaan nominal dan tenggat tagihan berada di PRSI. Pemindahan
kepemilikan data uang secara menyeluruh pada fase cutover tetap pekerjaan
terpisah; pencatatan di Track perlu dibedakan dari pembayaran sah yang
diverifikasi dan dibukukan PRSI.

### Daftar pekerjaan

- [x] **Backend/DB PRSI:** `finance.jadwal_angsuran` menjadi sumber nominal,
  tenggat, urutan, dan status aktif tagihan. Keempat jenis tagihan
  (`booking_fee`, `uang_muka`, `angsuran`, `pencairan_kpr`) dapat dibuat lewat
  `PUT /piutang/{id}/tagihan`, dibatasi nilai SPPR, dan tagihan berpembayaran
  tidak dapat ditimpa. Migrasi `0009_billing_sync`.
- [x] **Kontrak sinkronisasi:** tagihan dikirim lewat `outbox_track` dengan ID
  tetap, assignment, nominal, tenggat, urutan, status aktif, versi, dan nilai
  kontrak. Adendum menonaktifkan jadwal lama tanpa memindahkan alokasi
  historis. Rekonsiliasi balik membaca `billing-snapshot`.
- [x] **Backend/DB PRTrack:** cermin `si_schedules`, kolom `si_jadwal_id` dan
  status SI pada `payment_history`, trigger `si_guard_payment`, dan capture
  yang menentukan nominal dari sisa tagihan. `GET /assignments/{id}/tagihan`
  mengirim `billing_enabled`. Diterapkan lewat
  `staging/generated/billing-v2-cutover.sql`; belum di produksi.
- [x] **Kontrak pembayaran Track → PRSI:** whitelist payload memuat
  `si_jadwal_id`, `request_id` idempoten, tanggal aktual, bukti, dan rekening.
  Fixture checksum bersama mengikuti whitelist baru.
- [x] **Alokasi PRSI:** pembayaran bertagihan dialokasikan ke `jadwal_id`
  pilihan, bukan FIFO. Verifikasi Keuangan (terima/tolak), jurnal balik, dan
  hasil dikirim kembali ke Track. Pembayaran lama tanpa tagihan tetap memakai
  jalur legacy.
- [x] **Handoff frontend (web):** SI: modal Tagihan pada Piutang (input nominal
  dan tenggat, plafon SPPR, status kunci) dan verifikasi pembayaran Track.
  PRTrack web: dropdown tagihan, nominal terkunci, bukti wajib sebelum kirim,
  status SI pada riwayat. Dikerjakan atas instruksi pemilik 21 Oktober 2026.
- [ ] **Aplikasi mobile PRTrack (Flutter):** belum diimplementasikan. Setelah
  `SI_BILLING_ENABLED` aktif, pencatatan tanpa tagihan ditolak.
- [x] **Uji otomatis lokal:** integrasi dua database 21/21 (tagihan ke-2
  sebelum ke-1, nominal manipulasi, tagihan asing/nonaktif/lunas, replay,
  adendum, reversal, plafon), regresi SI 20/20, unit Track 15/15.
- [ ] **Uji staging dan UAT:** skenario yang sama pada salinan tersanitasi
  PostgreSQL 16, UI di browser, dan UAT Keuangan termasuk data lama (lihat
  bawah).

### Dampak terhadap data sebelum PRSI

Ringkasan pemeriksaan kode 21 Oktober 2026. Rincian keputusan wajib masuk UAT
Keuangan dan gladi cutover.

- Migrasi Track bersifat aditif. Baris `payment_history` lama mendapat
  `si_jadwal_id` kosong dan `status_si` bawaan `menunggu`; API membaca baris
  tanpa tagihan sebagai `diterima`, sehingga tampilan customer tidak berubah.
- `total_dibayar` lama tidak berubah saat migrasi. Begitu SI mengirim nilai
  kontrak untuk penjualan KPR, auto-injeksi KPR lama tidak lagi dihitung, jadi
  total dibayar customer turun ke kas aktual.
- Constraint baru `total_dibayar <= coalesce(si_contract_total, harga_total)`
  lolos untuk data lama, tetapi kiriman nilai kontrak SI yang lebih kecil dari
  total lama akan ditolak Track dan tertahan di outbox.
- Setelah flag aktif, Track hanya menerima pembayaran bertagihan. Penjualan
  lama tanpa SPPR final di SI tidak bisa dibuatkan tagihan, sehingga tidak bisa
  mencatat pembayaran sampai SPPR dan tagihannya disiapkan.
- Saat sync SI berjalan, pembayaran lama yang terverifikasi di Track diproses
  jalur legacy: dijurnal otomatis pada tanggal aslinya bila rekening cocok,
  atau `gagal_validasi`/draft bila rekening/bukti/periode tidak memenuhi. Tidak
  ada batas tanggal; saldo awal yang sudah diinput manual dapat terhitung ganda.
  Opsi penanganannya ada di [opsi-cutoff-pembayaran-lama.md](opsi-cutoff-pembayaran-lama.md).
- Pembayaran lama yang dialokasikan tanpa jadwal (mis. booking fee) tidak
  dihitung dalam plafon tagihan SI; Keuangan perlu memperhitungkannya agar
  tidak menagih ulang.
- Pembayaran lama yang belum dijurnal SI masih dapat diubah/dihapus di Track.

Urutan pengerjaan: kontrak tagihan dan pembayaran → backend/DB kedua sistem →
uji sinkronisasi dan alokasi di staging → handoff UI ke tim frontend.
Pencatatan keputusan ini tidak mengaktifkan `SYNC_ENABLED` atau
`SYNC_WRITE_ENABLED`, dan tidak mengizinkan perubahan/deployment produksi.
