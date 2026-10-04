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

const userResponse = {
  200: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
      data: { type: 'object', properties: { user: userSchema } },
    },
  },
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
        response: userResponse,
      },
    },
    controller.loginHandler
  );

  fastify.post(
    '/refresh',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        description: 'Memperbarui sesi dari cookie refresh token',
        tags: ['Auth'],
        security: [],
        response: userResponse,
      },
    },
    controller.refreshHandler
  );

  fastify.post(
    '/logout',
    { schema: { description: 'Logout', tags: ['Auth'], security: [] } },
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
