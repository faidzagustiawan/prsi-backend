// Guard migrasi SI: gagal (exit 1) kalau ada file SQL migrasi yang berpotensi
// menyentuh schema Track (public) atau objek global database.
// Dijalankan sebelum `drizzle-kit migrate` dan di CI.
//
//   node scripts/check-migrations.js [folder]   (default: ./drizzle)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || './drizzle';

const rules = [
  { re: /\b"?public"?\s*\./i, msg: 'mereferensikan schema public (milik Track)' },
  { re: /\bschema\s+"?public"?/i, msg: 'operasi pada schema public' },
  { re: /\bcreate\s+schema\s+(?!(?:if\s+not\s+exists\s+)?"?finance"?\s*$)/i, msg: 'membuat schema selain finance' },
  { re: /\bcreate\s+schema\s+(?!if\s+not\s+exists)/i, msg: 'CREATE SCHEMA tanpa IF NOT EXISTS (schema finance sudah dibuat oleh database/setup/001). Ubah menjadi: CREATE SCHEMA IF NOT EXISTS "finance"' },
  { re: /\b(drop|alter)\s+schema\b/i, msg: 'DROP/ALTER SCHEMA' },
  { re: /\bcreate\s+(or\s+replace\s+)?view\b/i, msg: 'membuat VIEW (pakai fungsi finance.track_* agar migrasi Track tidak terblokir)' },
  { re: /\bcreate\s+(constraint\s+)?trigger\b/i, msg: 'membuat TRIGGER (dilarang di SI)' },
  { re: /\bcreate\s+(or\s+replace\s+)?rule\b/i, msg: 'membuat RULE' },
  { re: /\b(alter|drop)\s+(type|domain)\s+(?!"?finance"?\.)/i, msg: 'mengubah TYPE/DOMAIN di luar schema finance' },
  { re: /\b(create|alter|drop)\s+(role|user|database|extension|event\s+trigger|publication|subscription)\b/i, msg: 'mengubah objek global database' },
  { re: /\b(grant|revoke)\b/i, msg: 'GRANT/REVOKE (hanya lewat database/setup, bukan migrasi)' },
  { re: /\btruncate\b/i, msg: 'TRUNCATE' },
  { re: /\bdrop\b[\s\S]*\bcascade\b/i, msg: 'DROP ... CASCADE (bisa menjalar ke objek lain)' },
  { re: /\breferences\s+(?!"?finance"?\s*\.)/i, msg: 'FOREIGN KEY ke tabel di luar schema finance' },
];

// Statement DDL yang menyebut tabel tanpa prefix schema dianggap berbahaya:
// semua tabel SI harus ditulis "finance"."nama".
const unqualified = /\b(create|alter|drop)\s+(table|index|sequence|function)\s+(if\s+(not\s+)?exists\s+)?(?!"?finance"?\.)("?\w+"?)\s*(\(|$|\s)/im;

function sqlFiles(path) {
  try {
    return readdirSync(path).flatMap((name) => {
      const full = join(path, name);
      if (statSync(full).isDirectory()) return sqlFiles(full);
      return name.endsWith('.sql') ? [full] : [];
    });
  } catch {
    return [];
  }
}

if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  // Folder salah ketik tidak boleh dianggap "aman"
  console.error(`✖ Folder migrasi tidak ditemukan: ${dir}`);
  process.exit(1);
}

const files = sqlFiles(dir);
const problems = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8')
    .replace(/--.*$/gm, '')
    .split(/;|-->\s*statement-breakpoint/);

  for (const stmt of lines) {
    const s = stmt.trim();
    if (!s) continue;
    for (const { re, msg } of rules) {
      if (re.test(s)) problems.push({ file, msg, stmt: s.slice(0, 160) });
    }
    if (unqualified.test(s) && !/\bcreate\s+index\b[\s\S]*\bon\s+"?finance"?\./i.test(s)) {
      problems.push({ file, msg: 'objek tanpa prefix schema "finance"', stmt: s.slice(0, 160) });
    }
  }
}

if (problems.length) {
  console.error(`\n✖ ${problems.length} masalah di migrasi SI:\n`);
  for (const p of problems) console.error(`  ${p.file}\n    ${p.msg}\n    > ${p.stmt}\n`);
  process.exit(1);
}

console.log(`✔ ${files.length} file migrasi aman (hanya schema finance).`);
