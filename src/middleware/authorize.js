// src/middleware/authorize.js
import { errorBody } from '../shared/utils/errorHandler.js';

export function authorize(...roles) {
  const handler = async (request, reply) => {
    // request.user di-inject oleh @fastify/jwt setelah lolos 'authenticate'
    if (!request.user || !roles.includes(request.user.role)) {
      const peran = request.user?.role ? `'${request.user.role}'` : 'Anda';
      return reply.code(403).send(errorBody(
        request,
        403,
        `Akses ditolak: peran ${peran} tidak berhak melakukan tindakan ini (perlu peran: ${roles.join(', ')}).`,
        { code: 'FORBIDDEN' },
      ));
    }
  };
  handler.allowedRoles = roles;
  return handler;
}

/** Semua modul keuangan: login + role keuangan. */
export const keuanganOnly = (fastify) => [fastify.authenticate, authorize('keuangan')];

/** Konteks pelaku untuk service: id user + IP untuk audit. */
export const actorOf = (request) => ({ userId: request.user.sub, ip: request.ip });
