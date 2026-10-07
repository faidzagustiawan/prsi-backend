import { it, expect } from 'vitest';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { INVARIANTS, mirrorInvariantSql } from '../src/monitoring/invariants.js';
import { ENTITIES } from '../src/sync/mapping.js';
import { getTableColumns } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { checksumSql } from '../src/monitoring/checksum.js';

it.runIf(process.env.MONITOR_TEST_DB === 'local')('executes invariant and normalization fixtures in local PostgreSQL temporary tables', async () => {
  dotenv.config({ quiet: true });
  const url = new URL(process.env.DATABASE_URL);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.pathname !== '/podorukun_si_dev') throw new Error('Only local dev DB permitted');
  const client = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      await tx`SET LOCAL TIME ZONE 'UTC'`;
      const definitions = {
        jurnal: 'id int, status text, tanggal date, proyek_id int, pt_id int, diposting_pada timestamptz, updated_at timestamptz, ref_type text, ref_id int, dibalik_oleh_id int',
        jurnal_detail: 'id int, jurnal_id int, debit numeric, kredit numeric',
        saldo_awal_periode: 'id int, proyek_id int, tanggal_mulai date, status text',
        saldo_awal: 'periode_id int, debit numeric, kredit numeric',
        periode: 'pt_id int, tahun int, bulan int, status text, ditutup_pada timestamptz',
        status_pembayaran_si: 'payment_id int, jurnal_id int, status_proses text, updated_at timestamptz',
        trk_payments: 'id int, nominal numeric',
        alokasi_pembayaran: 'payment_id int, nominal numeric',
        trk_companies: 'track_id uuid, row_version bigint, is_deleted boolean, raw jsonb, nama text, kode text, alamat text',
      };
      for (const [table, columns] of Object.entries(definitions)) await tx.unsafe(`CREATE TEMP TABLE ${table} (${columns}) ON COMMIT DROP`);
      const count = async (name) => Number((await tx.unsafe(INVARIANTS[name].replaceAll('finance.', 'pg_temp.')))[0].count);
      for (const name of Object.keys(INVARIANTS)) expect(await count(name)).toBe(0);
      await tx`INSERT INTO jurnal VALUES (1,'diposting','2026-01-01',1,1,'2026-01-02','2026-01-02','trk_payments',1,NULL)`;
      await tx`INSERT INTO jurnal_detail VALUES (1,1,10,0),(2,1,0,10)`;
      await tx`INSERT INTO periode VALUES (1,2026,1,'terkunci','2026-02-01')`;
      expect(await count('journal_unbalanced')).toBe(0);
      expect(await count('journal_after_period_closed')).toBe(0);
      await tx`UPDATE jurnal_detail SET debit=11 WHERE id=1`;
      expect(await count('journal_unbalanced')).toBe(1);
      expect(await count('trial_balance_unbalanced')).toBe(1);
      await tx`UPDATE jurnal SET diposting_pada='2026-02-02'`;
      expect(await count('journal_after_period_closed')).toBe(1);
      await tx`INSERT INTO status_pembayaran_si VALUES (1,1,'dijurnal',now()),(2,NULL,'dijurnal',now()),(3,NULL,'perlu_ditinjau',now()-interval '8 days')`;
      expect(await count('payment_without_valid_journal')).toBe(2);
      expect(await count('review_older_than_seven_days')).toBe(1);
      await tx`INSERT INTO trk_payments VALUES (1,10)`;
      await tx`INSERT INTO alokasi_pembayaran VALUES (1,6),(1,5)`;
      expect(await count('allocation_exceeds_payment')).toBe(1);
      await tx`INSERT INTO jurnal SELECT 2,status,tanggal,proyek_id,pt_id,diposting_pada,updated_at,ref_type,ref_id,dibalik_oleh_id FROM jurnal WHERE id=1`;
      expect(await count('duplicate_payment_journal')).toBe(1);
      const id='00000000-0000-4000-8000-000000000001';
      await tx`INSERT INTO trk_companies VALUES (${id},1,false,'{"nama_pt":" Acme ","kode_pt":null}', 'Acme',null,null)`;
      const mirror=mirrorInvariantSql('companies').replaceAll('finance.','pg_temp.');
      expect(Number((await tx.unsafe(mirror))[0].count)).toBe(0);
      await tx`UPDATE trk_companies SET nama='wrong'`;
      expect(Number((await tx.unsafe(mirror))[0].count)).toBe(1);
      const checksum=checksumSql('companies').replaceAll('finance.','pg_temp.');
      const [actual]=await tx.unsafe(checksum);
      const md5 = (value) => createHash('md5').update(value).digest('hex');
      expect(actual.content_hash).toBe(md5(`${id}:${md5(`${id}| Acme |\\N|\\N`)}`));
      await tx`INSERT INTO trk_companies VALUES ('00000000-0000-4000-8000-000000000002',1,false,'{"dummy":"seed","nama_pt":"Uji"}','Uji',null,null)`;
      expect((await tx.unsafe(checksum))[0]).toMatchObject({ count: 1, content_hash: actual.content_hash });
      await tx`UPDATE trk_companies SET is_deleted=true`;
      expect((await tx.unsafe(checksum))[0].content_hash).toBe('d41d8cd98f00b204e9800998ecf8427e');
    });
  } finally { await client.end(); }
}, 30_000);

