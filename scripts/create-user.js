// Membuat user SI.
//
//   node scripts/create-user.js --email keuangan@contoh.com --nama "Staf Keuangan" --role keuangan
//
// Role: admin, keuangan, teknisi, marketing, kontraktor.
// Password dibaca dari env SI_NEW_USER_PASSWORD supaya tidak tercatat di shell history.
import bcrypt from 'bcrypt';
import { parseArgs } from 'node:util';
import { db, closeDatabase } from '../src/config/database.js';
import { users } from '../src/shared/schemas/finance.schema.js';
import { ROLES } from '../src/shared/constants.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    nama: { type: 'string' },
    role: { type: 'string' },
  },
});

const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

const password = process.env.SI_NEW_USER_PASSWORD;

if (!values.email || !values.nama || !values.role) fail('--email, --nama, dan --role wajib diisi');
if (!ROLES.includes(values.role)) fail(`--role harus salah satu dari: ${ROLES.join(', ')}`);
if (!password || password.length < 12) fail('SI_NEW_USER_PASSWORD wajib diisi, minimal 12 karakter');

try {
  const [user] = await db
    .insert(users)
    .values({
      email: values.email.trim().toLowerCase(),
      nama: values.nama.trim(),
      role: values.role,
      passwordHash: await bcrypt.hash(password, 12),
    })
    .returning({ id: users.id, email: users.email, role: users.role });

  console.log(`✔ User dibuat: ${user.email} (${user.role}) id=${user.id}`);
} catch (err) {
  fail(err.code === '23505' ? 'Email sudah terdaftar' : err.message);
} finally {
  await closeDatabase();
}
