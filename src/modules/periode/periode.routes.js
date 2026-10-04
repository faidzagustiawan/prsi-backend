// src/modules/periode/periode.routes.js
//
// Tutup buku per PT per bulan (Alur 6). Periode terkunci tidak bisa diubah;
// koreksi berikutnya lewat jurnal balik di periode berjalan.
import { and, asc, count, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../config/database.js';
import { periode, masterPt, jurnal } from '../../shared/schemas/akuntansi.schema.js';
import { validate } from '../../middleware/validate.js';
import { keuanganOnly, actorOf } from '../../middleware/authorize.js';
import { uuidSchema, bulanSchema } from '../../shared/utils/zod.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';

const tags = ['Periode'];

const toDto = (r) => ({
  id: r.id,
  ptId: r.ptId,
  bulan: `${r.tahun}-${String(r.bulan).padStart(2, '0')}`,
  status: r.status,
  ditutupOleh: r.ditutupOleh,
  ditutupPada: r.ditutupPada,
});

const range = (bulan) => {
  const [y, m] = bulan.split('-').map(Number);
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { y, m, start: `${bulan}-01`, end };
};

export default async function periodeRoutes(fastify) {
  const guard = keuanganOnly(fastify);

  fastify.get('/', {
    preHandler: [...guard, validate({ query: z.object({ ptId: uuidSchema.optional() }) })],
    schema: { tags, description: 'Daftar periode yang sudah dibuat (yang tidak ada di daftar = terbuka)' },
  }, async (request) => {
    const rows = await db.select().from(periode)
      .where(request.query.ptId ? eq(periode.ptId, request.query.ptId) : undefined)
      .orderBy(asc(periode.tahun), asc(periode.bulan));
    return { success: true, message: 'Success', data: rows.map(toDto) };
  });

  fastify.post('/tutup', {
    preHandler: [...guard, validate({ body: z.object({ ptId: uuidSchema, bulan: bulanSchema }) })],
    schema: { tags, description: 'Kunci periode satu PT. Ditolak bila masih ada jurnal draft di bulan itu.' },
  }, async (request) => {
    const actor = actorOf(request);
    const { ptId, bulan } = request.body;
    const { y, m, start, end } = range(bulan);

    const row = await db.transaction(async (tx) => {
      const [pt] = await tx.select({ id: masterPt.id }).from(masterPt).where(eq(masterPt.id, ptId)).limit(1);
      if (!pt) throw new AppError('PT tidak ditemukan.', 404);

      await tx.insert(periode).values({ ptId, tahun: y, bulan: m }).onConflictDoNothing();
      const [p] = await tx.select().from(periode)
        .where(and(eq(periode.ptId, ptId), eq(periode.tahun, y), eq(periode.bulan, m))).for('update').limit(1);
      if (p.status === 'terkunci') throw new AppError(`Periode ${bulan} sudah dikunci.`, 409);

      // Antrean yang harus nol sebelum tutup buku (Alur 6)
      const [{ n }] = await tx.select({ n: count() }).from(jurnal)
        .where(and(eq(jurnal.ptId, ptId), eq(jurnal.status, 'draft'), gte(jurnal.tanggal, start), lt(jurnal.tanggal, end)));
      if (Number(n) > 0) throw new AppError(`Masih ada ${n} jurnal draft di periode ${bulan}.`, 422);
      const [antrean] = await tx.execute(sql`
        SELECT COUNT(*)::int n
        FROM finance.trk_payments p
        JOIN finance.status_pembayaran_si s ON s.payment_id = p.id
        JOIN finance.trk_assignments a ON a.id = p.assignment_id
        JOIN finance.trk_units u ON u.id = a.unit_id
        JOIN finance.master_pt pt ON pt.proyek_id = u.project_id
        WHERE pt.id = ${ptId} AND s.status_proses IN ('gagal_validasi', 'perlu_ditinjau')
          AND p.tanggal >= ${start} AND p.tanggal < ${end}
      `);
      if (antrean.n > 0) throw new AppError(`Masih ada ${antrean.n} pembayaran PR Track Gagal validasi / Perlu ditinjau di periode ${bulan}.`, 422);

      const [updated] = await tx.update(periode)
        .set({ status: 'terkunci', ditutupOleh: actor.userId, ditutupPada: new Date(), updatedAt: new Date() })
        .where(eq(periode.id, p.id)).returning();
      await recordAuditTx(tx, { ...actor, action: AuditAction.LOCK, entity: 'periode', entityId: p.id, summary: `Tutup buku ${bulan}` });
      return updated;
    });
    return { success: true, message: `Periode ${bulan} dikunci`, data: toDto(row) };
  });
}
