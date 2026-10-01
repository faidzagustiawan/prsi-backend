// Membuat user SI (misalnya super_admin pertama).
//
//   node scripts/create-user.js --email admin@contoh.com --nama "Admin Keuangan" --role super_admin
//   node scripts/create-user.js --email staf@contoh.com --nama "Staf" --role finance_staff --company <uuid-company-track>
//
// Password dibaca dari env SI_NEW_USER_PASSWORD supaya tidak tercatat di shell history.
import bcrypt from 'bcrypt';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { db, closeDatabase } from '../src/config/database.js';
import { users, SI_ROLES } from '../src/shared/schemas/finance.schema.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    nama: { type: 'string' },
    role: { type: 'string' },
    company: { type: 'string' },
  },
});

const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

const password = process.env.SI_NEW_USER_PASSWORD;

if (!values.email || !values.nama || !values.role) fail('--email, --nama, dan --role wajib diisi');
if (!SI_ROLES.includes(values.role)) fail(`--role harus salah satu dari: ${SI_ROLES.join(', ')}`);
if (values.role !== 'super_admin' && !values.company) fail('--company wajib untuk role selain super_admin');
if (!password || password.length < 12) fail('SI_NEW_USER_PASSWORD wajib diisi, minimal 12 karakter');

try {
  if (values.company) {
    const companies = await db.execute(sql`SELECT id FROM finance.track_companies() WHERE id = ${values.company}::uuid`);
    if (!companies.length) fail(`Company ${values.company} tidak ditemukan di Track`);
  }

  const [user] = await db
    .insert(users)
    .values({
      email: values.email.trim().toLowerCase(),
      nama: values.nama.trim(),
      role: values.role,
      companyId: values.company ?? null,
      passwordHash: await bcrypt.hash(password, 12),
    })
    .returning({ id: users.id, email: users.email, role: users.role });

  console.log(`✔ User dibuat: ${user.email} (${user.role}) id=${user.id}`);
} catch (err) {
  fail(err.code === '23505' ? 'Email sudah terdaftar' : err.message);
} finally {
  await closeDatabase();
}
