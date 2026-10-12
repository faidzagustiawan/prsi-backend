// src/plugins/auth.js
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { env, JWT_AUDIENCE, JWT_ISSUER } from '../config/env.js';
import { validateSession } from '../modules/auth/auth.service.js';

// Nama cookie berbeda dari Track (accessToken/refreshToken) supaya tidak saling
// menimpa bila kedua aplikasi berada di domain induk yang sama.
export const ACCESS_COOKIE = 'si_access_token';
export const REFRESH_COOKIE = 'si_refresh_token';

export default fp(async function authPlugin(fastify) {
  fastify.register(fastifyJwt, {
    secret: env.jwtSecret,
    cookie: {
      cookieName: ACCESS_COOKIE,
      signed: false,
    },
    sign: {
      aud: JWT_AUDIENCE,
      iss: JWT_ISSUER,
      expiresIn: '15m',
    },
    verify: {
      allowedAud: JWT_AUDIENCE,
      allowedIss: JWT_ISSUER,
    },
  });

  fastify.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify();
      const user = await validateSession(request.user);
      request.user.role = user.role;
    } catch (error) {
      // Gangguan DB bukan kredensial salah: jangan memicu refresh berulang.
      if (!error.code?.includes('JWT') && error.statusCode !== 401 && error.code !== 'FAST_JWT_EXPIRED') throw error;
      return reply.code(401).send({
        success: false,
        message: 'Unauthorized',
        errors: [],
      });
    }
  });
  fastify.authenticate.requiresAuthentication = true;
});
