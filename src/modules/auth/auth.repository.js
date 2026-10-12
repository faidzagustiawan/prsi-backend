// src/modules/auth/auth.repository.js
import { and, eq, gt } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { AppError } from '../../shared/utils/AppError.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { db } from '../../config/database.js';
import { users, refreshTokens } from '../../shared/schemas/finance.schema.js';

export const findUserByEmail = async (email) => {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return user ?? null;
};

export const findUserById = async (id) => {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
};

export const touchLastLogin = async (id) => {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
};

export const saveRefreshToken = async (userId, tokenHash, expiresAt, credentialHash) => db.transaction(async (tx) => {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update').limit(1);
  if (!user || user.status !== 'active' || createHash('sha256').update(user.passwordHash).digest('hex') !== credentialHash) {
    throw new AppError('Akun atau kredensial berubah. Silakan login kembali.', 401);
  }
  const [row] = await tx.insert(refreshTokens).values({ userId, tokenHash, expiresAt, credentialHash }).returning();
  return row;
});

export const findSession = async (id) => {
  const [row] = await db.select().from(refreshTokens).where(and(eq(refreshTokens.id, id), gt(refreshTokens.expiresAt, new Date()))).limit(1);
  return row ?? null;
};

// Compare-and-swap: satu pemenang, ID sesi tetap untuk pencabutan access JWT.
export const rotateRefreshToken = async (tokenHash, replacementHash) => {
  const [row] = await db.update(refreshTokens).set({ tokenHash: replacementHash })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), gt(refreshTokens.expiresAt, new Date()))).returning();
  return row ?? null;
};

export const revokeSession = async (id) => {
  await db.delete(refreshTokens).where(eq(refreshTokens.id, id));
};

// Jalur operasional reset/nonaktif: perubahan akun dan pencabutan seluruh
// sesi harus commit bersama, termasuk sesi yang belum dipakai lagi.
export const updateAccountSecurity = async (id, changes) => db.transaction(async (tx) => {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for('update').limit(1);
  if (!user) return null;
  const [updated] = await tx.update(users).set({ ...changes, updatedAt: new Date() }).where(eq(users.id, id))
    .returning({ id: users.id, status: users.status });
  await tx.delete(refreshTokens).where(eq(refreshTokens.userId, id));
  await recordAuditTx(tx, { action: AuditAction.UPDATE, entity: 'user', entityId: id,
    summary: 'Perubahan keamanan akun; seluruh sesi dicabut', metadata: { status: changes.status, passwordReset: Boolean(changes.passwordHash) } });
  return updated;
});

export const revokeRefreshToken = async (tokenHash) => {
  await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
};
