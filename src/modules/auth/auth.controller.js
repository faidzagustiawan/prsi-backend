// src/modules/auth/auth.controller.js
import * as service from './auth.service.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../plugins/auth.js';
import { recordAudit, AuditAction } from '../../shared/utils/audit.js';

const secure = process.env.NODE_ENV !== 'development';
const ACCESS_TTL_SEC = 15 * 60;

// Refresh token hanya dikirim browser ke endpoint auth, tidak ke seluruh API.
const REFRESH_PATH = '/api/v1/auth';

const setAuthCookies = (reply, tokens) => {
  reply.setCookie(ACCESS_COOKIE, tokens.accessToken, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'strict',
    maxAge: ACCESS_TTL_SEC,
  });
  reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
    path: REFRESH_PATH,
    httpOnly: true,
    secure,
    sameSite: 'strict',
    maxAge: service.REFRESH_TTL_SEC,
  });
};

// Klien lintas situs (mis. frontend di localhost) tidak menerima cookie SameSite=Strict,
// jadi token juga dikirim di body untuk dipakai sebagai Authorization: Bearer.
const tokenBody = (tokens) => ({
  user: tokens.user,
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  tokenType: 'Bearer',
  expiresIn: ACCESS_TTL_SEC,
});

// Refresh token dari body (klien Bearer) atau cookie (klien sesitus)
const refreshTokenFrom = (request) => request.body?.refreshToken || request.cookies?.[REFRESH_COOKIE];

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

  return reply.code(200).send({ success: true, message: 'Login berhasil', data: tokenBody(tokens) });
};

export const refreshHandler = async (request, reply) => {
  try {
    const tokens = await service.refreshSession(refreshTokenFrom(request), request.server);
    setAuthCookies(reply, tokens);
    return reply.code(200).send({ success: true, message: 'Sesi diperbarui', data: tokenBody(tokens) });
  } catch (error) {
    clearAuthCookies(reply);
    throw error;
  }
};

export const logoutHandler = async (request, reply) => {
  await service.logoutUser(refreshTokenFrom(request));
  clearAuthCookies(reply);
  return reply.code(200).send({ success: true, message: 'Logout berhasil' });
};

export const meHandler = async (request, reply) => {
  const data = await service.getCurrentUser(request.user.sub);
  return reply.code(200).send({ success: true, message: 'Success', data });
};
