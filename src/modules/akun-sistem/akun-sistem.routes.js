// src/modules/akun-sistem/akun-sistem.routes.js
//
// Pemetaan peran akun untuk jurnal otomatis penjualan (titipan booking fee,
// uang muka, piutang, penjualan, HPP, ...). Diatur Keuangan dari layar COA.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../config/database.js';
import { akun, akunSistem } from '../../shared/schemas/akuntansi.schema.js';
import { validate } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { uuidSchema } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { AKUN_SISTEM } from '../../shared/constants.js';

const tags = ['Akun Sistem'];

/** Akun untuk satu peran; galat jelas bila belum diatur. */
export async function akunPeran(tx, kunci) {
  const [row] = await tx.select({ akun }).from(akunSistem).innerJoin(akun, eq(akun.id, akunSistem.akunId))
    .where(eq(akunSistem.kunci, kunci)).limit(1);
  if (!row) throw new AppError(`Akun untuk "${AKUN_SISTEM[kunci] ?? kunci}" belum diatur di Akun Sistem.`, 422);
  if (!row.akun.aktif) throw new AppError(`Akun ${row.akun.kode} untuk "${AKUN_SISTEM[kunci]}" nonaktif.`, 422);
  return row.akun;
}

export default async function akunSistemRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', { preHandler: guard, schema: { tags, description: 'Daftar peran akun dan akun yang dipetakan' } }, async () => {
    const rows = await db.select().from(akunSistem);
    const map = new Map(rows.map((r) => [r.kunci, r.akunId]));
    return {
      success: true, message: 'Success',
      data: Object.entries(AKUN_SISTEM).map(([kunci, label]) => ({ kunci, label, akunId: map.get(kunci) ?? null })),
    };
  });

  fastify.put('/:kunci', {
    preHandler: [...guard, validate({
      params: z.object({ kunci: z.enum(Object.keys(AKUN_SISTEM)) }),
      body: z.object({ akunId: uuidSchema }),
    })],
    schema: { tags, description: 'Atur akun untuk satu peran' },
  }, async (request) => {
    const actor = actorOf(request);
    const { kunci } = request.params;
    await db.transaction(async (tx) => {
      const [a] = await tx.select().from(akun).where(eq(akun.id, request.body.akunId)).limit(1);
      if (!a || !a.aktif) throw new AppError('Akun tidak ditemukan atau nonaktif.', 422);
      await tx.insert(akunSistem).values({ kunci, akunId: a.id })
        .onConflictDoUpdate({ target: akunSistem.kunci, set: { akunId: a.id, updatedAt: new Date() } });
      await recordAuditTx(tx, { ...actor, action: AuditAction.UPDATE, entity: 'akun_sistem', entityId: null, field: kunci, summary: `${kunci} -> ${a.kode}` });
    });
    return { success: true, message: 'Akun sistem diperbarui', data: { kunci, label: AKUN_SISTEM[kunci], akunId: request.body.akunId } };
  });
}
