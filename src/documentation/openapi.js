import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ROLES } from '../shared/constants.js';

export const openapiInfo = {
  title: 'PodorukunSI · Backend API',
  version: '0.1.0',
  description: readFileSync(new URL('../../docs/API_GUIDE.md', import.meta.url), 'utf8'),
};

const createdPaths = new Set([
  '/master-pt', '/akun', '/kode-pembantu', '/jurnal', '/jurnal/:id/balik',
  '/lampiran', '/hutang/mutasi', '/pinjaman', '/pinjaman/:id/top-up',
  '/pinjaman/:id/pembayaran', '/kontrak', '/kontrak/:id/adendum',
  '/kontrak/:id/pembayaran', '/shm', '/pasal', '/template-dokumen',
  '/template-dokumen/:id/duplikat', '/dokumen', '/dokumen/:id/pasal',
  '/dokumen/:id/adendum', '/piutang/:id/biaya-kpr',
]);

const id = '11111111-1111-4111-8111-111111111111';
const examples = {
  '/auth/login': { email: 'keuangan@example.test', password: 'ContohSajaBukanPasswordAsli' },
  '/jurnal': {
    tanggal: '2026-10-04', keterangan: 'Contoh jurnal berimbang', proyekId: id, status: 'draft',
    rows: [
      { akunId: id, debit: 100000, kredit: 0 },
      { akunId: '22222222-2222-4222-8222-222222222222', debit: 0, kredit: 100000 },
    ],
  },
};

function stripDefaults(value) {
  if (Array.isArray(value)) return value.map(stripDefaults);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'default')
    .map(([key, child]) => [key, stripDefaults(child)]));
}

