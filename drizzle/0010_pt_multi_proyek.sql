CREATE TABLE "finance"."master_pt_proyek" (
	"pt_id" uuid NOT NULL,
	"proyek_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_pt_proyek_proyek_id_unique" UNIQUE("proyek_id")
);
--> statement-breakpoint
ALTER TABLE "finance"."master_pt" DROP CONSTRAINT "master_pt_proyek_id_unique";--> statement-breakpoint
ALTER TABLE "finance"."master_pt" DROP CONSTRAINT "master_pt_proyek_id_trk_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."master_pt_proyek" ADD CONSTRAINT "master_pt_proyek_pt_id_master_pt_id_fk" FOREIGN KEY ("pt_id") REFERENCES "finance"."master_pt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."master_pt_proyek" ADD CONSTRAINT "master_pt_proyek_proyek_id_trk_projects_id_fk" FOREIGN KEY ("proyek_id") REFERENCES "finance"."trk_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "master_pt_proyek_pt_idx" ON "finance"."master_pt_proyek" USING btree ("pt_id");--> statement-breakpoint
-- Pindahkan relasi lama (satu PT satu perumahan) ke tabel relasi baru.
INSERT INTO "finance"."master_pt_proyek" ("pt_id", "proyek_id")
SELECT "id", "proyek_id" FROM "finance"."master_pt"
WHERE "proyek_id" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
-- Pola nomor lama hasil normalisasi FE menyimpan tahun literal ({2026}),
-- yang tidak pernah diganti saat penomoran. Ganti dengan token {TAHUN}.
UPDATE "finance"."template_dokumen"
SET "pola_nomor" = regexp_replace("pola_nomor", '\{20[0-9]{2}\}', '{TAHUN}', 'g')
WHERE "pola_nomor" ~ '\{20[0-9]{2}\}';--> statement-breakpoint
ALTER TABLE "finance"."master_pt" DROP COLUMN "proyek_id";