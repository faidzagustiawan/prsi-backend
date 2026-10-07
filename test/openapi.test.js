import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import SwaggerParser from '@apidevtools/swagger-parser';
import { z } from 'zod';
import { validatePatch } from '../src/middleware/validate.js';

const captured = vi.hoisted(() => ({ routes: [] }));
vi.mock('fastify', async (original) => {
  const { default: Fastify } = await original();
  return { default: (options) => {
    const app = Fastify(options);
    app.addHook('onRoute', (route) => captured.routes.push(route));
    return app;
  } };
});
vi.mock('../src/config/env.js', () => ({
  env: {
    nodeEnv: 'production', isDevelopment: false,
    jwtSecret: 'documentation-test-secret-at-least-32-characters',
    cookieSecret: 'documentation-test-cookie-at-least-32-characters',
    apiUrl: 'https://podorukunsi.my.id', frontendUrls: ['https://podorukunsi.my.id'],
    sync: { enabled: false },
  },
  JWT_AUDIENCE: 'podorukun-si', JWT_ISSUER: 'podorukun-si-api',
}));
vi.mock('../src/config/database.js', () => ({ db: {}, reportDb: {}, reportClient: {}, sessionClient: {} }));

const { buildApp } = await import('../src/app.js');
let app;
let document;
let originalSchemas;
beforeAll(async () => {
  app = await buildApp({ logger: false, documentationOnly: true });
  await app.ready();
  originalSchemas = captured.routes.map((route) => JSON.stringify(route.schema));
  document = app.swagger();
});
afterAll(async () => app?.close());

describe('OpenAPI contract', () => {
  it('validates as OpenAPI and includes every registered API operation exactly once', async () => {
    await SwaggerParser.validate(structuredClone(document));
    const registered = captured.routes.filter((route) =>
      (route.url.startsWith('/api/v1/') || route.url === '/health') && route.method !== 'HEAD');
    const expected = registered.map((route) => `${route.method.toLowerCase()} ${route.url.replace(/:([^/]+)/g, '{$1}').replace(/\/$/, '')}`).sort();
    const actual = Object.entries(document.paths).flatMap(([path, item]) => Object.keys(item).map((method) => `${method} ${path}`)).sort();
    expect(actual).toEqual(expected);
    const ids = Object.values(document.paths).flatMap((item) => Object.values(item).map((op) => op.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(document.paths['/openapi.json']).toBeUndefined();
  });

  it('documents cookie auth and exact authorization roles', () => {
    expect(document.paths['/api/v1/auth/login'].post.security).toEqual([]);
    expect(document.paths['/api/v1/auth/refresh'].post.security).toEqual([{ refreshCookie: [] }]);
    expect(document.paths['/api/v1/auth/me'].get.security).toEqual([{ accessCookie: [] }]);
    expect(document.paths['/api/v1/jurnal'].get['x-roles']).toEqual(['keuangan']);
    expect(document.paths['/api/v1/sinkron/status'].get['x-roles']).toEqual(['keuangan', 'admin']);
    expect(document.components.securitySchemes.accessCookie.name).toBe('si_access_token');
  });

  it('retains client input fields, query constraints and optional PATCH fields', () => {
    const journal = document.paths['/api/v1/jurnal'];
    const body = journal.post.requestBody.content['application/json'].schema;
    expect(body.properties.keterangan.type).toBe('string');
    expect(body.properties.uraian).toBeUndefined();
    expect(body.required).toContain('rows');
    expect(journal.get.parameters.find((p) => p.name === 'limit').schema.maximum).toBe(200);
    const patch = document.paths['/api/v1/akun/{id}'].patch.requestBody.content['application/json'].schema;
    expect(patch.minProperties).toBe(1);
    expect(patch.required ?? []).toEqual([]);
    expect(JSON.stringify(patch)).not.toContain('"default":');
    expect(journal.post.responses[201]).toBeDefined();
  });

  it('documents every path parameter and multipart/download/health exceptions', () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const operation of Object.values(item)) {
        for (const match of path.matchAll(/\{([^}]+)\}/g)) {
          expect(operation.parameters?.some((p) => p.name === match[1] && p.in === 'path' && p.required)).toBe(true);
        }
      }
    }
    expect(document.paths['/api/v1/lampiran'].post.requestBody.content['multipart/form-data'].schema.properties.file.format).toBe('binary');
    expect(document.paths['/api/v1/lampiran/{id}/unduh'].get.responses[302].headers.Location).toBeDefined();
    expect(document.paths['/health'].get.responses[503]).toBeDefined();
  });

  it('serves JSON only and never mutates runtime schemas or exposes a docs UI', async () => {
    expect(captured.routes.map((route) => JSON.stringify(route.schema))).toEqual(originalSchemas);
    const response = await app.inject('/openapi.json');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json().paths).toEqual(document.paths);
    expect((await app.inject('/docs')).statusCode).toBe(404);
    expect((await app.inject('/login')).statusCode).toBe(404);
  });

  it('preserves auth rejection and Zod validation after generating docs', async () => {
    expect((await app.inject('/api/v1/jurnal')).statusCode).toBe(401);
    const cookie = (role) => `si_access_token=${app.jwt.sign({ sub: '11111111-1111-4111-8111-111111111111', role })}`;
    expect((await app.inject({ url: '/api/v1/jurnal', headers: { cookie: cookie('admin') } })).statusCode).toBe(403);
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/jurnal', headers: { cookie: cookie('keuangan') }, payload: {} });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().errors[0]).toHaveProperty('field');
  });

  it('keeps omitted PATCH defaults out of the actual request', async () => {
    const handler = validatePatch({ body: z.object({ nama: z.string().optional(), status: z.string().default('aktif') }) });
    const request = { body: { nama: 'Contoh' } };
    await handler(request, { sent: false });
    expect(request.body).toEqual({ nama: 'Contoh' });
  });
});
