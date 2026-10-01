// src/middleware/authorize.js
export function authorize(...roles) {
  return async (request, reply) => {
    // request.user di-inject oleh @fastify/jwt setelah lolos 'authenticate'
    if (!request.user || !roles.includes(request.user.role)) {
      return reply.code(403).send({
        success: false,
        message: 'Forbidden: Insufficient privileges',
        errors: [],
      });
    }
  };
}
