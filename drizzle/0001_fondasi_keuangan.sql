CREATE TABLE "finance"."akun" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kode" varchar(10) NOT NULL,
	"nama" varchar(150) NOT NULL,
	"induk_id" uuid,
	"kategori" varchar(12) NOT NULL,
	"tipe_saldo" varchar(1) NOT NULL,
	"klasifikasi" varchar(10) NOT NULL,
	"kategori_hutang_piutang" varchar(20),
	"wajib_kode_pembantu" boolean DEFAULT false NOT NULL,
	"wajib_proyek" boolean DEFAULT false NOT NULL,
	"is_kas_bank" boolean DEFAULT false NOT NULL,
	"no_rekening" varchar(30),
	"aktif" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "akun_kode_unique" UNIQUE("kode")
);
--> statement-breakpoint
CREATE TABLE "finance"."jurnal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"no_bukti" varchar(40) NOT NULL,
	"tanggal" date NOT NULL,
	"uraian" text NOT NULL,
	"proyek_id" uuid,
	"pt_id" uuid,
	"status" varchar(12) NOT NULL,
	"sumber" varchar(20) NOT NULL,
	"ref_type" varchar(40),
	"ref_id" uuid,
	"mirror_id" uuid,
	"dibalik_oleh_id" uuid,
	"dibuat_oleh" uuid,
	"diposting_oleh" uuid,
	"diposting_pada" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jurnal_no_bukti_unique" UNIQUE("no_bukti")
);
--> statement-breakpoint
CREATE TABLE "finance"."jurnal_detail" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurnal_id" uuid NOT NULL,
	"urutan" smallint NOT NULL,
	"akun_id" uuid NOT NULL,
	"kode_pembantu_id" uuid,
	"keterangan" varchar(255),
	"debit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"kredit" numeric(18, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."kode_pembantu" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kode" varchar(20) NOT NULL,
	"nama" varchar(150) NOT NULL,
	"kategori" varchar(20) NOT NULL,
	"proyek_id" uuid,
	"customer_id" uuid,
	"aktif" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kode_pembantu_kode_unique" UNIQUE("kode")
);
--> statement-breakpoint
CREATE TABLE "finance"."lampiran" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" varchar(40) NOT NULL,
	"entity_id" uuid NOT NULL,
	"nama_file" varchar(255) NOT NULL,
	"path" varchar(255) NOT NULL,
	"mime" varchar(50) NOT NULL,
	"ukuran" integer NOT NULL,
	"sumber" varchar(10) DEFAULT 'unggah' NOT NULL,
	"diunggah_oleh" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."master_pt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_company_id" uuid,
	"proyek_id" uuid,
	"nama_pt" varchar(150) NOT NULL,
	"singkatan" varchar(20),
	"nama_direktur" varchar(150) NOT NULL,
	"ttl" varchar(150),
	"pekerjaan" varchar(100),
	"alamat" text,
	"no_ktp" varchar(16),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_pt_proyek_id_unique" UNIQUE("proyek_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."penomoran" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jenis" varchar(20) NOT NULL,
	"scope" varchar(60) DEFAULT '' NOT NULL,
	"tahun" smallint NOT NULL,
	"bulan" smallint DEFAULT 0 NOT NULL,
	"nomor_terakhir" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."periode" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pt_id" uuid NOT NULL,
	"tahun" smallint NOT NULL,
	"bulan" smallint NOT NULL,
	"status" varchar(10) DEFAULT 'terbuka' NOT NULL,
	"ditutup_oleh" uuid,
	"ditutup_pada" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."saldo_awal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"periode_id" uuid NOT NULL,
	"akun_id" uuid NOT NULL,
	"kode_pembantu_id" uuid,
	"debit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"kredit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."saldo_awal_periode" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proyek_id" uuid NOT NULL,
	"tanggal_mulai" date NOT NULL,
	"status" varchar(10) DEFAULT 'terbuka' NOT NULL,
	"dikunci_oleh" uuid,
	"dikunci_pada" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saldo_awal_periode_proyek_id_unique" UNIQUE("proyek_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."status_pembayaran_si" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"status_proses" varchar(20) NOT NULL,
	"jurnal_id" uuid,
	"alasan" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."sync_cursor" (
	"id" varchar(20) PRIMARY KEY NOT NULL,
	"cursor_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."sync_error" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint,
	"entity" varchar(30) NOT NULL,
	"entity_track_id" uuid,
	"alasan" text NOT NULL,
	"payload" jsonb,
	"percobaan" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entitas" varchar(30) NOT NULL,
	"arah" varchar(15) NOT NULL,
	"mulai" timestamp with time zone NOT NULL,
	"selesai" timestamp with time zone,
	"jml_baru" integer DEFAULT 0 NOT NULL,
	"jml_ubah" integer DEFAULT 0 NOT NULL,
	"jml_gagal" integer DEFAULT 0 NOT NULL,
	"status" varchar(10) NOT NULL,
	"pesan" text
);
--> statement-breakpoint
CREATE TABLE "finance"."trk_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"row_version" bigint DEFAULT 0 NOT NULL,
	"track_seq" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unit_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"tipe_pembayaran" varchar(50),
	"harga" numeric(18, 2),
	"uang_muka" numeric(18, 2),
	"status" varchar(50),
	"tanggal" timestamp with time zone,
	CONSTRAINT "trk_assignments_track_id_unique" UNIQUE("track_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."trk_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"row_version" bigint DEFAULT 0 NOT NULL,
	"track_seq" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"nama" varchar(255) NOT NULL,
	CONSTRAINT "trk_clusters_track_id_unique" UNIQUE("track_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."trk_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"row_version" bigint DEFAULT 0 NOT NULL,
	"track_seq" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"nama" varchar(255) NOT NULL,
	"kode" varchar(50),
	"alamat" text,
	CONSTRAINT "trk_companies_track_id_unique" UNIQUE("track_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."trk_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"row_version" bigint DEFAULT 0 NOT NULL,
	"track_seq" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"nama" varchar(255) NOT NULL,
	"email" varchar(255),
	"no_hp" varchar(20),
	"tempat_lahir" varchar(100),
	"tanggal_lahir" date,
	"pekerjaan" varchar(100),
	"alamat" text,
	"no_ktp" varchar(16),
	CONSTRAINT "trk_customers_track_id_unique" UNIQUE("track_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."trk_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"row_version" bigint DEFAULT 0 NOT NULL,
	"track_seq" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"tanggal" date NOT NULL,
	"nominal" numeric(18, 2) NOT NULL,
	"jenis" varchar(20),
	"status_verifikasi" varchar(20),
	"diverifikasi_oleh" varchar(150),
	"diverifikasi_pada" timestamp with time zone,
	"rekening_tujuan" varchar(30),
	"bukti_url" text,
	"catatan" text,
	"is_auto_inject" boolean DEFAULT false NOT NULL,
	"source_created_at" timestamp with time zone,
	CONSTRAINT "trk_payments_track_id_unique" UNIQUE("track_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."trk_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"row_version" bigint DEFAULT 0 NOT NULL,
	"track_seq" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid,
	"kode" varchar(20),
	"nama" varchar(255) NOT NULL,
	"status" varchar(50),
	CONSTRAINT "trk_projects_track_id_unique" UNIQUE("track_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."trk_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"row_version" bigint DEFAULT 0 NOT NULL,
	"track_seq" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kode" varchar(50) NOT NULL,
	"tipe" varchar(50),
	"luas_tanah" numeric(10, 2),
	"luas_bangunan" numeric(10, 2),
	"status" varchar(50),
	CONSTRAINT "trk_units_track_id_unique" UNIQUE("track_id")
);
--> statement-breakpoint
DROP INDEX "finance"."users_company_idx";--> statement-breakpoint
ALTER TABLE "finance"."users" ALTER COLUMN "role" SET DATA TYPE varchar(20);--> statement-breakpoint
ALTER TABLE "finance"."users" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "finance"."users" ALTER COLUMN "status" SET DATA TYPE varchar(10);--> statement-breakpoint
ALTER TABLE "finance"."users" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
UPDATE "finance"."users" SET "role" = CASE "role" WHEN 'super_admin' THEN 'admin' ELSE 'keuangan' END WHERE "role" IN ('super_admin', 'finance_admin', 'finance_staff', 'viewer');--> statement-breakpoint
ALTER TABLE "finance"."audit_logs" ADD COLUMN "field" varchar(60);--> statement-breakpoint
ALTER TABLE "finance"."audit_logs" ADD COLUMN "nilai_lama" text;--> statement-breakpoint
ALTER TABLE "finance"."audit_logs" ADD COLUMN "nilai_baru" text;--> statement-breakpoint
ALTER TABLE "finance"."akun" ADD CONSTRAINT "akun_induk_id_akun_id_fk" FOREIGN KEY ("induk_id") REFERENCES "finance"."akun"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jurnal" ADD CONSTRAINT "jurnal_proyek_id_trk_projects_id_fk" FOREIGN KEY ("proyek_id") REFERENCES "finance"."trk_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jurnal" ADD CONSTRAINT "jurnal_pt_id_master_pt_id_fk" FOREIGN KEY ("pt_id") REFERENCES "finance"."master_pt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jurnal" ADD CONSTRAINT "jurnal_mirror_id_jurnal_id_fk" FOREIGN KEY ("mirror_id") REFERENCES "finance"."jurnal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jurnal" ADD CONSTRAINT "jurnal_dibalik_oleh_id_jurnal_id_fk" FOREIGN KEY ("dibalik_oleh_id") REFERENCES "finance"."jurnal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jurnal" ADD CONSTRAINT "jurnal_dibuat_oleh_users_id_fk" FOREIGN KEY ("dibuat_oleh") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jurnal" ADD CONSTRAINT "jurnal_diposting_oleh_users_id_fk" FOREIGN KEY ("diposting_oleh") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jurnal_detail" ADD CONSTRAINT "jurnal_detail_jurnal_id_jurnal_id_fk" FOREIGN KEY ("jurnal_id") REFERENCES "finance"."jurnal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jurnal_detail" ADD CONSTRAINT "jurnal_detail_akun_id_akun_id_fk" FOREIGN KEY ("akun_id") REFERENCES "finance"."akun"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jurnal_detail" ADD CONSTRAINT "jurnal_detail_kode_pembantu_id_kode_pembantu_id_fk" FOREIGN KEY ("kode_pembantu_id") REFERENCES "finance"."kode_pembantu"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."kode_pembantu" ADD CONSTRAINT "kode_pembantu_proyek_id_trk_projects_id_fk" FOREIGN KEY ("proyek_id") REFERENCES "finance"."trk_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."kode_pembantu" ADD CONSTRAINT "kode_pembantu_customer_id_trk_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "finance"."trk_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."lampiran" ADD CONSTRAINT "lampiran_diunggah_oleh_users_id_fk" FOREIGN KEY ("diunggah_oleh") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."master_pt" ADD CONSTRAINT "master_pt_track_company_id_trk_companies_id_fk" FOREIGN KEY ("track_company_id") REFERENCES "finance"."trk_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."master_pt" ADD CONSTRAINT "master_pt_proyek_id_trk_projects_id_fk" FOREIGN KEY ("proyek_id") REFERENCES "finance"."trk_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."periode" ADD CONSTRAINT "periode_pt_id_master_pt_id_fk" FOREIGN KEY ("pt_id") REFERENCES "finance"."master_pt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."periode" ADD CONSTRAINT "periode_ditutup_oleh_users_id_fk" FOREIGN KEY ("ditutup_oleh") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."saldo_awal" ADD CONSTRAINT "saldo_awal_periode_id_saldo_awal_periode_id_fk" FOREIGN KEY ("periode_id") REFERENCES "finance"."saldo_awal_periode"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."saldo_awal" ADD CONSTRAINT "saldo_awal_akun_id_akun_id_fk" FOREIGN KEY ("akun_id") REFERENCES "finance"."akun"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."saldo_awal" ADD CONSTRAINT "saldo_awal_kode_pembantu_id_kode_pembantu_id_fk" FOREIGN KEY ("kode_pembantu_id") REFERENCES "finance"."kode_pembantu"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."saldo_awal_periode" ADD CONSTRAINT "saldo_awal_periode_proyek_id_trk_projects_id_fk" FOREIGN KEY ("proyek_id") REFERENCES "finance"."trk_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."saldo_awal_periode" ADD CONSTRAINT "saldo_awal_periode_dikunci_oleh_users_id_fk" FOREIGN KEY ("dikunci_oleh") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."status_pembayaran_si" ADD CONSTRAINT "status_pembayaran_si_payment_id_trk_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "finance"."trk_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."trk_assignments" ADD CONSTRAINT "trk_assignments_unit_id_trk_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "finance"."trk_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."trk_assignments" ADD CONSTRAINT "trk_assignments_customer_id_trk_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "finance"."trk_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."trk_clusters" ADD CONSTRAINT "trk_clusters_project_id_trk_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "finance"."trk_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."trk_payments" ADD CONSTRAINT "trk_payments_assignment_id_trk_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "finance"."trk_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."trk_projects" ADD CONSTRAINT "trk_projects_company_id_trk_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "finance"."trk_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."trk_units" ADD CONSTRAINT "trk_units_cluster_id_trk_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "finance"."trk_clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."trk_units" ADD CONSTRAINT "trk_units_project_id_trk_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "finance"."trk_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "akun_induk_idx" ON "finance"."akun" USING btree ("induk_id");--> statement-breakpoint
CREATE INDEX "jurnal_tanggal_idx" ON "finance"."jurnal" USING btree ("tanggal");--> statement-breakpoint
CREATE INDEX "jurnal_proyek_idx" ON "finance"."jurnal" USING btree ("proyek_id");--> statement-breakpoint
CREATE INDEX "jurnal_ref_idx" ON "finance"."jurnal" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "jurnal_detail_jurnal_idx" ON "finance"."jurnal_detail" USING btree ("jurnal_id");--> statement-breakpoint
CREATE INDEX "jurnal_detail_akun_idx" ON "finance"."jurnal_detail" USING btree ("akun_id");--> statement-breakpoint
CREATE INDEX "jurnal_detail_kp_idx" ON "finance"."jurnal_detail" USING btree ("kode_pembantu_id");--> statement-breakpoint
CREATE INDEX "kode_pembantu_proyek_idx" ON "finance"."kode_pembantu" USING btree ("proyek_id");--> statement-breakpoint
CREATE INDEX "lampiran_entity_idx" ON "finance"."lampiran" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "penomoran_uq" ON "finance"."penomoran" USING btree ("jenis","scope","tahun","bulan");--> statement-breakpoint
CREATE UNIQUE INDEX "periode_pt_bulan_uq" ON "finance"."periode" USING btree ("pt_id","tahun","bulan");--> statement-breakpoint
CREATE INDEX "saldo_awal_periode_idx" ON "finance"."saldo_awal" USING btree ("periode_id");--> statement-breakpoint
CREATE INDEX "trk_assignments_unit_idx" ON "finance"."trk_assignments" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "trk_assignments_customer_idx" ON "finance"."trk_assignments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "trk_clusters_project_idx" ON "finance"."trk_clusters" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "trk_payments_assignment_idx" ON "finance"."trk_payments" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "trk_projects_company_idx" ON "finance"."trk_projects" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "trk_units_project_idx" ON "finance"."trk_units" USING btree ("project_id");--> statement-breakpoint
DROP TYPE "finance"."si_role";--> statement-breakpoint
DROP TYPE "finance"."user_status";