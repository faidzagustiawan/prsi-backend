CREATE TABLE "finance"."adendum_kontrak" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kontrak_id" uuid NOT NULL,
	"no_adendum" varchar(40) NOT NULL,
	"tanggal" date NOT NULL,
	"nilai_lama" numeric(18, 2) NOT NULL,
	"nilai_baru" numeric(18, 2) NOT NULL,
	"alasan" text NOT NULL,
	"jurnal_id" uuid,
	"dibuat_oleh" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."dokumen_legal_kavling" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"no_shm" varchar(40) NOT NULL,
	"status_shm" varchar(20) NOT NULL,
	"status_shm_kustom" varchar(60),
	"lokasi" varchar(100) NOT NULL,
	"pinjaman_id" uuid,
	"no_pbg" varchar(40),
	"status_pbg" varchar(20) DEFAULT 'belum_diajukan' NOT NULL,
	"status_pbg_kustom" varchar(60),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dokumen_legal_kavling_unit_id_unique" UNIQUE("unit_id"),
	CONSTRAINT "dokumen_legal_kavling_no_shm_unique" UNIQUE("no_shm")
);
--> statement-breakpoint
CREATE TABLE "finance"."kontrak_kontraktor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"no_spk" varchar(40) NOT NULL,
	"proyek_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"tipe" varchar(50),
	"tanggal_spk" date NOT NULL,
	"kode_pembantu_id" uuid NOT NULL,
	"nilai_rab" numeric(18, 2) NOT NULL,
	"nilai_kontrak" numeric(18, 2) NOT NULL,
	"keterangan" text,
	"akun_persediaan_id" uuid NOT NULL,
	"akun_hutang_id" uuid NOT NULL,
	"status" varchar(10) DEFAULT 'aktif' NOT NULL,
	"jurnal_id" uuid,
	"jurnal_batal_id" uuid,
	"dibatalkan_pada" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kontrak_kontraktor_no_spk_unique" UNIQUE("no_spk")
);
--> statement-breakpoint
CREATE TABLE "finance"."pembayaran_kontrak" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kontrak_id" uuid NOT NULL,
	"tanggal" date NOT NULL,
	"nominal" numeric(18, 2) NOT NULL,
	"akun_kas_id" uuid NOT NULL,
	"no_bukti" varchar(60),
	"keterangan" text,
	"jurnal_id" uuid,
	"dibuat_oleh" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."pinjaman" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proyek_id" uuid NOT NULL,
	"kode_pembantu_id" uuid NOT NULL,
	"no_akad" varchar(50),
	"pola" varchar(15) NOT NULL,
	"tanggal_acuan_bunga" smallint NOT NULL,
	"jatuh_tempo_pokok" date NOT NULL,
	"akun_hutang_id" uuid NOT NULL,
	"akun_beban_bunga_id" uuid NOT NULL,
	"keterangan" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."pinjaman_transaksi" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pinjaman_id" uuid NOT NULL,
	"jenis" varchar(10) NOT NULL,
	"tanggal" date NOT NULL,
	"nominal" numeric(18, 2) NOT NULL,
	"nominal_pokok" numeric(18, 2),
	"nominal_bunga" numeric(18, 2),
	"periode_bunga" varchar(30),
	"no_bukti" varchar(60),
	"akun_kas_id" uuid NOT NULL,
	"keterangan" text,
	"status_rincian" varchar(20) DEFAULT 'lengkap' NOT NULL,
	"jurnal_id" uuid,
	"dibuat_oleh" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."shm_riwayat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dokumen_id" uuid NOT NULL,
	"tanggal" date NOT NULL,
	"dari_status" varchar(20),
	"ke_status" varchar(20) NOT NULL,
	"lokasi" varchar(100),
	"keterangan" text,
	"oleh" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance"."jurnal" ADD COLUMN "no_referensi" varchar(60);--> statement-breakpoint
