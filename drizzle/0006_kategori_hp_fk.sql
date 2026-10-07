CREATE TABLE "finance"."kategori_hutang_piutang" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kode" varchar(20) NOT NULL,
	"nama" varchar(100) NOT NULL,
	"prefix_kode_pembantu" varchar(4) NOT NULL,
	"aktif" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kategori_hutang_piutang_kode_unique" UNIQUE("kode"),
	CONSTRAINT "kategori_hutang_piutang_prefix_kode_pembantu_unique" UNIQUE("prefix_kode_pembantu")
);
--> statement-breakpoint
-- Kategori yang sebelumnya konstanta aplikasi. "pembeli" = kategori Penjualan
-- (piutang penjualan dan kode pembantu pembeli).
INSERT INTO "finance"."kategori_hutang_piutang" ("kode", "nama", "prefix_kode_pembantu") VALUES
	('lahan', 'Lahan', 'LH'),
	('bank', 'Bank', 'BK'),
	('antar_proyek', 'Antar proyek', 'AP'),
	('ppn', 'PPN', 'PJ'),
	('pihak_ketiga', 'Pihak ketiga', 'PK'),
	('pemegang_saham', 'Pemegang saham', 'PS'),
	('karyawan', 'Karyawan', 'KR'),
	('kontraktor', 'Kontraktor', 'KT'),
	('lain_lain', 'Lain-lain', 'LL'),
	('pembeli', 'Penjualan', 'PB');--> statement-breakpoint
ALTER TABLE "finance"."akun" ADD COLUMN "kategori_hp_id" uuid;--> statement-breakpoint
UPDATE "finance"."akun" a SET "kategori_hp_id" = k."id"
FROM "finance"."kategori_hutang_piutang" k
WHERE k."kode" = a."kategori_hutang_piutang";--> statement-breakpoint
-- Nilai teks yang tidak dikenal menggagalkan migrasi, bukan hilang diam-diam
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "finance"."akun" WHERE "kategori_hutang_piutang" IS NOT NULL AND "kategori_hp_id" IS NULL) THEN
		RAISE EXCEPTION 'akun.kategori_hutang_piutang berisi nilai yang tidak ada di kategori_hutang_piutang';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "finance"."akun" ADD CONSTRAINT "akun_kategori_hp_id_kategori_hutang_piutang_id_fk" FOREIGN KEY ("kategori_hp_id") REFERENCES "finance"."kategori_hutang_piutang"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."kode_pembantu" ADD CONSTRAINT "kode_pembantu_kategori_kategori_hutang_piutang_kode_fk" FOREIGN KEY ("kategori") REFERENCES "finance"."kategori_hutang_piutang"("kode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "akun_kategori_hp_idx" ON "finance"."akun" USING btree ("kategori_hp_id");