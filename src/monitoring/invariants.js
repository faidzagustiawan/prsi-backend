// All queries return counts only. Run in a cached, read-only job, never a scrape.
export const INVARIANTS = {
  journal_unbalanced: `SELECT count(*) FROM (
    SELECT j.id FROM finance.jurnal j LEFT JOIN finance.jurnal_detail d ON d.jurnal_id=j.id
    WHERE j.status IN ('diposting','dikoreksi','balik') GROUP BY j.id
    HAVING count(d.id)<2 OR coalesce(sum(d.debit-d.kredit),0)<>0) q`,
  trial_balance_unbalanced: `WITH movements AS (
    SELECT j.proyek_id, date_trunc('month',j.tanggal) AS month, sum(d.debit-d.kredit) AS balance
    FROM finance.jurnal j JOIN finance.jurnal_detail d ON d.jurnal_id=j.id
    WHERE j.status IN ('diposting','dikoreksi','balik') GROUP BY 1,2
    UNION ALL
    SELECT p.proyek_id,date_trunc('month',p.tanggal_mulai),sum(s.debit-s.kredit)
    FROM finance.saldo_awal_periode p JOIN finance.saldo_awal s ON s.periode_id=p.id
    WHERE p.status='terkunci' GROUP BY 1,2
  ) SELECT count(*) FROM (SELECT proyek_id,month FROM movements GROUP BY 1,2 HAVING sum(balance)<>0) q`,
  journal_after_period_closed: `SELECT count(*) FROM finance.jurnal j JOIN finance.periode p
    ON p.pt_id=j.pt_id AND p.tahun=extract(year FROM j.tanggal) AND p.bulan=extract(month FROM j.tanggal)
    WHERE p.status='terkunci' AND (j.status='draft' OR j.diposting_pada>p.ditutup_pada
    OR (j.status<>'dikoreksi' AND j.updated_at>p.ditutup_pada))`,
  payment_without_valid_journal: `SELECT count(*) FROM finance.status_pembayaran_si s
    LEFT JOIN finance.jurnal j ON j.id=s.jurnal_id
    WHERE s.status_proses='dijurnal' AND (j.id IS NULL OR j.status<>'diposting'
    OR j.ref_type IS DISTINCT FROM 'trk_payments' OR j.ref_id IS DISTINCT FROM s.payment_id
    OR (SELECT count(*) FROM finance.jurnal_detail d WHERE d.jurnal_id=j.id)<2
    OR (SELECT coalesce(sum(d.debit-d.kredit),0) FROM finance.jurnal_detail d WHERE d.jurnal_id=j.id)<>0)`,
  allocation_exceeds_payment: `SELECT count(*) FROM (
    SELECT p.id FROM finance.trk_payments p JOIN finance.alokasi_pembayaran a ON a.payment_id=p.id
    GROUP BY p.id,p.nominal HAVING sum(a.nominal)>p.nominal) q`,
  duplicate_payment_journal: `SELECT count(*) FROM (
    SELECT ref_id FROM finance.jurnal WHERE ref_type='trk_payments' AND status='diposting'
    AND dibalik_oleh_id IS NULL GROUP BY ref_id HAVING count(*)>1) q`,
  review_older_than_seven_days: `SELECT count(*) FROM finance.status_pembayaran_si
    WHERE status_proses='perlu_ditinjau' AND updated_at<now()-interval '7 days'`,
};

// [typed column, raw field, PostgreSQL type]. Text trimmed by the existing
// mapping uses btrim; FK columns compare the parent's Track UUID, not local UUID.
const MIRRORS = {
  companies: [['nama','nama_pt','trim'],['kode','kode_pt'],['alamat','alamat']],
  projects: [['nama','nama_proyek','trim'],['kode','kode'],['status','status'],['company_id','company_id','fk:companies']],
  clusters: [['nama','nama_cluster','trim'],['project_id','project_id','fk:projects']],
  units: [['kode','nomor_unit','trim'],['tipe','tipe_rumah'],['luas_tanah','luas_tanah','numeric'],['luas_bangunan','luas_bangunan','numeric'],['status','status_pembangunan'],['cluster_id','cluster_id','fk:clusters']],
  customers: [['nama','nama','trim'],['email','email'],['no_hp','nomor_telepon'],['tempat_lahir','tempat_lahir'],['tanggal_lahir','tanggal_lahir','date'],['pekerjaan','pekerjaan'],['alamat','alamat'],['no_ktp','no_ktp']],
  assignments: [['unit_id','unit_id','fk:units'],['customer_id','user_id','fk:customers'],['tipe_pembayaran','tipe_pembayaran'],['harga','harga_total','numeric'],['uang_muka','dp','numeric'],['status','status_kepemilikan'],['tanggal','tanggal_pembelian','timestamptz']],
  payments: [['assignment_id','assignment_id','fk:assignments'],['nominal','jumlah_bayar','numeric'],['tanggal','tanggal_bayar','date'],['jenis','jenis'],['status_verifikasi','status_verifikasi'],['diverifikasi_oleh','diverifikasi_oleh'],['diverifikasi_pada','diverifikasi_pada','timestamptz'],['rekening_tujuan','rekening_tujuan'],['catatan','catatan'],['is_auto_inject','is_auto_inject','bool'],['source_created_at','created_at','timestamptz']],
};

export function mirrorInvariantSql(entity) {
  const comparisons = MIRRORS[entity].map(([column, field, type]) => {
    let actual = `m.${column}`, expected = `m.raw->>'${field}'`;
    if (type?.startsWith('fk:')) actual = `(SELECT p.track_id::text FROM finance.trk_${type.slice(3)} p WHERE p.id=m.${column})`;
    else if (type === 'trim') expected = `btrim(${expected}, chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))`;
    else if (type === 'bool') expected = `coalesce((${expected})::boolean,false)`;
    else if (type === 'timestamptz') expected = `date_trunc('milliseconds', (${expected})::timestamptz)`; // mapping.js uses JS Date
    else if (type === 'date') expected = `(left(${expected},10))::date`;
    else if (type) expected = `(${expected})::${type}`;
    return `${actual} IS DISTINCT FROM (${expected})`;
  });
  if (entity === 'units') comparisons.push(`m.project_id IS DISTINCT FROM (SELECT c.project_id FROM finance.trk_clusters c WHERE c.id=m.cluster_id)`);
  if (entity === 'payments') comparisons.push(`CASE WHEN jsonb_typeof(m.raw->'bukti_pembayaran')='array' THEN CASE WHEN m.bukti_url IS JSON ARRAY THEN m.bukti_url::jsonb IS DISTINCT FROM m.raw->'bukti_pembayaran' ELSE true END ELSE m.bukti_url IS DISTINCT FROM (m.raw->>'bukti_pembayaran') END`);
  return `SELECT count(*) FROM finance.trk_${entity} m WHERE NOT m.is_deleted AND (m.raw IS NULL OR ${comparisons.join(' OR ')})`;
}

export async function collectInvariants(tx) {
  const values = {};
  for (const [name, query] of Object.entries(INVARIANTS)) {
    const [row] = await tx.unsafe(query);
    values[name] = Number(row.count);
  }
  for (const entity of Object.keys(MIRRORS)) {
    const [row] = await tx.unsafe(mirrorInvariantSql(entity));
    values[`mirror_${entity}`] = Number(row.count);
  }
  return values;
}
