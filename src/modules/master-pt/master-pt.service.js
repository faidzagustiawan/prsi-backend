import { and, eq, ne } from 'drizzle-orm';
import { masterPt } from '../../shared/schemas/akuntansi.schema.js';
import { trkCompanies, trkProjects } from '../../shared/schemas/track.schema.js';
import { AppError } from '../../shared/utils/AppError.js';

export async function assertCompanyMapping(tx, { trackCompanyId, proyekId }, selfId) {
  if (!trackCompanyId) return;
  const [company] = await tx.select().from(trkCompanies)
    .where(and(eq(trkCompanies.id, trackCompanyId), eq(trkCompanies.isDeleted, false))).limit(1);
  if (!company) throw new AppError('Company PRTrack tidak ditemukan.', 422);
  // Pertahankan pemetaan PT yang dihapus agar dokumen lama tidak ambigu.
  const [taken] = await tx.select({ id: masterPt.id }).from(masterPt)
    .where(and(eq(masterPt.trackCompanyId, trackCompanyId), selfId ? ne(masterPt.id, selfId) : undefined)).limit(1);
  if (taken) throw new AppError('Company PRTrack sudah terhubung ke PT lain.', 409);
  if (proyekId) {
    const [project] = await tx.select().from(trkProjects).where(eq(trkProjects.id, proyekId)).limit(1);
    if (!project || project.isDeleted || project.companyId !== trackCompanyId) {
      throw new AppError('Company PRTrack tidak cocok dengan perumahan PT.', 422);
    }
  }
}
