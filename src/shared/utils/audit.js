// src/shared/utils/audit.js
import { db } from '../../config/database.js';
import { auditLogs } from '../schemas/finance.schema.js';

export const AuditAction = {
  LOGIN: 'auth.login',
  LOGOUT: 'auth.logout',
  USER_CREATED: 'user.created',
};

/**
 * Mencatat jejak audit. Kegagalan mencatat tidak boleh menggagalkan request
 * utama, tapi selalu dicatat ke log server.
 */
export async function recordAudit({ request, userId, companyId, action, entity, entityId, summary, metadata }) {
  try {
    await db.insert(auditLogs).values({
      userId: userId ?? request?.user?.sub ?? null,
      companyId: companyId ?? request?.user?.companyId ?? null,
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