it.runIf(process.env.MONITOR_TEST_DB === 'local')('checks every typed mirror using the real dev schema and mapping, with rollback-only synthetic rows', async () => {
  dotenv.config({ quiet: true });
  const url = new URL(process.env.DATABASE_URL);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.pathname !== '/podorukun_si_dev') throw new Error('Only local dev DB permitted');
  const client = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const rollback = new Error('fixture rollback');
  try {
    await expect(client.begin(async tx => {
      await tx`SET LOCAL TIME ZONE 'UTC'`;
      // Queries must compile against actual installed finance schema before using fixtures.
      for (const entity of Object.keys(ENTITIES)) await tx.unsafe('EXPLAIN '+mirrorInvariantSql(entity));
      for (const query of Object.values(INVARIANTS)) await tx.unsafe('EXPLAIN '+query);
      const local = Object.fromEntries(Object.keys(ENTITIES).map(e=>[e,randomUUID()]));
      const track = Object.fromEntries(Object.keys(ENTITIES).map(e=>[e,randomUUID()]));
      const raw = {
        companies:{nama_pt:'\t Example \n',kode_pt:'TEST',alamat:null},
        projects:{company_id:track.companies,nama_proyek:'Example',status:'active'},
        clusters:{project_id:track.projects,nama_cluster:'Example'},
        units:{cluster_id:track.clusters,nomor_unit:'A1',tipe_rumah:null,luas_tanah:'10.00',luas_bangunan:'5.50',status_pembangunan:null},
        customers:{nama:'Example',email:null,nomor_telepon:null},
        assignments:{user_id:track.customers,unit_id:track.units,tipe_pembayaran:'cash_lunas',harga_total:'1500000.50',dp:'10.00',status_kepemilikan:null,tanggal_pembelian:'2026-10-05'},
        payments:{assignment_id:track.assignments,jumlah_bayar:'10.50',tanggal_bayar:'2026-10-05',bukti_pembayaran:['https://example.invalid/a'],is_auto_inject:false,created_at:'2026-10-05T15:04:05.123456+07:00',diverifikasi_pada:'2026-10-05T15:04:05.654321+07:00'},
      };
      for (const [entity,def] of Object.entries(ENTITIES)) {
        await tx.unsafe(`CREATE TEMP TABLE trk_${entity} (LIKE finance.trk_${entity} INCLUDING DEFAULTS) ON COMMIT DROP`);
        const parents=Object.fromEntries(Object.entries(def.parents).map(([key,parent])=>[key,local[parent]]));
        const row={id:local[entity],trackId:track[entity],rowVersion:1,isDeleted:false,...def.toRow(def.schema.parse(raw[entity]),parents,{projectId:local.projects})};
        const columns=getTableColumns(def.table);
        const entries=Object.entries(row);
        const names=entries.map(([key])=>columns[key].name);
        const values=entries.map(([,value])=>value instanceof Date?value.toISOString():value);
        await tx.unsafe(`INSERT INTO pg_temp.trk_${entity} (${names.join(',')},raw) VALUES (${values.map((_,i)=>'$'+(i+1)).join(',')},$${values.length+1}::text::jsonb)`,[...values,JSON.stringify(raw[entity])]);
      }
      await tx`UPDATE pg_temp.trk_payments SET bukti_url='not json'`;
      expect(Number((await tx.unsafe(mirrorInvariantSql('payments').replaceAll('finance.','pg_temp.')))[0].count)).toBe(1);
      await tx`UPDATE pg_temp.trk_payments SET bukti_url='["https://example.invalid/a"]'`;
      for (const entity of Object.keys(ENTITIES)) {
        const query=mirrorInvariantSql(entity).replaceAll('finance.','pg_temp.');
        expect(Number((await tx.unsafe(query))[0].count),entity).toBe(0);
        await tx.unsafe(`UPDATE pg_temp.trk_${entity} SET raw='{}'::jsonb`);
        expect(Number((await tx.unsafe(query))[0].count),entity+' detects drift').toBe(1);
      }
      throw rollback;
    })).rejects.toBe(rollback);
  } finally {await client.end();}
},30_000);
