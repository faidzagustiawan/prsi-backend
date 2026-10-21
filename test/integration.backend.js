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
    await t.test('legacy Track payments rejected by journal rules do not stop the batch', async () => {
      // Proyek 0: saldo awal mulai 2026-01-01 dan periode 2026-11 sudah ditutup di tes sebelumnya.
      await sql`UPDATE finance.akun SET no_rekening = '9900-1' WHERE id = ${accounts[0]}`;
      await sql`INSERT INTO finance.akun_sistem (kunci, akun_id) VALUES ('uang_muka_penjualan', ${accounts[2]}) ON CONFLICT DO NOTHING`;
      const [{ id: assignment }] = await sql`SELECT id FROM finance.trk_assignments WHERE unit_id = ${units[0]} LIMIT 1`;
      const payment = async (tanggal, statusVerifikasi) => {
        const id = randomUUID();
        await sql`INSERT INTO finance.trk_payments (id, track_id, assignment_id, tanggal, nominal, jenis, status_verifikasi, rekening_tujuan, bukti_url)
          VALUES (${id}, ${randomUUID()}, ${assignment}, ${tanggal}, 50, 'uang_muka', ${statusVerifikasi}, '99001', 'https://evidence.example.test/a.jpg')`;
        return id;
      };
      const beforeOpening = await payment('2025-12-15', 'terverifikasi');
      const closedPeriod = await payment('2026-11-05', 'terverifikasi');
      const later = await payment('2026-12-01', null);
      const result = await call('POST', '/pembayaran-track/proses');
      assert.equal(result.gagal_validasi, 2);
      const status = async (id) => (await sql`SELECT status_proses, alasan, jurnal_id FROM finance.status_pembayaran_si WHERE payment_id = ${id}`)[0];
      const opening = await status(beforeOpening);
      assert.equal(opening.status_proses, 'gagal_validasi');
      assert.match(opening.alasan, /saldo awal/);
      assert.equal(opening.jurnal_id, null);
      const closed = await status(closedPeriod);
      assert.equal(closed.status_proses, 'gagal_validasi');
      assert.match(closed.alasan, /dikunci/);
      assert.equal((await status(later)).status_proses, 'menunggu', 'payments after a rejected one are still processed');
      const [{ n }] = await sql`SELECT count(*)::int n FROM finance.jurnal WHERE ref_type = 'trk_payments' AND ref_id IN (${beforeOpening}, ${closedPeriod})`;
      assert.equal(n, 0);
      // Tidak dipilih ulang otomatis; proses ulang manual tetap memberi alasan yang sama tanpa error 422.
      assert.equal((await call('POST', '/pembayaran-track/proses')).diproses, 0);
      assert.equal((await call('POST', `/pembayaran-track/${closedPeriod}/proses`)).statusProses, 'gagal_validasi');
    });
    await t.test('option A cutoff: old payments become historis, backdated input is reviewed, legacy is held without cutover', async () => {
      const { env } = await import('../src/config/env.js');
      const [{ id: assignment }] = await sql`SELECT id FROM finance.trk_assignments WHERE unit_id = ${units[0]} LIMIT 1`;
      const payment = async (tanggal, createdAt, nominal = 50) => {
        const id = randomUUID();
        await sql`INSERT INTO finance.trk_payments (id, track_id, assignment_id, tanggal, nominal, jenis, status_verifikasi, rekening_tujuan, source_created_at)
          VALUES (${id}, ${randomUUID()}, ${assignment}, ${tanggal}, ${nominal}, 'uang_muka', 'terverifikasi', NULL, ${createdAt})`;
        return id;
      };
      const status = async (id) => (await sql`SELECT status_proses, alasan, jurnal_id FROM finance.status_pembayaran_si WHERE payment_id = ${id}`)[0];
      const saved = { billing: env.billingEnabled, cutover: env.legacyCutoverAt };
      try {
        // Billing aktif tanpa waktu cutover: pembayaran tanpa tagihan tidak disentuh.
        env.billingEnabled = true; env.legacyCutoverAt = null;
        const held = await payment('2025-10-01', '2025-10-01T03:00:00Z');
        const heldRun = await call('POST', '/pembayaran-track/proses');
        assert.equal(await status(held), undefined, 'legacy payment stays unprocessed while cutover is not configured');
        assert.equal(heldRun.historis, 0);
        await call('POST', `/pembayaran-track/${held}/proses`, undefined, 409);
        assert.equal(await status(held), undefined, 'manual processing is refused, not marked failed');

        env.legacyCutoverAt = new Date('2026-10-21T00:00:00+07:00');
        const backdated = await payment('2025-11-02', '2026-10-22T02:00:00Z');
        const refund = await payment('2025-11-03', '2025-11-03T02:00:00Z', -20);
        const run = await call('POST', '/pembayaran-track/proses');
        assert.equal(run.historis, 1);

        const historis = await status(held);
        assert.equal(historis.status_proses, 'historis');
        assert.equal(historis.jurnal_id, null);
        assert.match(historis.alasan, /saldo awal/);
        const [{ n: journals }] = await sql`SELECT count(*)::int n FROM finance.jurnal WHERE ref_type = 'trk_payments' AND ref_id = ${held}`;
        assert.equal(journals, 0);
        const [{ total }] = await sql`SELECT coalesce(sum(nominal), 0)::numeric AS total FROM finance.alokasi_pembayaran WHERE payment_id = ${held}`;
        assert.equal(Number(total), 50, 'historical payment is allocated so bills show it as paid');
        const [lock] = await sql`SELECT payload FROM finance.outbox_track WHERE jenis = 'kunci_pembayaran' AND ref_id = ${held}`;
        assert.equal(lock.payload.jurnal, 'SALDO-AWAL');
        const piutang = (await call('GET', '/piutang')).find((x) => x.assignmentId === assignment);
        assert.equal(piutang.totalDibayar, 50, 'receivable counts historical payments as paid');

        assert.equal((await status(backdated)).status_proses, 'perlu_ditinjau');
        assert.match((await status(backdated)).alasan, /sesudah cutover/);
        assert.equal((await status(refund)).status_proses, 'perlu_ditinjau');

        // Data produksi: pembayaran lama tanpa status verifikasi dan tanpa jenis tetap historis;
        // yang ditolak di Track tidak ikut.
        const unverified = randomUUID();
        const rejected = randomUUID();
        await sql`INSERT INTO finance.trk_payments (id, track_id, assignment_id, tanggal, nominal, jenis, status_verifikasi, source_created_at)
          VALUES (${unverified}, ${randomUUID()}, ${assignment}, '2025-11-04', 15, NULL, 'menunggu', '2026-07-14T04:04:04Z'),
                 (${rejected}, ${randomUUID()}, ${assignment}, '2025-11-05', 25, 'uang_muka', 'ditolak', '2026-07-14T04:04:04Z')`;
        await call('POST', '/pembayaran-track/proses');
        assert.equal((await status(unverified)).status_proses, 'historis');
        const [{ total: unverifiedAlloc }] = await sql`SELECT coalesce(sum(nominal), 0)::numeric AS total FROM finance.alokasi_pembayaran WHERE payment_id = ${unverified} AND jadwal_id IS NOT NULL`;
        assert.equal(Number(unverifiedAlloc), 15, 'missing kind is treated as down payment and allocated to the schedule');
        assert.equal((await status(rejected)).status_proses, 'menunggu');

        // Unchanged rows are not reprocessed; a change in Track after the cutoff is flagged.
        assert.equal((await call('POST', '/pembayaran-track/proses')).diproses, 0);
        await sql`UPDATE finance.trk_payments SET nominal = 60, synced_at = now() + interval '1 second' WHERE id = ${held}`;
        await call('POST', '/pembayaran-track/proses');
        assert.equal((await status(held)).status_proses, 'perlu_ditinjau');
        const [{ n: invalid }] = await sql`SELECT count(*)::int n FROM finance.status_pembayaran_si WHERE status_proses = 'historis' AND jurnal_id IS NOT NULL`;
        assert.equal(invalid, 0);
      } finally {
        env.billingEnabled = saved.billing; env.legacyCutoverAt = saved.cutover;
      }
    });
    await t.test('option A: SPPR finalized later allocates historical payments; reconciliation compares with opening balance', async () => {
      const { env } = await import('../src/config/env.js');
      const saved = env.legacyCutoverAt;
      env.legacyCutoverAt = new Date('2026-10-21T00:00:00+07:00');
      try {
        const customer = randomUUID();
        const assignment = randomUUID();
        await sql`INSERT INTO finance.trk_customers (id, track_id, nama) VALUES (${customer}, ${randomUUID()}, 'Historical Buyer')`;
        await sql`INSERT INTO finance.trk_assignments (id, track_id, unit_id, customer_id, tipe_pembayaran, harga, uang_muka) VALUES (${assignment}, ${randomUUID()}, ${units[1]}, ${customer}, 'cash_lunas', 1000, 100)`;
        const [kp] = await sql`INSERT INTO finance.kode_pembantu (kode, nama, kategori, proyek_id, customer_id) VALUES ('PB-HIST-1', 'Historical Buyer', 'pembeli', ${projects[1]}, ${customer}) RETURNING id`;
        // Customer kedua: saldo awal uang muka tanpa pembayaran historis di Track.
        const noTrack = randomUUID();
        await sql`INSERT INTO finance.trk_customers (id, track_id, nama) VALUES (${noTrack}, ${randomUUID()}, 'Opening Only Buyer')`;
        const [kp2] = await sql`INSERT INTO finance.kode_pembantu (kode, nama, kategori, proyek_id, customer_id) VALUES ('PB-HIST-2', 'Opening Only Buyer', 'pembeli', ${projects[1]}, ${noTrack}) RETURNING id`;
        await call('PUT', `/saldo-awal/${projects[1]}`, { tanggalMulai: '2026-01-01', saldo: [
          { akunId: accounts[0], debit: 110 }, { akunId: accounts[2], kodePembantuId: kp.id, kredit: 80 },
          { akunId: accounts[2], kodePembantuId: kp2.id, kredit: 30 },
        ] });

        const paid = randomUUID();
        await sql`INSERT INTO finance.trk_payments (id, track_id, assignment_id, tanggal, nominal, jenis, status_verifikasi, source_created_at)
          VALUES (${paid}, ${randomUUID()}, ${assignment}, '2025-12-01', 80, 'uang_muka', 'terverifikasi', '2025-12-01T03:00:00Z')`;
        // Saldo awal belum dikunci: pembayaran lama proyek ini belum dipilih.
        await call('POST', '/pembayaran-track/proses');
        assert.equal((await sql`SELECT 1 FROM finance.status_pembayaran_si WHERE payment_id = ${paid}`).length, 0);
        await call('POST', `/saldo-awal/${projects[1]}/kunci`);
        await call('POST', '/pembayaran-track/proses');
        const [st] = await sql`SELECT status_proses FROM finance.status_pembayaran_si WHERE payment_id = ${paid}`;
        assert.equal(st.status_proses, 'historis');
        assert.equal((await sql`SELECT 1 FROM finance.alokasi_pembayaran WHERE payment_id = ${paid}`).length, 0, 'no sale yet, nothing to allocate');

        const d = await call('POST', '/dokumen', { ptId: pts[1].id, kavlingId: units[1], assignmentId: assignment, tanggalPerjanjian: '2026-10-10', hargaAwal: 1000, uangMuka: 100 }, 201);
        await call('PUT', `/dokumen/${d.id}/jadwal`, { tanggalAcuan: 10, nominalPerBulan: 100, tanggalMulai: '2026-10-01', jatuhTempoTerakhir: '2026-10-31' });
        assert.equal((await call('POST', `/dokumen/${d.id}/finalisasi`)).status, 'final');
        const [bill] = await sql`SELECT j.id FROM finance.jadwal_angsuran j JOIN finance.penjualan_keuangan p ON p.id = j.penjualan_id WHERE p.assignment_id = ${assignment}`;
        const alloc = await sql`SELECT jadwal_id, nominal::numeric AS nominal FROM finance.alokasi_pembayaran WHERE payment_id = ${paid}`;
        assert.equal(alloc.length, 1);
        assert.equal(alloc[0].jadwal_id, bill.id);
        assert.equal(Number(alloc[0].nominal), 80);
        const [queued] = await sql`SELECT payload FROM finance.outbox_track WHERE jenis = 'jadwal_angsuran' AND ref_id = ${bill.id} ORDER BY sequence DESC LIMIT 1`;
        assert.equal(Number(queued.payload.realisasi), 80, 'bill sent to Track already carries the historical payment');
        const tagihan = await call('GET', `/piutang/${(await sql`SELECT id FROM finance.penjualan_keuangan WHERE assignment_id = ${assignment}`)[0].id}/tagihan`);
        assert.equal(tagihan.items[0].sisa, 20);

        const ok = await call('GET', `/pembayaran-track/rekonsiliasi-historis?proyekId=${projects[1]}`);
        assert.equal(ok.tanggalMulaiSaldoAwal, '2026-01-01');
        assert.equal(ok.tanggalCutover, '2026-10-21');
        assert.equal(ok.tanggalMulaiSamaDenganCutover, false, 'report flags opening balance not aligned with cutover');
        const row = ok.baris.find((b) => b.customerId === customer);
        assert.deepEqual([row.totalHistoris, row.saldoAwalDiterima, row.selisih, row.status], [80, 80, 0, 'cocok']);
        assert.equal(row.historisPerJenis.uang_muka, 80);
        const opening = ok.baris.find((b) => b.customerId === noTrack);
        assert.deepEqual([opening.totalHistoris, opening.saldoAwalDiterima, opening.selisih, opening.status], [0, 30, 30, 'selisih']);
        assert.deepEqual([ok.ringkasan.cocok, ok.ringkasan.selisih], [1, 1]);

        // Proyek 0: input mundur, refund, dan historis yang berubah menunggu keputusan Keuangan.
        const review = await call('GET', `/pembayaran-track/rekonsiliasi-historis?proyekId=${projects[0]}`);
        const pending = review.baris.find((b) => b.namaCustomer === 'Integration Buyer');
        assert.equal(pending.status, 'perlu_ditinjau', 'pending review is never reported as matched');
        assert.equal(pending.perluDitinjau.jumlah, 3);
        await call('GET', `/pembayaran-track/rekonsiliasi-historis?proyekId=${randomUUID()}`, undefined, 404);
      } finally {
        env.legacyCutoverAt = saved;
      }
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
