// src/modules/auth/auth.routes.js
import { validate } from '../../middleware/validate.js';
import * as schema from './auth.schema.js';
import * as controller from './auth.controller.js';

const userSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string' },
  },
};

const tokenResponse = {
  200: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
      data: {
        type: 'object',
        properties: {
          user: userSchema,
          accessToken: { type: 'string', description: 'JWT untuk header Authorization: Bearer; berlaku 15 menit.' },
          refreshToken: { type: 'string', description: 'Token sekali pakai untuk POST /auth/refresh; berlaku 7 hari, dirotasi setiap refresh.' },
          tokenType: { type: 'string', enum: ['Bearer'] },
          expiresIn: { type: 'integer', description: 'Umur accessToken dalam detik.' },
        },
      },
    },
  },
};

// Opsional: klien Bearer mengirim refresh token di body; klien sesitus memakai cookie
const refreshBody = {
  // null: POST tanpa body (klien cookie) tetap diterima
  type: ['object', 'null'],
  properties: { refreshToken: { type: 'string', minLength: 1 } },
};

export default async function authRoutes(fastify) {
  fastify.post(
    '/login',
    {
      // Limit per-IP longgar (CGNAT); limit sebenarnya per email di service
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [validate(schema.loginSchema)],
      schema: {
        description: 'Login user SI',
        tags: ['Auth'],
        security: [],
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 1 },
          },
        },
        response: tokenResponse,
      },
    },
    controller.loginHandler
  );

  fastify.post(
    '/refresh',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        description: 'Memperbarui sesi dari refreshToken di body atau cookie refresh token',
        tags: ['Auth'],
        security: [],
        body: refreshBody,
        response: tokenResponse,
      },
    },
    controller.refreshHandler
  );

  fastify.post(
    '/logout',
    { schema: { description: 'Logout', tags: ['Auth'], security: [], body: refreshBody } },
    controller.logoutHandler
  );

  fastify.get(
    '/me',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Profil user yang sedang login',
        tags: ['Auth'],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: userSchema,
            },
          },
        },
      },
    },
    controller.meHandler
  );
}
