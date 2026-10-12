import bcrypt from 'bcrypt';
import { z } from 'zod';
import { closeDatabase, db } from '../src/config/database.js';
import { assertIsolatedRole } from '../src/config/dbGuard.js';
import { updateAccountSecurity } from '../src/modules/auth/auth.repository.js';

// Password hanya lewat environment sementara, tidak lewat argumen/log.
const args = process.argv.slice(2);
try {
  const id = z.uuid().parse(args[0]);
  const changes = {};
  if (args.includes('--status')) changes.status = z.enum(['active', 'inactive']).parse(args[args.indexOf('--status') + 1]);
  if (args.includes('--reset-password')) {
    const password = process.env.SI_NEW_USER_PASSWORD;
    if (!password || password.length < 12) throw new Error('SI_NEW_USER_PASSWORD wajib minimal 12 karakter.');
    changes.passwordHash = await bcrypt.hash(password, 12);
  }
  if (!Object.keys(changes).length) throw new Error('Gunakan <UUID> --status active|inactive atau --reset-password.');
  await assertIsolatedRole(db);
  const user = await updateAccountSecurity(id, changes);
  if (!user) throw new Error('User tidak ditemukan.');
  console.log(`User ${user.id}: ${user.status}; seluruh sesi dicabut.`);
} catch {
  console.error('Gagal. Periksa UUID, opsi --status active|inactive / --reset-password, dan SI_NEW_USER_PASSWORD (minimal 12 karakter).');
  process.exitCode = 1;
} finally {
  delete process.env.SI_NEW_USER_PASSWORD;
  await closeDatabase();
}
