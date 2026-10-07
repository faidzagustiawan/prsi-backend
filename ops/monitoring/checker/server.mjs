import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { ENTITIES, advance } from './state.mjs';
import { loadCounters, saveCounters } from './storage.mjs';

let states = new Map();
const stateFile = process.env.CHECKER_STATE_FILE ?? '/state/observations.json';
let storageSuccess = 1, storageCorrupt = false;
try { states = await loadCounters(stateFile); }
catch { storageSuccess = 0; storageCorrupt = true; }
async function saveState() {
  if (storageCorrupt) return; // Preserve corrupt evidence for operator recovery.
  try { await saveCounters(stateFile, states); storageSuccess = 1; }
  catch { storageSuccess = 0; }
}
const secret = async (name) => (await readFile(`/run/secrets/${name}`, 'utf8')).trim();
const urls = { track: process.env.TRACK_CHECKSUM_URL, prsi: process.env.PRSI_CHECKSUM_URL };
async function get(side, entity) {
  const token = await secret(`${side}-token`);
  const response = await fetch(`${urls[side]}/${entity}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Checksum unavailable');
  const body = await response.text();
  if (body.length > 4096) throw new Error('Oversize checksum');
  return JSON.parse(body);
}
async function cycle() {
  for (const entity of ENTITIES) {
    const previous = states.get(entity);
    try {
      const [track, prsi] = await Promise.all([get('track', entity), get('prsi', entity)]);
      states.set(entity, { ...advance(previous, track, prsi, Date.now()/1000), success: 1 });
    } catch {
      states.set(entity, { ...previous, success: 0, streak: 0, match: -1, pending: true, source: null, differenceSince: 0 });
    }
  }
  await saveState();
}
function metrics() {
  const lines = [`sync_checker_storage_success ${storageSuccess}`];
  for (const entity of ENTITIES) {
    const s = states.get(entity) ?? {};
    const emit = (name, value) => lines.push(`${name}{entity="${entity}"} ${value ?? 'NaN'}`);
    emit('sync_checker_success', s.success ?? 0);
    emit('sync_entity_match', s.match ?? -1);
    emit('sync_entity_pending', Number(s.pending ?? true));
    emit('sync_entity_last_match_timestamp', s.lastMatch ?? 0);
    emit('sync_entity_rows_track', s.success ? s.trackCount : null);
    emit('sync_entity_rows_prsi', s.success ? s.prsiCount : null);
    emit('sync_cursor_lag_seconds', null); // checksum watermark cannot measure source lag
    emit('sync_observed_difference_seconds', s.success ? (s.differenceSince ? Date.now()/1000-s.differenceSince : 0) : null);
    emit('sync_reconcile_mismatch_total', s.mismatches ?? 0);
  }
  return lines.join('\n')+'\n';
}
const alertNames = new Set(['ApiDown','High5xx','DiskHigh','SyncLag','SyncDifferenceObserved','SyncError','EntityMismatch','InvariantViolation','BackupOld','BackupUnknown','ScrapeMissing','CollectorFailed','CheckerFailed','MonitoringTest','CheckerStorageFailed']);
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/metrics') { res.writeHead(200, {'Content-Type':'text/plain; version=0.0.4'}); return res.end(metrics()); }
  if (req.method !== 'POST' || req.url !== '/alerts') { res.writeHead(404); return res.end(); }
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('too large'); }
    const payload = JSON.parse(body);
    // Never forward arbitrary annotations, labels, transaction data or URLs.
    const items = payload.alerts.slice(0, 50).map((a) => `${a.status === 'resolved' ? 'RESOLVED' : 'FIRING'}: ${alertNames.has(a.labels?.alertname) ? a.labels.alertname : 'MonitoringAlert'}`);
    const response = await fetch('http://127.0.0.1:8085/prsi-alerts', { method:'POST',
      headers: { Authorization: `Bearer ${await secret('ntfy-token')}`, Title: 'PRSI monitoring' },
      body: items.join('\n'), signal: AbortSignal.timeout(10_000), redirect:'error' });
    if (!response.ok) throw new Error('ntfy unavailable');
    res.writeHead(200); res.end('ok');
  } catch { res.writeHead(503); res.end('Notification unavailable'); }
});
server.listen(9199, '127.0.0.1');
await cycle();
let running = false;
const timer = setInterval(async () => { if (running) return; running = true; try { await cycle(); } finally { running = false; } }, 120_000);
process.on('SIGTERM', () => { clearInterval(timer); server.close(); });