/** Runs only while generating OpenAPI; runtime route schemas remain untouched. */
export function transformRoute({ schema = {}, url, route }) {
  if ((!url.startsWith('/api/v1/') && url !== '/health') || route.method === 'HEAD') {
    return { schema: { hide: true }, url };
  }
  const result = structuredClone(schema);
  const hooks = [route.preHandler ?? []].flat(Infinity);
  const relative = url.replace(/^\/api\/v1/, '').replace(/\/$/, '');
  const roles = hooks.flatMap((hook) => hook.allowedRoles ?? []);
  const secured = hooks.some((hook) => hook.requiresAuthentication || hook.allowedRoles);
  result.security = secured ? [{ bearerAuth: [] }, { accessCookie: [] }] : [];
  if (relative === '/auth/refresh') result.security = [{}, { refreshCookie: [] }];
  result.summary ||= (result.description || (url === '/health' ? 'Kesehatan API, database, dan Redis' : relative)).split(/[.\n]/)[0];
  result.tags ||= ['Operasional'];
  result.operationId = `${String(route.method).toLowerCase()}_${relative.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
  result['x-roles'] = roles.length ? [...new Set(roles)] : secured ? ROLES : [];
  result['x-success-status'] = route.method === 'POST' && createdPaths.has(relative) ? 201 : 200;
  result.description = [result.description, roles.length ? `**Role:** ${roles.map((role) => `\`${role}\``).join(', ')}.` : secured ? '**Akses:** semua role yang sudah login.' : '**Akses:** tidak memerlukan access cookie.'].filter(Boolean).join('\n\n');
  if (route.config?.rateLimit) {
    result.description += `\n\n**Rate limit endpoint:** ${route.config.rateLimit.max} request / ${route.config.rateLimit.timeWindow}.`;
  }
  for (const hook of hooks) {
    for (const [source, target] of [['body', 'body'], ['query', 'querystring'], ['params', 'params']]) {
      const validator = hook.validationSchema?.[source];
      if (!validator) continue;
      // Input mode preserves client field names before transforms (keterangan -> uraian).
      let converted = z.toJSONSchema(validator, { io: 'input', target: 'openapi-3.0' });
      if (hook.isPatchValidation && source === 'body') {
        converted = { ...stripDefaults(converted), minProperties: 1 };
        result.description += '\n\n**PATCH:** kirim hanya field yang diubah; body kosong ditolak.';
      }
      const example = source === 'body' && route.method === 'POST' && examples[relative];
      if (example && validator.safeParse(example).success) converted.example = example;
      result[target] = converted;
    }
  }
  return { schema: result, url };
}

const errorSchema = {
  type: 'object', required: ['success', 'message', 'errors'],
  properties: {
    success: { type: 'boolean', enum: [false] }, message: { type: 'string' },
    errors: { type: 'array', items: { oneOf: [
      { type: 'string' },
      { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } }, required: ['field', 'message'] },
    ] } },
  },
};
const successSchema = {
  type: 'object', required: ['success', 'message'],
  properties: {
    success: { type: 'boolean', enum: [true] }, message: { type: 'string' },
    data: { description: 'Payload modul: objek, array, atau null. Struktur detail mengikuti endpoint; belum semua DTO memiliki JSON Schema response.' },
    meta: { type: 'object', additionalProperties: true, description: 'Metadata opsional; daftar berhalaman memakai page, limit, total. Laporan memiliki metadata khusus.' },
  },
};

const jsonResponse = (description, schema, example) => ({
  description, content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const errorMessages = {
  400: 'Input tidak valid, duplikasi, atau referensi data tidak valid.',
  401: 'Sesi tidak ada/kedaluwarsa; coba refresh sekali.',
  403: 'Role tidak diizinkan atau origin ditolak oleh CORS.',
  404: 'Entitas yang diminta tidak ditemukan.',
  409: 'Konflik state atau integrasi.',
  422: 'Aturan bisnis tidak terpenuhi; baca message dan errors.',
  429: 'Rate limit atau throttle login; tunggu sebelum mencoba lagi.',
  500: 'Kesalahan internal; detail sensitif tidak dikirim ke klien.',
};

function finishOperation(operation, path, method) {
  const code = operation['x-success-status'];
  delete operation['x-success-status'];
  const response = operation.responses?.[code];
  if (!response?.content) {
    operation.responses = { [code]: jsonResponse(code === 201 ? 'Data berhasil dibuat.' : 'Permintaan berhasil.', ref('SuccessEnvelope')) };
  }
  for (const [status, description] of Object.entries(errorMessages)) {
    if (status === '401' && !operation.security?.length && !path.endsWith('/auth/login')) continue;
    operation.responses[status] ||= jsonResponse(description, ref('ErrorEnvelope'));
  }
  if (path.endsWith('/auth/login') || path.endsWith('/auth/refresh')) {
    operation.responses[200].headers = {
      'Set-Cookie': { schema: { type: 'string' }, description: 'Dua header Set-Cookie: si_access_token dan si_refresh_token. HttpOnly; Secure di produksi; SameSite=Strict. Browser mengelola cookie otomatis untuk klien sesitus; klien lintas situs memakai token di body.' },
    };
  }
  if (path === '/api/v1/auth/logout') {
    operation.description += '\n\nMencabut refresh session (refreshToken di body atau cookie) jika tersedia dan menghapus kedua cookie. Dapat dipanggil tanpa sesi.';
  }
  if (path === '/api/v1/lampiran' && method === 'post') {
    operation.requestBody = { required: true, content: { 'multipart/form-data': {
      schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary', description: 'Satu PDF/JPEG/PNG/WEBP, maksimum 10 MiB; signature berkas diperiksa.' } } },
    } } };
    operation.responses[413] = jsonResponse('Berkas terlalu besar.', ref('ErrorEnvelope'));
  }
  if (path === '/api/v1/lampiran/{id}/unduh') {
    operation.parameters ||= [];
    operation.parameters.push({ name: 'inline', in: 'query', required: false, schema: { type: 'string', enum: ['1'] }, description: '1 = inline; jika tidak diberikan, attachment.' });
    operation.responses[200] = { description: 'Isi berkas; Content-Disposition menentukan nama dan tampilan.', content: Object.fromEntries(
      ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].map((mime) => [mime, { schema: { type: 'string', format: 'binary' } }]),
    ) };
    operation.responses[302] = { description: 'Lampiran milik PR Track: redirect ke lokasi sumber.', headers: { Location: { schema: { type: 'string', format: 'uri' } } } };
  }
}

export function completeDocument(document) {
  document.components.schemas = {
    ...document.components.schemas, SuccessEnvelope: successSchema, ErrorEnvelope: errorSchema,
  };
  // Fastify prefixes produce trailing slashes; publish canonical collection URLs.
  document.paths = Object.fromEntries(Object.entries(document.paths).map(([path, value]) => [path.replace(/\/$/, ''), value]));
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) finishOperation(operation, path, method);
  }
  const healthSchema = {
    type: 'object', required: ['success', 'status', 'timestamp', 'checks'],
    properties: {
      success: { type: 'boolean' }, status: { type: 'string', enum: ['healthy', 'degraded'] },
      timestamp: { type: 'string', format: 'date-time' },
      checks: { type: 'object', properties: Object.fromEntries(['server', 'database', 'redis'].map((key) => [key, { type: 'string' }])) },
    },
  };
  document.paths['/health'].get.responses = {
    200: jsonResponse('Database dan Redis sehat.', healthSchema, { success: true, status: 'healthy', timestamp: '2026-10-04T00:00:00Z', checks: { server: 'ok', database: 'ok', redis: 'ok' } }),
    503: jsonResponse('Database atau Redis bermasalah.', healthSchema),
  };
  document.tags = [...new Set(Object.values(document.paths).flatMap((item) => Object.values(item).flatMap((op) => op.tags)))].map((name) => ({ name }));
  return document;
}
