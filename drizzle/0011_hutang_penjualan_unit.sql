-- Hutang kategori "Penjualan unit": uang yang sudah diterima dari pembeli
-- sebelum BAST adalah kewajiban (hutang), bukan pendapatan. Setelah BAST,
-- saldonya dipindah ke penjualan dan sisa harga menjadi piutang.
INSERT INTO "finance"."kategori_hutang_piutang" ("kode", "nama", "prefix_kode_pembantu")
VALUES ('penjualan_unit', 'Penjualan unit', 'PU')
ON CONFLICT DO NOTHING;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "finance"."kategori_hutang_piutang" WHERE "kode" = 'penjualan_unit') THEN
		RAISE EXCEPTION 'Prefix kode pembantu PU sudah dipakai kategori lain; kategori penjualan_unit tidak bisa dibuat';
	END IF;
END $$;--> statement-breakpoint
-- 400210 PEMASUKAN UANG MUKA USER (pendapatan, laba rugi) direklasifikasi di
-- tempat menjadi 212007 (hutang, neraca) di bawah HUTANG JANGKA PENDEK. Baris
-- jurnal lama ikut pindah karena id akun tetap; pemetaan Akun Sistem juga tetap.
-- Dilewati bila 400210 tidak ada atau 212007 sudah dibuat manual.
UPDATE "finance"."akun" a SET
	"kode" = '212007',
	"induk_id" = (SELECT p."id" FROM "finance"."akun" p WHERE p."kode" = '210000'),
	"kategori" = 'hutang',
	"tipe_saldo" = 'k',
	"klasifikasi" = 'neraca',
	"kategori_hp_id" = (SELECT k."id" FROM "finance"."kategori_hutang_piutang" k WHERE k."kode" = 'penjualan_unit'),
	"wajib_kode_pembantu" = true,
	"wajib_proyek" = true,
	"updated_at" = now()
WHERE a."kode" = '400210'
	AND NOT EXISTS (SELECT 1 FROM "finance"."akun" x WHERE x."kode" = '212007')
	AND NOT EXISTS (SELECT 1 FROM "finance"."akun" c WHERE c."induk_id" = a."id");
