// src/modules/auth/auth.repository.js
import { eq } from 'drizzle-orm';
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

export const saveRefreshToken = async (userId, tokenHash, expiresAt) => {
  await db.insert(refreshTokens).values({ userId, tokenHash, expiresAt });
};

/**
 * Mengambil sekaligus menghapus refresh token (rotasi sekali pakai).
 * Dua request paralel dengan token yang sama: hanya satu yang mendapat baris.
 */
export const consumeRefreshToken = async (tokenHash) => {
  const [row] = await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).returning();
  return row ?? null;
};

export const revokeRefreshToken = async (tokenHash) => {
  await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
};
