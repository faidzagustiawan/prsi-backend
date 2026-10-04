// src/plugins/swagger.js
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import { env } from '../config/env.js';
import { openapiInfo, transformRoute, completeDocument } from '../documentation/openapi.js';

/** Menghapus keyword OpenAPI (example/examples) yang tidak dikenali AJV. */
export function removeExamples(schema) {
  if (Array.isArray(schema)) return schema.map(removeExamples);

  if (schema && typeof schema === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'example' || key === 'examples') continue;
      cleaned[key] = removeExamples(value);
    }
    return cleaned;
  }

  return schema;
}

async function swaggerPlugin(fastify) {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: openapiInfo,
      servers: [
        { url: env.apiUrl, description: 'API yang didokumentasikan' },
        ...(env.apiUrl === 'http://localhost:3100' ? [] : [{ url: 'http://localhost:3100', description: 'Development lokal' }]),
      ],
      components: {
        securitySchemes: {
          accessCookie: { type: 'apiKey', in: 'cookie', name: 'si_access_token', description: 'Cookie HttpOnly dari POST /api/v1/auth/login; berlaku 15 menit.' },
          refreshCookie: { type: 'apiKey', in: 'cookie', name: 'si_refresh_token', description: 'Cookie HttpOnly, path /api/v1/auth; berlaku 7 hari dan dirotasi setiap refresh.' },
        },
      },
    },
    transform: transformRoute,
    transformObject: ({ openapiObject }) => completeDocument(openapiObject),
  });

  fastify.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send(fastify.swagger()));
}

export default fp(swaggerPlugin);
