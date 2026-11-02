import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import '../src/shared/utils/zod.js';
import { globalErrorHandler, notFoundHandler } from '../src/shared/utils/errorHandler.js';
import { validate } from '../src/middleware/validate.js';
import { authorize } from '../src/middleware/authorize.js';
import { AppError } from '../src/shared/utils/AppError.js';

const pgError = (fields) => Object.assign(new Error('raw db message'), fields);

describe('format galat API', () => {
  let app;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(globalErrorHandler);
    app.setNotFoundHandler(notFoundHandler);
    app.post('/zod', { preHandler: validate({ body: z.object({ nama: z.string(), nominal: z.number().min(1, 'Nominal minimal 1') }) }) }, async () => ({ ok: true }));
    app.post('/ajv', { schema: { body: { type: 'object', required: ['kode'], properties: { kode: { type: 'string' } } } } }, async () => ({ ok: true }));
    app.get('/bisnis', async () => { throw new AppError('Jurnal tidak dapat disimpan.', 422, ['Debit dan kredit tidak seimbang.']); });
    app.get('/duplikat', async () => { throw new Error('wrap', { cause: pgError({ code: '23505', detail: 'Key (kode)=(1101) already exists.' }) }); });
    app.get('/dipakai', async () => { throw pgError({ code: '23503', detail: 'Key (id)=(x) is still referenced from table "jurnal".' }); });
    app.get('/db-mati', async () => { throw pgError({ code: 'ECONNREFUSED' }); });
    app.get('/crash', async () => { throw new Error('secret internal detail: password=abc'); });
    app.get('/terlarang', { preHandler: [async (req) => { req.user = { role: 'admin' }; }, authorize('keuangan')] }, async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(() => app.close());

  it('validasi zod: pesan Indonesia, rincian per kolom, kode + requestId', async () => {
    const res = await app.inject({ method: 'POST', url: '/zod', payload: { nominal: 0 } });
    const body = res.json();
    expect(res.statusCode).toBe(400);
    expect(body).toMatchObject({ success: false, code: 'VALIDATION' });
    expect(body.requestId).toBeTruthy();
    expect(body.message).toContain('2 kesalahan');
    expect(body.errors).toEqual([
      { field: 'nama', message: "Kolom 'nama': Wajib diisi." },
      { field: 'nominal', message: "Kolom 'nominal': Nominal minimal 1" },
    ]);
  });

  it('validasi ajv memakai bentuk rincian yang sama', async () => {
    const body = (await app.inject({ method: 'POST', url: '/ajv', payload: {} })).json();
    expect(body.errors).toEqual([{ field: 'kode', message: "Kolom 'kode' wajib diisi." }]);
    expect(body.message).toBe("Kolom 'kode' wajib diisi.");
  });

  it('AppError dengan rincian string dinormalisasi menjadi objek', async () => {
    const res = await app.inject('/bisnis');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ message: 'Jurnal tidak dapat disimpan.', code: 'UNPROCESSABLE', errors: [{ message: 'Debit dan kredit tidak seimbang.' }] });
  });

  it('galat database diterjemahkan dengan konteks yang membantu', async () => {
    const dup = await app.inject('/duplikat');
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toContain("kode '1101' sudah terdaftar");
    expect((await app.inject('/dipakai')).json().code).toBe('IN_USE');
    const down = await app.inject('/db-mati');
    expect(down.statusCode).toBe(503);
    expect(down.json().code).toBe('DB_UNAVAILABLE');
  });

  it('galat 500 tidak membocorkan detail internal', async () => {
    const res = await app.inject('/crash');
    expect(res.statusCode).toBe(500);
    expect(res.json().message).not.toContain('secret');
    expect(res.json().message).toContain('kode referensi');
  });

  it('403 menyebut peran yang dibutuhkan; 404 memakai bentuk standar', async () => {
    expect((await app.inject('/terlarang')).json().message).toContain('perlu peran: keuangan');
    const nf = await app.inject('/tidak-ada?x=1');
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toMatchObject({ success: false, code: 'ROUTE_NOT_FOUND', message: 'Endpoint GET /tidak-ada tidak ditemukan.' });
  });
});
