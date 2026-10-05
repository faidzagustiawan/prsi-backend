// src/sync/track-client.js
//
// Satu-satunya pintu SI ke PR Track (docs/TrackSyncAPI.md). Koneksi selalu
// dimulai dari SI; Track tidak tahu alamat SI.
// - Token baca-saja untuk semua GET, token khusus untuk PUT jadwal/kunci.
// - Di produksi wajib HTTPS.
// - Setiap respons divalidasi bentuknya sebelum dipakai.
import { env } from '../config/env.js';

const TIMEOUT_MS = 15_000;

export class TrackError extends Error {
  constructor(message, { status, retryable = true } = {}) {
    super(message);
    this.name = 'TrackError';
    this.status = status;
    this.retryable = retryable;
  }
}

export function assertConfig(cfg = env.sync) {
  if (!cfg.trackApiUrl) throw new TrackError('TRACK_API_URL belum diisi.', { retryable: false });
  const url = new URL(cfg.trackApiUrl);
  if (url.protocol !== 'https:' && !env.isDevelopment) {
    throw new TrackError('TRACK_API_URL wajib https di luar development.', { retryable: false });
  }
  if (!cfg.readToken) throw new TrackError('TRACK_SYNC_TOKEN belum diisi.', { retryable: false });
}

async function request(cfg, method, path, { token, body, idempotencyKey } = {}) {
  const url = new URL(path.replace(/^\//, ''), cfg.trackApiUrl.endsWith('/') ? cfg.trackApiUrl : `${cfg.trackApiUrl}/`);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let res;
  try {
    res = await fetch(url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
    });
  } catch (err) {
    throw new TrackError(`Track tidak terjangkau: ${err.message}`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new TrackError(`Respons Track bukan JSON (HTTP ${res.status}).`, { status: res.status });
  }
  if (!res.ok) {
    // 4xx selain 409/429 = kesalahan data atau token: tidak membaik dengan diulang segera
    const retryable = res.status >= 500 || res.status === 429;
    throw new TrackError(json?.message || `HTTP ${res.status}`, { status: res.status, retryable });
  }
  return { status: res.status, json };
}

const isInt = (v) => Number.isSafeInteger(v) && v >= 0;

/** "txid:seq" -> { txid, seq }; null bila bentuknya salah. */
export function parseCursor(value) {
  const m = /^(\d{1,16}):(\d{1,16})$/.exec(String(value ?? ''));
  if (!m) return null;
  const txid = Number(m[1]), seq = Number(m[2]);
  return isInt(txid) && isInt(seq) ? { txid, seq } : null;
}
const isCursor = (v) => parseCursor(v) !== null;

export function createTrackClient(cfg = env.sync) {
  assertConfig(cfg);
  const get = (path) => request(cfg, 'GET', path, { token: cfg.readToken }).then((r) => r.json);

  return {
    /** Event setelah after_seq, berurutan. */
    async events(afterSeq, limit = cfg.pageSize) {
      const json = await get(`sync/v1/events?after_seq=${afterSeq}&limit=${limit}`);
      if (!json || !Array.isArray(json.events) || !isInt(json.next_after_seq)) {
        throw new TrackError('Bentuk respons /events tidak sesuai kontrak.', { retryable: false });
      }
      for (const e of json.events) {
        if (!isInt(e.seq) || !e.entity || !e.entity_id || !['I', 'U', 'D'].includes(e.op) || !isInt(e.row_version)) {
          throw new TrackError(`Event tidak sesuai kontrak: ${JSON.stringify(e).slice(0, 200)}`, { retryable: false });
        }
      }
      return json;
    },

    /**
     * Kontrak v2: cursor "txid:seq" menurut urutan commit. Track hanya
     * mengirim event dari transaksi yang sudah selesai, jadi tidak ada lubang
     * yang perlu ditunggu dan commit terlambat tidak pernah jatuh di belakang cursor.
     */
    async eventsV2(after, limit = cfg.pageSize) {
      const json = await get(`sync/v2/events?after=${encodeURIComponent(after)}&limit=${limit}`);
      if (!json || !Array.isArray(json.events) || !isCursor(json.next_after) || typeof json.has_more !== 'boolean') {
        throw new TrackError('Bentuk respons /v2/events tidak sesuai kontrak.', { retryable: false });
      }
      for (const e of json.events) {
        if (!isInt(e.seq) || !e.entity || !e.entity_id || !['I', 'U', 'D'].includes(e.op) || !isInt(e.row_version) || !isCursor(e.cursor)) {
          throw new TrackError(`Event tidak sesuai kontrak: ${JSON.stringify(e).slice(0, 200)}`, { retryable: false });
        }
      }
      return json;
    },

    /** Cursor awal muat awal v2: diambil SEBELUM halaman snapshot pertama. */
    async startV2() {
      const json = await get('sync/v2/start');
      if (!json || !isCursor(json.after)) throw new TrackError('Bentuk respons /v2/start tidak sesuai kontrak.', { retryable: false });
      return json;
    },

    /** Snapshot satu entitas, berhalaman menurut id. */
    async snapshot(entity, pageAfterId = '', limit = cfg.pageSize) {
      const q = new URLSearchParams({ limit: String(limit) });
      if (pageAfterId) q.set('page_after_id', pageAfterId);
      const json = await get(`sync/v1/snapshot/${entity}?${q}`);
      if (!json || !Array.isArray(json.rows) || !isInt(json.max_seq)) {
        throw new TrackError(`Bentuk respons /snapshot/${entity} tidak sesuai kontrak.`, { retryable: false });
      }
      return json;
    },

    /** { count, hash } baris yang belum dihapus. */
    async checksum(entity) {
      const json = await get(`sync/v1/checksum/${entity}`);
      if (!json || !isInt(json.count) || typeof json.hash !== 'string') {
        throw new TrackError(`Bentuk respons /checksum/${entity} tidak sesuai kontrak.`, { retryable: false });
      }
      return json;
    },

    async putSchedule(siJadwalId, payload, idempotencyKey) {
      if (!cfg.scheduleToken) throw new TrackError('TRACK_SCHEDULE_TOKEN belum diisi.', { retryable: false });
      return request(cfg, 'PUT', `sync/v1/schedules/${siJadwalId}`, { token: cfg.scheduleToken, body: payload, idempotencyKey });
    },

    async putPaymentLock(trackPaymentId, payload, idempotencyKey) {
      if (!cfg.scheduleToken) throw new TrackError('TRACK_SCHEDULE_TOKEN belum diisi.', { retryable: false });
      return request(cfg, 'PUT', `sync/v1/payment-locks/${trackPaymentId}`, { token: cfg.scheduleToken, body: payload, idempotencyKey });
    },
  };
}
