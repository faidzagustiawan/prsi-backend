// src/plugins/swagger.js
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from '../config/env.js';

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
      info: {
        title: 'PodorukunSI API',
        description: 'Dokumentasi API Sistem Informasi Keuangan Podorukun',
        version: '0.1.0',
      },
      servers: [{ url: env.apiUrl, description: 'API Server' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: false },
    staticCSP: true,
    transformStaticCSP: (header) => header,
    transformSpecificationClone: true,
  });
}

export default fp(swaggerPlugin);
