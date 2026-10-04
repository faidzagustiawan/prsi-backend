// src/modules/proyek/proyek.routes.js
//
// Proyek (perumahan) milik PR Track; SI hanya membaca cerminnya (trk_projects).
// Tidak ada endpoint tulis di sini: perubahan proyek dilakukan di Track.
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { trkProjects, trkUnits } from '../../shared/schemas/track.schema.js';
import { masterPt } from '../../shared/schemas/akuntansi.schema.js';
import { validate } from '../../middleware/validate.js';
import { keuanganOnly } from '../../middleware/authorize.js';
import { idParams } from '../../shared/utils/zod.js';
import { toNumber } from '../../shared/utils/money.js';

const tags = ['Proyek'];

export default async function proyekRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: guard,
    schema: { tags, description: 'Daftar proyek dari cermin PR Track, beserta PT yang terikat (ptId)' },
  }, async () => {
    const rows = await db
      .select({ id: trkProjects.id, nama: trkProjects.nama, kode: trkProjects.kode, status: trkProjects.status, ptId: masterPt.id })
      .from(trkProjects)
      .leftJoin(masterPt, eq(masterPt.proyekId, trkProjects.id))
      .where(eq(trkProjects.isDeleted, false))
      .orderBy(asc(trkProjects.nama));
    return { success: true, message: 'Success', data: rows };
  });

  fastify.get('/:id/kavling', {
    preHandler: [...guard, validate({ params: idParams })],
    schema: { tags, description: 'Daftar kavling (unit) satu proyek dari cermin PR Track' },
  }, async (request) => {
    const rows = await db
      .select({
        id: trkUnits.id, kode: trkUnits.kode, tipe: trkUnits.tipe,
        luasTanah: trkUnits.luasTanah, luasBangunan: trkUnits.luasBangunan, status: trkUnits.status,
      })
      .from(trkUnits)
      .where(and(eq(trkUnits.projectId, request.params.id), eq(trkUnits.isDeleted, false)))
      .orderBy(asc(trkUnits.kode));
    return {
      success: true,
      message: 'Success',
      data: rows.map((r) => ({ ...r, luasTanah: toNumber(r.luasTanah), luasBangunan: toNumber(r.luasBangunan) })),
    };
  });
}
