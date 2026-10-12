import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import bcrypt from 'bcrypt';

// Opt-in: tidak membaca DATABASE_URL lokal/produksi sebagai fallback.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL wajib menunjuk database kosong prsi_test_* pada loopback.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !target.pathname.startsWith('/prsi_test_')) {
  throw new Error('Tes integrasi hanya diizinkan pada database prsi_test_* lokal.');
}

test('backend integration with real PostgreSQL', async (t) => {
  const sql = postgres(url, { prepare: false });
  let app;
  let closeDatabase;
  try {
    const [{ exists }] = await sql`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance') AS exists`;
    assert.equal(exists, false, 'Gunakan database kosong baru; tes tidak menghapus data yang sudah ada.');
    await sql`CREATE SCHEMA finance`;
    await migrate(drizzle(sql), { migrationsFolder: './drizzle', migrationsSchema: 'finance' });
    Object.assign(process.env, {
      DATABASE_URL: url, REPORT_DATABASE_URL: url, SESSION_DATABASE_URL: url,
      JWT_SECRET: 'integration-only-jwt-secret-32-characters',
      COOKIE_SECRET: 'integration-only-cookie-secret-32-characters',
      NODE_ENV: 'production', API_URL: 'https://api.example.test', FRONTEND_URL: 'https://fe.example.test',
      CORS_ALLOW_ALL: 'true', SYNC_ENABLED: 'false', SYNC_WRITE_ENABLED: 'false', ALLOW_UNSAFE_DB_ROLE: 'false',
    });
    delete process.env.PRSI_MONITOR_TOKEN;
    process.env.UPLOAD_DIR = await mkdtemp(path.resolve('storage/integration-'));
    ({ closeDatabase } = await import('../src/config/database.js'));
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false, documentationOnly: true });
    await app.ready();
    const password = 'TestOnlyPassword123';
    const hash = await bcrypt.hash(password, 4);
    const userId = randomUUID();
    await sql`INSERT INTO finance.users (id, nama, email, password_hash, role) VALUES (${userId}, 'Tester', 'tester@example.test', ${hash}, 'keuangan')`;
    const login = async () => {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'tester@example.test', password } });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().data;
    };
    let tokens = await login();
    const call = async (method, route, payload, expected = 200) => {
      const response = await app.inject({ method, url: `/api/v1${route}`, headers: { authorization: `Bearer ${tokens.accessToken}` }, ...(payload === undefined ? {} : { payload }) });
      assert.equal(response.statusCode, expected, `${method} ${route}: ${response.body}`);
      return response.json().data;
    };
    const companies = [randomUUID(), randomUUID()];
    const projects = [randomUUID(), randomUUID()];
    const units = [randomUUID(), randomUUID()];
    for (let i = 0; i < 2; i++) {
      await sql`INSERT INTO finance.trk_companies (id, track_id, nama) VALUES (${companies[i]}, ${randomUUID()}, ${`Company ${i}`})`;
      await sql`INSERT INTO finance.trk_projects (id, track_id, nama, company_id) VALUES (${projects[i]}, ${randomUUID()}, ${`Project ${i}`}, ${companies[i]})`;
      const cluster = randomUUID();
      await sql`INSERT INTO finance.trk_clusters (id, track_id, project_id, nama) VALUES (${cluster}, ${randomUUID()}, ${projects[i]}, 'Cluster')`;
      await sql`INSERT INTO finance.trk_units (id, track_id, cluster_id, project_id, kode) VALUES (${units[i]}, ${randomUUID()}, ${cluster}, ${projects[i]}, ${`A${i}`})`;
    }
    const accounts = [randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < 3; i++) {
      await sql`INSERT INTO finance.akun (id, kode, nama, kategori, tipe_saldo, klasifikasi, is_kas_bank) VALUES (${accounts[i]}, ${`10${i}`}, ${`Account ${i}`}, ${i === 2 ? 'hutang' : 'aktiva'}, ${i === 2 ? 'k' : 'd'}, 'neraca', ${i === 0})`;
    }
    let pts;
    await t.test('company mapping rejects duplicates/mismatches and preserves SI legal fields', async () => {
      pts = [];
      for (let i = 0; i < 2; i++) pts.push(await call('POST', '/master-pt', { namaPt: `PT ${i}`, namaDirektur: 'Direktur', ttl: 'Bandung', pekerjaan: 'Direktur', alamat: 'Alamat SI', noKtp: '1234567890123456', perumahanId: projects[i], trackCompanyId: companies[i] }, 201));
      const list = await call('GET', '/master-pt/companies');
      assert.equal(list.length, 2);
      assert.equal(pts[0].trackCompanyId, companies[0]);
      await call('POST', '/master-pt', { namaPt: 'Duplicate', namaDirektur: 'Direktur', trackCompanyId: companies[0] }, 409);
      await call('PATCH', `/master-pt/${pts[0].id}`, { trackCompanyId: companies[1] }, 409);
      await call('PATCH', `/master-pt/${pts[1].id}`, { trackCompanyId: null });
      await call('PATCH', `/master-pt/${pts[0].id}`, { trackCompanyId: companies[1] }, 422);
      await call('PATCH', `/master-pt/${pts[1].id}`, { trackCompanyId: companies[1] });
      await call('POST', '/master-pt', { namaPt: 'Mismatch', namaDirektur: 'Direktur', perumahanId: projects[0], trackCompanyId: randomUUID() }, 409);
      const updated = await call('PATCH', `/master-pt/${pts[0].id}`, { singkatan: 'PTA' });
      assert.equal(updated.alamat, 'Alamat SI');
      assert.equal(updated.noKtp, '1234567890123456');
      const { applyChange } = await import('../src/sync/apply.js');
      const { db } = await import('../src/config/database.js');
      const [company] = await sql`SELECT track_id FROM finance.trk_companies WHERE id = ${companies[0]}`;
      await db.transaction((tx) => applyChange(tx, { entity: 'companies', trackId: company.track_id, op: 'U', rowVersion: 1, payload: { nama_pt: 'Track renamed', kode_pt: 'T', alamat: 'Alamat Track' } }));
      const afterSync = await call('GET', `/master-pt/${pts[0].id}`);
      assert.equal(afterSync.namaPt, 'PT 0');
      assert.equal(afterSync.alamat, 'Alamat SI');
      assert.equal(afterSync.namaDirektur, 'Direktur');
      // Database constraint juga menahan pemetaan ganda di luar API.
      await assert.rejects(sql`INSERT INTO finance.master_pt (nama_pt, nama_direktur, track_company_id) VALUES ('Dupe', 'Director', ${companies[0]})`, { code: '23505' });
    });
    const rows = [{ akunId: accounts[0], debit: 100, kredit: 0 }, { akunId: accounts[2], debit: 0, kredit: 100 }];
    await t.test('concurrent company mapping has one winner and a 409 loser', async () => {
      const company = randomUUID();
      await sql`INSERT INTO finance.trk_companies (id, track_id, nama) VALUES (${company}, ${randomUUID()}, 'Concurrent Company')`;
      const results = await Promise.all([1, 2].map((i) => app.inject({ method: 'POST', url: '/api/v1/master-pt', headers: { authorization: `Bearer ${tokens.accessToken}` }, payload: { namaPt: `Concurrent PT ${i}`, namaDirektur: 'Director', trackCompanyId: company } })));
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    });
    const upload = async (journal) => {
      const boundary = 'audit-test-boundary';
      const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="proof.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n%%EOF\r\n--${boundary}--\r\n`);
      const response = await app.inject({ method: 'POST', url: `/api/v1/lampiran?entityType=jurnal&entityId=${journal}`, headers: { authorization: `Bearer ${tokens.accessToken}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
      assert.equal(response.statusCode, 201, response.body);
      return response.json().data;
    };
    await t.test('journal → upload → posting, immutable evidence and balanced ledger', async () => {
      const j = await call('POST', '/jurnal', { tanggal: '2026-10-10', keterangan: 'Integration', proyekId: projects[0], status: 'draft', rows }, 201);
      await call('POST', `/jurnal/${j.id}/posting`, undefined, 422);
      const file = await upload(j.id);
      const posted = await call('POST', `/jurnal/${j.id}/posting`);
      assert.equal(posted.status, 'diposting');
      assert.equal(posted.totalDebit, posted.totalKredit);
      await call('DELETE', `/lampiran/${file.id}`, undefined, 409);
      await call('POST', `/jurnal/${j.id}/posting`, undefined, 409);
      const download = await app.inject({ url: `/api/v1/lampiran/${file.id}/unduh`, headers: { authorization: `Bearer ${tokens.accessToken}` } });
      assert.equal(download.statusCode, 200);
      assert.match(download.body, /%PDF/);
    });
    await t.test('opening balance → close book; rejects unbalanced/locked writes and drafts', async () => {
      await call('PUT', `/saldo-awal/${projects[0]}`, { tanggalMulai: '2026-01-01', saldo: [{ akunId: accounts[0], debit: 100 }] });
      await call('POST', `/saldo-awal/${projects[0]}/kunci`, undefined, 422);
      await call('PUT', `/saldo-awal/${projects[0]}`, { tanggalMulai: '2026-01-01', saldo: rows });
      await call('POST', `/saldo-awal/${projects[0]}/kunci`);
      await call('PUT', `/saldo-awal/${projects[0]}`, { saldo: rows }, 409);
      const draft = await call('POST', '/jurnal', { tanggal: '2026-11-10', keterangan: 'Draft blocks closing', proyekId: projects[0], status: 'draft', rows }, 201);
      await call('POST', '/periode/tutup', { ptId: pts[0].id, bulan: '2026-11' }, 422);
      await call('DELETE', `/jurnal/${draft.id}`);
      await call('POST', '/periode/tutup', { ptId: pts[0].id, bulan: '2026-11' });
      await call('POST', '/jurnal', { tanggal: '2026-11-10', keterangan: 'Closed', proyekId: projects[0], status: 'draft', rows }, 422);
      await call('POST', '/periode/tutup', { ptId: pts[0].id, bulan: '2026-11' }, 409);
    });
    await t.test('historical reports exclude future opening balances and ledger includes opening date', async () => {
      const before = await call('GET', `/laporan/saldo-akun?proyekId=${projects[0]}&sampai=2025-12-31`);
      assert.equal(before.length, 0);
      const initial = await app.inject({ url: `/api/v1/laporan/buku-besar?proyekId=${projects[0]}&akunId=${accounts[0]}&dari=2026-01-01&sampai=2026-01-31`, headers: { authorization: `Bearer ${tokens.accessToken}` } });
      assert.equal(initial.statusCode, 200, initial.body);
      assert.equal(initial.json().meta.saldoAwal, 0);
      assert.equal(initial.json().meta.saldoAkhir, 100);
      assert.equal(initial.json().data[0].sumber, 'saldo_awal');
      await call('GET', `/laporan/buku-besar?akunId=${accounts[0]}&dari=2026-11-01&sampai=2026-10-01`, undefined, 422);
      await call('GET', `/laporan/saldo-kode-pembantu?proyekId=${projects[0]}&bulan=2026-10`);
    });
    await t.test('concurrent closing and journal creation cannot leave a draft in a locked month', async () => {
      const headers = { authorization: `Bearer ${tokens.accessToken}` };
      const [created, closed] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/v1/jurnal', headers, payload: { tanggal: '2026-12-10', keterangan: 'Closing race', proyekId: projects[0], status: 'draft', rows } }),
        app.inject({ method: 'POST', url: '/api/v1/periode/tutup', headers, payload: { ptId: pts[0].id, bulan: '2026-12' } }),
      ]);
      assert.ok((created.statusCode === 201 && closed.statusCode === 422) || (created.statusCode === 422 && closed.statusCode === 200), `${created.body} / ${closed.body}`);
    });
    await t.test('contract → amendment → payment draft → upload → posting', async () => {
      const input = { noSpk: 'SPK-TEST', proyekId: projects[0], unitId: units[0], tanggalSpk: '2026-10-10', namaKontraktor: 'Test Contractor', rab: 1000, nilaiKontrak: 1000, akunPersediaanId: accounts[1], akunHutangId: accounts[2] };
      await call('POST', '/kontrak', { ...input, unitId: units[1] }, 422);
      const k = await call('POST', '/kontrak', input, 201);
      const changed = await call('POST', `/kontrak/${k.id}/adendum`, { noAdendum: 'ADD-TEST', tanggal: '2026-10-10', nilaiBaru: 1200, alasan: 'Tambahan' }, 201);
      assert.equal(changed.nilaiTerkini, 1200);
      const paid = await call('POST', `/kontrak/${k.id}/pembayaran`, { tanggal: '2026-10-10', nominal: 100, akunKasId: accounts[0] }, 201);
      const payment = paid.pembayarans.at(-1);
      assert.equal(payment.jurnalStatus, 'draft');
      assert.equal(paid.sisaDapatDibayar, 1100);
      assert.equal(paid.sisaHutang, 1200);
      await upload(payment.jurnalId);
      await call('POST', `/jurnal/${payment.jurnalId}/posting`);
      const after = await call('GET', `/kontrak/${k.id}`);
      assert.equal(after.totalDibayar, 100);
      assert.equal(after.sisaHutang, 1100);
    });
    await t.test('legal draft rejects PT/unit mismatch and finalization without assignment', async () => {
      const input = { ptId: pts[0].id, kavlingId: units[0], tipeTransaksi: 'Cash', tanggalPerjanjian: '2026-10-10', pembeli: { nama: 'Buyer' }, hargaAwal: 1000 };
      await call('POST', '/dokumen', { ...input, kavlingId: units[1] }, 422);
      const d = await call('POST', '/dokumen', input, 201);
      await call('POST', `/dokumen/${d.id}/finalisasi`, undefined, 422);
      const after = await call('GET', `/dokumen/${d.id}`);
      assert.equal(after.status, 'draft');
    });
    await t.test('legal finalization → receivable/schedule/outbox → amendment', async () => {
      const customer = randomUUID();
      const assignment = randomUUID();
      await sql`INSERT INTO finance.trk_customers (id, track_id, nama) VALUES (${customer}, ${randomUUID()}, 'Integration Buyer')`;
      await sql`INSERT INTO finance.trk_assignments (id, track_id, unit_id, customer_id, tipe_pembayaran, harga, uang_muka) VALUES (${assignment}, ${randomUUID()}, ${units[0]}, ${customer}, 'cash_lunas', 1000, 100)`;
      await sql`INSERT INTO finance.akun_sistem (kunci, akun_id) VALUES ('titipan_booking_fee', ${accounts[2]})`;
      const d = await call('POST', '/dokumen', { ptId: pts[0].id, kavlingId: units[0], assignmentId: assignment, tanggalPerjanjian: '2026-10-10', hargaAwal: 1000, uangMuka: 100 }, 201);
      await call('PUT', `/dokumen/${d.id}/jadwal`, { tanggalAcuan: 10, nominalPerBulan: 100, tanggalMulai: '2026-10-01', jatuhTempoTerakhir: '2026-10-31' });
      assert.equal((await call('POST', `/dokumen/${d.id}/finalisasi`)).status, 'final');
      await call('PATCH', `/dokumen/${d.id}`, { hargaAwal: 1200 }, 409);
      const [receivable] = await sql`SELECT * FROM finance.penjualan_keuangan WHERE assignment_id = ${assignment}`;
      assert.equal(receivable.dokumen_id, d.id);
      const [schedule] = await sql`SELECT id FROM finance.jadwal_angsuran WHERE penjualan_id = ${receivable.id}`;
      const [queued] = await sql`SELECT COUNT(*)::int n FROM finance.outbox_track WHERE ref_id = ${schedule.id}`;
      assert.equal(queued.n, 1);
      const adendum = await call('POST', `/dokumen/${d.id}/adendum`, { alasan: 'Perbaikan harga', tanggal: '2026-10-10' }, 201);
      await call('PATCH', `/dokumen/${adendum.id}`, { hargaAwal: 1200 });
      assert.equal((await call('POST', `/dokumen/${adendum.id}/finalisasi`)).status, 'final');
      const [updated] = await sql`SELECT * FROM finance.penjualan_keuangan WHERE id = ${receivable.id}`;
      assert.equal(updated.dokumen_id, adendum.id);
      assert.equal(Number(updated.nilai_sppr), 1200);
    });
    await t.test('SHM status history, duplicate prevention and collateral validation', async () => {
      const input = { nomorShm: 'SHM-TEST', unitId: units[0], status: 'di_kantor', lokasi: 'Kantor' };
      const s = await call('POST', '/shm', input, 201);
      await call('POST', '/shm', input, 409);
      await call('PATCH', `/shm/${s.id}/status`, { keStatus: 'dijaminkan', lokasi: 'Bank' }, 422);
      const after = await call('PATCH', `/shm/${s.id}/status`, { keStatus: 'di_notaris', lokasi: 'Notaris' });
      assert.equal(after.status, 'di_notaris');
      assert.equal(after.riwayat.length, 2);
    });
    await t.test('role matrix and all-project access match owner policy', async () => {
      assert.equal((await call('GET', '/proyek')).length, 2);
      for (const role of ['admin', 'teknisi', 'marketing', 'kontraktor']) {
        await sql`UPDATE finance.users SET role = ${role} WHERE id = ${userId}`;
        for (const route of ['/jurnal', '/dokumen', '/kontrak', '/shm', '/master-pt', '/lampiran']) await call('GET', route, undefined, 403);
      }
      await sql`UPDATE finance.users SET role = 'keuangan' WHERE id = ${userId}`;
    });
    await t.test('CSRF rejects cookie writes even when CORS_ALLOW_ALL is enabled', async () => {
      const cookie = `si_access_token=${tokens.accessToken}`;
      for (const origin of [undefined, 'https://attacker.example.test']) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/jurnal', headers: { cookie, ...(origin ? { origin } : {}) }, payload: { refreshToken: 'bypass-attempt' } });
        assert.equal(response.statusCode, 403);
      }
      const allowed = await app.inject({ method: 'POST', url: '/api/v1/jurnal', headers: { cookie, origin: 'https://fe.example.test' }, payload: {} });
      assert.equal(allowed.statusCode, 400);
      const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/jurnal', headers: { origin: 'https://attacker.example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } });
      assert.equal(preflight.statusCode, 204);
      assert.equal(preflight.headers['access-control-allow-credentials'], 'true');
    });
    await t.test('explicit CORS allowlist supports cookies and rejects other origins', async () => {
      const { env } = await import('../src/config/env.js');
      env.corsAllowAll = false;
      let restricted;
      try {
        restricted = await buildApp({ logger: false, documentationOnly: true });
        const request = (origin) => restricted.inject({ method: 'OPTIONS', url: '/api/v1/jurnal', headers: { origin, 'access-control-request-method': 'POST' } });
        const allowed = await request('https://fe.example.test');
        assert.equal(allowed.statusCode, 204);
        assert.equal(allowed.headers['access-control-allow-origin'], 'https://fe.example.test');
        assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
        assert.equal((await request('https://attacker.example.test')).statusCode, 403);
        assert.equal((await request('https://fe.example.test.attacker.example')).statusCode, 403);
      } finally {
        await restricted?.close();
        env.corsAllowAll = true;
      }
    });
    await t.test('expired JWT and legacy JWT without session cannot authenticate', async () => {
      const claims = app.jwt.decode(tokens.accessToken);
      const expired = app.jwt.sign({ sub: claims.sub, sid: claims.sid, role: claims.role }, { expiresIn: -1 });
      const legacy = app.jwt.sign({ sub: claims.sub, role: claims.role });
      for (const token of [expired, legacy]) assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
    });
    await t.test('parallel refresh has one winner; loser cannot clear cookies; old token fails', async () => {
      const oldRefresh = tokens.refreshToken;
      const result = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: tokens.refreshToken } })));
      assert.deepEqual(result.map((r) => r.statusCode).sort(), [200, 401]);
      assert.equal(result.find((r) => r.statusCode === 401).headers['set-cookie'], undefined);
      tokens = result.find((r) => r.statusCode === 200).json().data;
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: oldRefresh } })).statusCode, 401);
      await call('GET', '/auth/me');
    });
    await t.test('logout invalidates access JWT and rotated refresh', async () => {
      await call('POST', '/auth/logout', { refreshToken: tokens.refreshToken });
      await call('GET', '/auth/me', undefined, 401);
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: tokens.refreshToken } });
      assert.equal(response.statusCode, 401);
      tokens = await login();
    });
    await t.test('password reset invalidates access and refresh', async () => {
      await sql`UPDATE finance.users SET password_hash = ${await bcrypt.hash('ChangedPassword123', 4)} WHERE id = ${userId}`;
      await call('GET', '/auth/me', undefined, 401);
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: tokens.refreshToken } });
      assert.equal(response.statusCode, 401);
      await sql`UPDATE finance.users SET password_hash = ${hash} WHERE id = ${userId}`;
      tokens = await login();
    });
    await t.test('operational deactivation atomically revokes every session; reactivation cannot revive them', async () => {
      const { updateAccountSecurity } = await import('../src/modules/auth/auth.repository.js');
      const second = await login();
      await updateAccountSecurity(userId, { status: 'inactive' });
      const [{ count }] = await sql`SELECT count(*)::int count FROM finance.refresh_tokens WHERE user_id = ${userId}`;
      assert.equal(count, 0);
      await updateAccountSecurity(userId, { status: 'active' });
      for (const token of [tokens, second]) {
        const result = await app.inject({ url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token.accessToken}` } });
        assert.equal(result.statusCode, 401);
      }
      tokens = await login();
    });
    await t.test('disabled user and expired session cannot use access or refresh', async () => {
      await sql`UPDATE finance.users SET status = 'inactive' WHERE id = ${userId}`;
      await call('GET', '/auth/me', undefined, 401);
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: tokens.refreshToken } });
      assert.equal(response.statusCode, 401);
      await sql`UPDATE finance.users SET status = 'active' WHERE id = ${userId}`;
      tokens = await login();
      const claims = app.jwt.decode(tokens.accessToken);
      assert.equal(claims.exp - claims.iat, 900);
      await sql`UPDATE finance.refresh_tokens SET expires_at = now() - interval '1 second' WHERE user_id = ${userId}`;
      await call('GET', '/auth/me', undefined, 401);
    });
  } finally {
    await app?.close();
    await closeDatabase?.();
    await sql.end();
  }
});