ALTER TABLE "finance"."kode_pembantu" ADD COLUMN "proyek_lawan_id" uuid;--> statement-breakpoint
ALTER TABLE "finance"."adendum_kontrak" ADD CONSTRAINT "adendum_kontrak_kontrak_id_kontrak_kontraktor_id_fk" FOREIGN KEY ("kontrak_id") REFERENCES "finance"."kontrak_kontraktor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."adendum_kontrak" ADD CONSTRAINT "adendum_kontrak_jurnal_id_jurnal_id_fk" FOREIGN KEY ("jurnal_id") REFERENCES "finance"."jurnal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."adendum_kontrak" ADD CONSTRAINT "adendum_kontrak_dibuat_oleh_users_id_fk" FOREIGN KEY ("dibuat_oleh") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."dokumen_legal_kavling" ADD CONSTRAINT "dokumen_legal_kavling_unit_id_trk_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "finance"."trk_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."dokumen_legal_kavling" ADD CONSTRAINT "dokumen_legal_kavling_pinjaman_id_pinjaman_id_fk" FOREIGN KEY ("pinjaman_id") REFERENCES "finance"."pinjaman"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."kontrak_kontraktor" ADD CONSTRAINT "kontrak_kontraktor_proyek_id_trk_projects_id_fk" FOREIGN KEY ("proyek_id") REFERENCES "finance"."trk_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."kontrak_kontraktor" ADD CONSTRAINT "kontrak_kontraktor_unit_id_trk_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "finance"."trk_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."kontrak_kontraktor" ADD CONSTRAINT "kontrak_kontraktor_kode_pembantu_id_kode_pembantu_id_fk" FOREIGN KEY ("kode_pembantu_id") REFERENCES "finance"."kode_pembantu"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."kontrak_kontraktor" ADD CONSTRAINT "kontrak_kontraktor_akun_persediaan_id_akun_id_fk" FOREIGN KEY ("akun_persediaan_id") REFERENCES "finance"."akun"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."kontrak_kontraktor" ADD CONSTRAINT "kontrak_kontraktor_akun_hutang_id_akun_id_fk" FOREIGN KEY ("akun_hutang_id") REFERENCES "finance"."akun"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."kontrak_kontraktor" ADD CONSTRAINT "kontrak_kontraktor_jurnal_id_jurnal_id_fk" FOREIGN KEY ("jurnal_id") REFERENCES "finance"."jurnal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."kontrak_kontraktor" ADD CONSTRAINT "kontrak_kontraktor_jurnal_batal_id_jurnal_id_fk" FOREIGN KEY ("jurnal_batal_id") REFERENCES "finance"."jurnal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pembayaran_kontrak" ADD CONSTRAINT "pembayaran_kontrak_kontrak_id_kontrak_kontraktor_id_fk" FOREIGN KEY ("kontrak_id") REFERENCES "finance"."kontrak_kontraktor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pembayaran_kontrak" ADD CONSTRAINT "pembayaran_kontrak_akun_kas_id_akun_id_fk" FOREIGN KEY ("akun_kas_id") REFERENCES "finance"."akun"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pembayaran_kontrak" ADD CONSTRAINT "pembayaran_kontrak_jurnal_id_jurnal_id_fk" FOREIGN KEY ("jurnal_id") REFERENCES "finance"."jurnal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pembayaran_kontrak" ADD CONSTRAINT "pembayaran_kontrak_dibuat_oleh_users_id_fk" FOREIGN KEY ("dibuat_oleh") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pinjaman" ADD CONSTRAINT "pinjaman_proyek_id_trk_projects_id_fk" FOREIGN KEY ("proyek_id") REFERENCES "finance"."trk_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pinjaman" ADD CONSTRAINT "pinjaman_kode_pembantu_id_kode_pembantu_id_fk" FOREIGN KEY ("kode_pembantu_id") REFERENCES "finance"."kode_pembantu"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pinjaman" ADD CONSTRAINT "pinjaman_akun_hutang_id_akun_id_fk" FOREIGN KEY ("akun_hutang_id") REFERENCES "finance"."akun"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pinjaman" ADD CONSTRAINT "pinjaman_akun_beban_bunga_id_akun_id_fk" FOREIGN KEY ("akun_beban_bunga_id") REFERENCES "finance"."akun"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pinjaman_transaksi" ADD CONSTRAINT "pinjaman_transaksi_pinjaman_id_pinjaman_id_fk" FOREIGN KEY ("pinjaman_id") REFERENCES "finance"."pinjaman"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pinjaman_transaksi" ADD CONSTRAINT "pinjaman_transaksi_akun_kas_id_akun_id_fk" FOREIGN KEY ("akun_kas_id") REFERENCES "finance"."akun"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pinjaman_transaksi" ADD CONSTRAINT "pinjaman_transaksi_jurnal_id_jurnal_id_fk" FOREIGN KEY ("jurnal_id") REFERENCES "finance"."jurnal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pinjaman_transaksi" ADD CONSTRAINT "pinjaman_transaksi_dibuat_oleh_users_id_fk" FOREIGN KEY ("dibuat_oleh") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."shm_riwayat" ADD CONSTRAINT "shm_riwayat_dokumen_id_dokumen_legal_kavling_id_fk" FOREIGN KEY ("dokumen_id") REFERENCES "finance"."dokumen_legal_kavling"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."shm_riwayat" ADD CONSTRAINT "shm_riwayat_oleh_users_id_fk" FOREIGN KEY ("oleh") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adendum_kontrak_idx" ON "finance"."adendum_kontrak" USING btree ("kontrak_id");--> statement-breakpoint
CREATE INDEX "kontrak_proyek_idx" ON "finance"."kontrak_kontraktor" USING btree ("proyek_id");--> statement-breakpoint
CREATE INDEX "pembayaran_kontrak_idx" ON "finance"."pembayaran_kontrak" USING btree ("kontrak_id");--> statement-breakpoint
CREATE INDEX "pinjaman_proyek_idx" ON "finance"."pinjaman" USING btree ("proyek_id");--> statement-breakpoint
CREATE INDEX "pinjaman_transaksi_pinjaman_idx" ON "finance"."pinjaman_transaksi" USING btree ("pinjaman_id");--> statement-breakpoint
CREATE INDEX "shm_riwayat_dokumen_idx" ON "finance"."shm_riwayat" USING btree ("dokumen_id");--> statement-breakpoint
ALTER TABLE "finance"."kode_pembantu" ADD CONSTRAINT "kode_pembantu_proyek_lawan_id_trk_projects_id_fk" FOREIGN KEY ("proyek_lawan_id") REFERENCES "finance"."trk_projects"("id") ON DELETE no action ON UPDATE no action;