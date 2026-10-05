import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { FIELDS, normalized } from '../src/monitoring/checksum.js';

it.runIf(process.env.MONITOR_TEST_DB === 'local')('matches the unmodified Track content checksum vectors', async () => {
  dotenv.config({ quiet: true });
  const url = new URL(process.env.DATABASE_URL);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.pathname !== '/podorukun_si_dev') throw new Error('Only local dev DB permitted');
  const { vectors } = JSON.parse(readFileSync(new URL('./fixtures/content-hash-vectors.json', import.meta.url), 'utf8'));
  const client = postgres(url.toString(), { max: 1 });
  const failures = [];
  try {
    await client.begin('read only', async (tx) => {
      await tx`SET LOCAL TIME ZONE 'UTC'`;
      for (const vector of vectors) {
        const fields = FIELDS[vector.entity].map(([field,type]) => normalized(field,type));
        const query = `SELECT md5($2::text || '|' || ${fields.join(" || '|' || ")}) AS hash FROM (SELECT $1::text::jsonb AS raw) input`;
        const [row] = await tx.unsafe(query,[JSON.stringify(vector.row),vector.row.id]);
        if (row.hash !== vector.row_hash) failures.push({entity:vector.entity, id:vector.row.id, track:vector.row_hash, prsi:row.hash});
      }
    });
    expect(failures).toEqual([]);
  } finally { await client.end(); }
}, 30_000);
