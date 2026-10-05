// Condense one evidence JSON line from stdin.
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  for (const line of s.split('\n').filter((l) => l.startsWith('{'))) {
    const j = JSON.parse(line);
    if (j.failed) { console.log('FAILED', JSON.stringify(j)); continue; }
    if (j.scenario) {
      console.log(`[track ${j.scenario}] maxSeq ${j.before.maxSeq}->${j.after.maxSeq} seqLast ${j.before.seqLastValue}->${j.after.seqLastValue} missing=${JSON.stringify(j.missingSeqs)}`);
      for (const e of j.newEvents) console.log(`  seq ${e.seq} ${e.entity} ${e.entity_id.slice(-4)} ${e.op} v${e.row_version}`);
      continue;
    }
    if (j.mode === 'migrate') { console.log('[prsi migrate]', JSON.stringify(j.migrated)); continue; }
    const st = j.after || j.state;
    const cs = st.checksums;
    console.log(`[prsi ${j.label}] mode=${j.mode} db=${j.identity.database} dbGuard=${j.identity.dbGuard.isolated} gapTimeout=${j.gapTimeoutSec}s dur=${j.durationMs ?? '-'}ms`);
    if (j.before) console.log(`  [${j.protocol}] cursor ${j.before.cursor.cursor_txid ?? '-'}:${j.before.cursor.cursor_seq} -> ${st.cursor.cursor_txid ?? '-'}:${st.cursor.cursor_seq} gap=${st.cursor.gap_seq} heldOrGapSince=${st.cursor.gap_since}`);
    else console.log(`  cursor ${st.cursor.cursor_seq} gap=${st.cursor.gap_seq}`);
    if (j.result) console.log('  result', JSON.stringify(j.result));
    console.log(`  sync_error unresolved=${st.syncError.unresolved} total=${st.syncError.total}`, st.openErrors.length ? JSON.stringify(st.openErrors) : '');
    console.log('  tables', Object.entries(st.tables).map(([k, v]) => `${k}:${v.live}/${v.total}(del ${v.deleted}, maxv ${v.max_row_version})`).join(' '));
    console.log(`  jurnal=${st.jurnal.jurnal} detail=${st.jurnal.jurnal_detail} status_pembayaran_si=${st.jurnal.status_pembayaran_si} outbox=${JSON.stringify(st.outbox)}`);
    console.log('  checksum', Object.entries(cs).map(([k, v]) => `${k}:${v.match ? 'OK' : 'MISMATCH'} ${v.trackCount}/${v.prsiCount}`).join(' '));
    for (const f of st.fixtures) console.log('  fx', JSON.stringify(f));
    console.log('  network', JSON.stringify(j.network));
  }
});
