// Contract test fungsi finance.track_* terhadap database sungguhan.
// Mendeteksi perubahan schema Track yang merusak SI SEBELUM sampai ke pengguna.
//
// Hanya jalan bila CONTRACT_DATABASE_URL di-set (role si_app, sebaiknya di Neon branch):
//   CONTRACT_DATABASE_URL=postgresql://si_app:...@.../neondb npm test
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

const url = process.env.CONTRACT_DATABASE_URL;

describe.skipIf(!url)('kontrak finance.track_*', () => {
  let sql;
  let companyId;

  beforeAll(async () => {
    sql = postgres(url, { prepare: false, max: 1 });
    const [company] = await sql`SELECT id FROM finance.track_companies() LIMIT 1`;
    companyId = company?.id;
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('track_companies()', async () => {
    await expect(sql`SELECT * FROM finance.track_companies() LIMIT 1`).resolves.toBeDefined();
  });

  it('track_units(company_id)', async () => {
    if (!companyId) return;
    await expect(sql`SELECT * FROM finance.track_units(${companyId}::uuid) LIMIT 1`).resolves.toBeDefined();
  });

  it('track_assignments(company_id)', async () => {
    if (!companyId) return;
    await expect(sql`SELECT * FROM finance.track_assignments(${companyId}::uuid) LIMIT 1`).resolves.toBeDefined();
  });

  it('track_payments_since(company_id, since, limit)', async () => {
    if (!companyId) return;
    await expect(
      sql`SELECT * FROM finance.track_payments_since(${companyId}::uuid, '1970-01-01'::timestamptz, 1)`
    ).resolves.toBeDefined();
  });

  it('role runtime tidak bisa membaca tabel Track langsung', async () => {
    await expect(sql`SELECT id FROM public.users LIMIT 1`).rejects.toThrow(/permission denied/);
  });
});
