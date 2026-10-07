// PostgreSQL performs normalization so numeric precision, jsonb rendering and
// timestamp microseconds are preserved. Never convert payloads through JS Number.
export const FIELDS = {
  companies: [['nama_pt'], ['kode_pt'], ['alamat']],
  projects: [['company_id'], ['nama_proyek'], ['status']],
  clusters: [['project_id'], ['nama_cluster']],
  units: [['cluster_id'], ['nomor_unit'], ['tipe_rumah'], ['luas_tanah', 'numeric'], ['luas_bangunan', 'numeric'], ['status_pembangunan']],
  customers: [['nama'], ['email'], ['nomor_telepon']],
  assignments: [['user_id'], ['unit_id'], ['tipe_pembayaran'], ['harga_total', 'numeric'], ['dp', 'numeric'], ['status_kepemilikan'], ['tanggal_pembelian', 'date']],
  payments: [['assignment_id'], ['jumlah_bayar', 'numeric'], ['tanggal_bayar', 'date'], ['catatan'], ['bukti_pembayaran'], ['is_auto_inject', 'boolean'], ['created_at', 'timestamp'], ['jenis'], ['status_verifikasi'], ['rekening_tujuan'], ['diverifikasi_oleh'], ['diverifikasi_pada', 'timestamp']],
};

export function normalized(field, type = 'text') {
  const value = `raw->>'${field}'`;
  const conversions = {
    numeric: `trim_scale((${value})::numeric)::text`,
    boolean: `(${value})::boolean::text`,
    timestamp: `to_char((${value})::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    date: `to_char((${value})::date, 'YYYY-MM-DD')`,
    text: `CASE WHEN jsonb_typeof(raw->'${field}') = 'number' THEN trim_scale((${value})::numeric)::text WHEN jsonb_typeof(raw->'${field}') = 'boolean' THEN (${value})::boolean::text WHEN jsonb_typeof(raw->'${field}') IN ('array','object') THEN (raw->'${field}')::text ELSE ${value} END`,
  };
  return `COALESCE(${conversions[type]}, E'\\\\N')`;
}

// Baris uji yang ditanam langsung di PRSI (raw.dummy, database/seed/dummy-*) tidak
// berasal dari Track, jadi dikeluarkan dari pembanding. Payload Track tidak
// pernah membawa kunci "dummy".
export function checksumSql(entity) {
  if (!Object.hasOwn(FIELDS, entity)) throw new Error('Unknown entity');
  const values = FIELDS[entity].map(([field, type]) => normalized(field, type));
  return `SELECT count(*)::int AS count,
    coalesce(md5(string_agg(track_id::text || ':' || row_version::text, ',' ORDER BY track_id::text COLLATE "C")), md5('')) AS hash,
    coalesce(md5(string_agg(track_id::text || ':' || md5(track_id::text || '|' || ${values.join(" || '|' || ")}), ',' ORDER BY track_id::text COLLATE "C")), md5('')) AS content_hash
    FROM finance.trk_${entity} WHERE is_deleted = false AND raw->>'dummy' IS NULL`;
}

export async function checksum(client, entity) {
  // Cursor and aggregate must describe the same snapshot; never call getCursor(),
  // which inserts a cursor row and therefore isn't read-only.
  return client.begin('isolation level repeatable read read only', async (tx) => {
    await tx`SET LOCAL statement_timeout = '15s'`;
    await tx`SET LOCAL TIME ZONE 'UTC'`;
    const [result] = await tx.unsafe(checksumSql(entity));
    const [state] = await tx`SELECT cursor_txid::text, cursor_seq::text, gap_since IS NOT NULL AS held FROM finance.sync_cursor WHERE id = 'global'`;
    return { ...result, cursor: state ? `${state.cursor_txid ?? '0'}:${state.cursor_seq}` : null, held: state?.held ?? false };
  });
}
