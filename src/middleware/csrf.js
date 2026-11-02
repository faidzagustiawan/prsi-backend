import { errorBody } from '../shared/utils/errorHandler.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../plugins/auth.js';

// Cookie adalah kredensial ambient. Bearer/body token harus disediakan klien.
export function csrfGuard(allowedOrigins) {
  return async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const cookieAuth = request.cookies?.[ACCESS_COOKIE] || request.cookies?.[REFRESH_COOKIE];
    const tokenEndpoint = ['/api/v1/auth/refresh', '/api/v1/auth/logout'].includes(request.url.split('?')[0]);
    const explicitAuth = tokenEndpoint ? Boolean(request.body?.refreshToken) : /^Bearer\s/i.test(request.headers.authorization ?? '');
    if (!cookieAuth || explicitAuth) return;
    let origin = request.headers.origin;
    if (!origin && request.headers.referer) {
      try { origin = new URL(request.headers.referer).origin; } catch { /* reject below */ }
    }
    if (!origin || !allowedOrigins.includes(origin)) {
      return reply.code(403).send(errorBody(
        request,
        403,
        `Permintaan ditolak: origin '${origin ?? 'tidak diketahui'}' tidak diizinkan memakai sesi cookie. Muat ulang aplikasi dari alamat resmi.`,
        { code: 'CSRF_REJECTED' },
      ));
    }
  };
}
