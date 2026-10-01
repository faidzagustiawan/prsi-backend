// src/modules/auth/auth.service.js
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import * as repo from './auth.repository.js';
import { AppError } from '../../shared/utils/AppError.js';
import { hitAttempt, peekAttempt, clearAttempt, formatWait, throttleKeys } from '../../shared/utils/throttle.js';

const LOGIN_MAX_FAILED = 10; // per email, jendela 15 menit
const LOGIN_WINDOW_SEC = 15 * 60;
export const REFRESH_TTL_SEC = 7 * 24 * 60 * 60; // 7 hari, lebih pendek dari Track karena data keuangan

// Dipakai saat email tidak terdaftar, supaya waktu respons sama dengan password
// salah dan email valid tidak bisa ditebak dari lamanya respons.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

const hashToken =(raw) => crypto.createHash('sha256').update(raw).digest('hex');

export const toPublicUser = (user) => ({
  id: user.id,
  nama: user.nama,
  email: user.email,
  role: user.role,
  companyId: user.companyId,
});

/** Membuat access token + refresh token baru untuk user. */
const issueTokens = async (user, fastify) => {
  const accessToken = fastify.jwt.sign({
    sub: user.id,
    companyId: user.companyId,
    role: user.role,
    email: user.email,
  });

  const refreshToken = crypto.randomBytes(40).toString('hex');
  await repo.saveRefreshToken(user.id, hashToken(refreshToken), new Date(Date.now() + REFRESH_TTL_SEC * 1000));

  return { accessToken, refreshToken, user: toPublicUser(user) };
};

const assertAccountActive = (user) => {
  if (user.status !== 'active') {
    throw new AppError('Akun Anda telah dinonaktifkan. Silakan hubungi Admin.', 403);
  }
};

export const loginUser = async (email, password, fastify) => {
  const throttleKey = throttleKeys.login(email);

  const locked = await peekAttempt(throttleKey, { max: LOGIN_MAX_FAILED });
  if (locked.exceeded) {
    throw new AppError(
      `Terlalu banyak percobaan login yang gagal. Silakan coba lagi dalam ${formatWait(locked.retryAfterSec)}.`,
      429
    );
  }

  const user = await repo.findUserByEmail(email);
  const isValid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH) && Boolean(user);

  if (!isValid) {
    // Email tidak terdaftar tetap dihitung agar email valid tidak bisa ditebak
    await hitAttempt(throttleKey, { max: LOGIN_MAX_FAILED, windowSec: LOGIN_WINDOW_SEC });
    throw new AppError('Email atau password salah.', 401);
  }

  // Dicek setelah kredensial benar supaya tidak membocorkan akun mana yang ada
  assertAccountActive(user);
  await clearAttempt(throttleKey);
  await repo.touchLastLogin(user.id);

  return issueTokens(user, fastify);
};

export const refreshSession = async (rawRefreshToken, fastify) => {
  if (!rawRefreshToken) throw new AppError('Sesi tidak ditemukan. Silakan login kembali.', 401);

  const stored = await repo.consumeRefreshToken(hashToken(rawRefreshToken));
  if (!stored || stored.expiresAt.getTime() < Date.now()) {
    throw new AppError('Sesi Anda telah berakhir. Silakan login kembali.', 401);
  }

  const user = await repo.findUserById(stored.userId);
  if (!user) throw new AppError('Sesi tidak valid. Silakan login kembali.', 401);
  assertAccountActive(user);

  return issueTokens(user, fastify);
};

export const logoutUser = async (rawRefreshToken) => {
  if (rawRefreshToken) await repo.revokeRefreshToken(hashToken(rawRefreshToken));
};

export const getCurrentUser = async (userId) => {
  const user = await repo.findUserById(userId);
  if (!user) throw new AppError('User tidak ditemukan.', 404);
  return toPublicUser(user);
};
