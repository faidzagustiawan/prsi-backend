// src/sync/reconcile.js
//
// Rekonsiliasi harian (RancanganSistem 7.1): bandingkan jumlah baris dan hash
// (track_id:row_version) setiap entitas dengan Track. Bila beda, entitas itu
// ditarik ulang lewat snapshot; baris yang tidak ada lagi di Track ditandai
// is_deleted.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { ENTITIES, ENTITY_ORDER } from './mapping.js';
import { pullSnapshot } from './pull.js';

/** Sama dengan rumus Track: md5(string_agg(id::text || ':' || versi, ',' ORDER BY id::text COLLATE "C")). */
export async function localChecksum(entity) {
  const { table } = ENTITIES[entity];
  const [row] = await db.select({
    count: sql`COUNT(*)::int`,
    hash: sql`COALESCE(md5(string_agg(${table.trackId}::text || ':' || ${table.rowVersion}::text, ',' ORDER BY ${table.trackId}::text COLLATE "C")), md5(''))`,
  }).from(table).where(eq(table.isDeleted, false));
  return { count: row.count, hash: row.hash };
}

export async function reconcile(client, counts) {
  const hasil = [];
  for (const entity of ENTITY_ORDER) {
    const [remote, local] = await Promise.all([client.checksum(entity), localChecksum(entity)]);
    if (remote.count === local.count && remote.hash === local.hash) {
      hasil.push({ entity, cocok: true, count: local.count });
      continue;
    }
    const { seen } = await pullSnapshot(client, entity, counts);
    const { table } = ENTITIES[entity];
    const localRows = await db.select({ trackId: table.trackId }).from(table).where(eq(table.isDeleted, false));
    const hilang = localRows.map((r) => r.trackId).filter((id) => !seen.has(id));
    if (hilang.length) {
      await db.update(table).set({ isDeleted: true, syncedAt: new Date() }).where(and(inArray(table.trackId, hilang), eq(table.isDeleted, false)));
    }
    const after = await localChecksum(entity);
    hasil.push({
      entity, cocok: false, diperbaiki: after.count === remote.count && after.hash === remote.hash,
      track: remote.count, siSebelum: local.count, ditandaiHapus: hilang.length,
    });
  }
  return hasil;
}
