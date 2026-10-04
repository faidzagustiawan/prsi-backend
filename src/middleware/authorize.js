// src/middleware/authorize.js
export function authorize(...roles) {
  const handler = async (request, reply) => {
    // request.user di-inject oleh @fastify/jwt setelah lolos 'authenticate'
    if (!request.user || !roles.includes(request.user.role)) {
      return reply.code(403).send({
        success: false,
        message: 'Forbidden: Insufficient privileges',
        errors: [],
      });
    }
  };
  handler.allowedRoles = roles;
  return handler;
}

/** Semua modul keuangan: login + role keuangan. */
export const keuanganOnly = (fastify) => [fastify.authenticate, authorize('keuangan')];

/** Konteks pelaku untuk service: id user + IP untuk audit. */
export const actorOf = (request) => ({ userId: request.user.sub, ip: request.ip });
