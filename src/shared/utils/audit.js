// src/shared/utils/audit.js
import { db } from '../../config/database.js';
import { auditLogs } from '../schemas/finance.schema.js';

export const AuditAction = {
  LOGIN: 'auth.login',
  LOGOUT: 'auth.logout',
  USER_CREATED: 'user.created',
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  POST: 'posting',
  REVERSE: 'balik',
  LOCK: 'kunci',
};

/**
 * Mencatat jejak audit. Kegagalan mencatat tidak boleh menggagalkan request
 * utama, tapi selalu dicatat ke log server.
 */
export async function recordAudit({ request, userId, companyId, action, entity, entityId, summary, metadata }) {
  try {
    await db.insert(auditLogs).values({
      userId: userId ?? request?.user?.sub ?? null,
      companyId: companyId ?? null,
      action,
      entity,
      entityId: entityId ? String(entityId) : null,
      summary,
      metadata: metadata ?? {},
      ipAddress: request?.ip ?? null,
    });
  } catch (err) {
    (request?.server?.log ?? console).error({ err, action }, '[Audit] gagal mencatat');
  }
}

const show = (v) => (v === null || v === undefined || v === '' ? '-' : String(v));

/**
 * Audit per kolom di dalam transaksi yang sama dengan perubahannya, supaya
 * riwayat (mis. riwayat akun COA) tidak pernah tertinggal dari datanya.
 * `labels` memetakan nama kolom ke label tampilan; kolom tanpa label dilewati.
 */
export async function recordFieldChanges(tx, { userId, ip, entity, entityId, before, after, labels, format = {} }) {
  const rows = [];
  for (const [key, label] of Object.entries(labels)) {
    if (!(key in after)) continue;
    const fmt = format[key] ?? show;
    const lama = fmt(before?.[key]);
    const baru = fmt(after[key]);
    if (lama === baru) continue;
    rows.push({
      userId, action: AuditAction.UPDATE, entity, entityId: String(entityId),
      field: label, nilaiLama: lama, nilaiBaru: baru, ipAddress: ip ?? null,
    });
  }
  if (rows.length) await tx.insert(auditLogs).values(rows);
  return rows.length;
}

/** Satu baris audit di dalam transaksi. */
export async function recordAuditTx(tx, { userId, ip, action, entity, entityId, summary, field, metadata }) {
  await tx.insert(auditLogs).values({
    userId, action, entity, entityId: entityId ? String(entityId) : null,
    field: field ?? null, summary, metadata: metadata ?? {}, ipAddress: ip ?? null,
  });
}
