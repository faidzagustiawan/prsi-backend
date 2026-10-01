import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = join(import.meta.dirname, '..', 'scripts', 'check-migrations.js');
let dir;

const check = (sqlText) => {
  writeFileSync(join(dir, '0000_test.sql'), sqlText);
  return spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'si-migrations-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('check-migrations', () => {
  it('meloloskan migrasi drizzle yang hanya menyentuh schema finance', () => {
    const result = check(`
CREATE SCHEMA IF NOT EXISTS "finance";
--> statement-breakpoint
CREATE TYPE "finance"."si_role" AS ENUM('super_admin', 'viewer');
--> statement-breakpoint
CREATE TABLE "finance"."users" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL);
--> statement-breakpoint
CREATE INDEX "users_idx" ON "finance"."users" USING btree ("id");
--> statement-breakpoint
ALTER TABLE "finance"."refresh_tokens" ADD CONSTRAINT "fk" FOREIGN KEY ("user_id") REFERENCES "finance"."users"("id") ON DELETE cascade ON UPDATE no action;
`);
    expect(result.status).toBe(0);
  });

  it.each([
    ['CREATE SCHEMA finance tanpa IF NOT EXISTS', 'CREATE SCHEMA "finance";'],
    ['schema selain finance', 'CREATE SCHEMA IF NOT EXISTS "lain";'],
    ['drop schema', 'DROP SCHEMA "finance";'],
    ['tabel tanpa prefix schema', 'CREATE TABLE "journal" ("id" uuid);'],
    ['referensi ke public', 'SELECT * FROM "public"."users";'],
    ['foreign key ke tabel Track', 'ALTER TABLE "finance"."j" ADD CONSTRAINT "f" FOREIGN KEY ("u") REFERENCES "public"."units"("id");'],
    ['view', 'CREATE VIEW "finance"."v" AS SELECT 1;'],
    ['trigger', 'CREATE TRIGGER t AFTER INSERT ON "finance"."x" FOR EACH ROW EXECUTE FUNCTION f();'],
    ['drop cascade', 'DROP TABLE "finance"."x" CASCADE;'],
    ['grant', 'GRANT SELECT ON "finance"."x" TO someone;'],
    ['ubah role', 'ALTER ROLE si_app SET search_path = public;'],
    ['truncate', 'TRUNCATE "finance"."x";'],
  ])('menolak %s', (_label, sqlText) => {
    const result = check(sqlText);
    expect(result.status).toBe(1);
  });

  it('menolak folder migrasi yang tidak ada', () => {
    const result = spawnSync(process.execPath, [script, join(dir, 'tidak-ada')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
  });
});
