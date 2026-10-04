// src/modules/auth/auth.controller.js
import * as service from './auth.service.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../plugins/auth.js';
import { recordAudit, AuditAction } from '../../shared/utils/audit.js';

const secure = process.env.NODE_ENV !== 'development';

// Refresh token hanya dikirim browser ke endpoint auth, tidak ke seluruh API.
const REFRESH_PATH = '/api/v1/auth';

const setAuthCookies = (reply, tokens) => {
  reply.setCookie(ACCESS_COOKIE, tokens.accessToken, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'strict',
    maxAge: 15 * 60,
  });
  reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
    path: REFRESH_PATH,
    httpOnly: true,
    secure,
    sameSite: 'strict',
    maxAge: service.REFRESH_TTL_SEC,
  });
};

const clearAuthCookies = (reply) => {
  reply.clearCookie(ACCESS_COOKIE, { path: '/' });
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
};

export const loginHandler = async (request, reply) => {
  const { email, password } = request.body;
  const tokens = await service.loginUser(email, password, request.server);
  setAuthCookies(reply, tokens);

  await recordAudit({
    request,
    userId: tokens.user.id,
    action: AuditAction.LOGIN,
    entity: 'user',
    entityId: tokens.user.id,
    summary: `Login ${tokens.user.email}`,
  });

  // Token hanya lewat cookie httpOnly, tidak dikirim di body
  return reply.code(200).send({ success: true, message: 'Login berhasil', data: { user: tokens.user } });
};

export const refreshHandler = async (request, reply) => {
  try {
    const tokens = await service.refreshSession(request.cookies?.[REFRESH_COOKIE], request.server);
    setAuthCookies(reply, tokens);
    return reply.code(200).send({ success: true, message: 'Sesi diperbarui', data: { user: tokens.user } });
  } catch (error) {
    clearAuthCookies(reply);
    throw error;
  }
};

export const logoutHandler = async (request, reply) => {
  await service.logoutUser(request.cookies?.[REFRESH_COOKIE]);
  clearAuthCookies(reply);
  return reply.code(200).send({ success: true, message: 'Logout berhasil' });
};

export const meHandler = async (request, reply) => {
  const data = await service.getCurrentUser(request.user.sub);
  return reply.code(200).send({ success: true, message: 'Success', data });
};
