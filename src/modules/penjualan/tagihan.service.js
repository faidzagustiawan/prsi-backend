import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { jadwalAngsuran, penjualanKeuangan, alokasiPembayaran } from '../../shared/schemas/penjualan.schema.js';
import { trkPayments } from '../../shared/schemas/track.schema.js';
import { AppError } from '../../shared/utils/AppError.js';
import { toCents, centsToString } from '../../shared/utils/money.js';
import { enqueueBill } from '../../sync/billing-outbox.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { env } from '../../config/env.js';

/**
 * Tagihan penjualan beserta realisasi dan status kunci per tagihan, serta plafon
 * yang dipakai save(): tagihan aktif + pembayaran historis tidak melebihi nilai SPPR.
 */
export async function list(id) {
  const [pj]=await db.select().from(penjualanKeuangan).where(eq(penjualanKeuangan.id,id));
  if (!pj) throw new AppError('Penjualan tidak ditemukan.',404);
  const rows=await db.select().from(jadwalAngsuran).where(eq(jadwalAngsuran.penjualanId,id)).orderBy(asc(jadwalAngsuran.createdAt),asc(jadwalAngsuran.noUrut));
  const alokasi=await db.select({jadwalId:alokasiPembayaran.jadwalId,nominal:alokasiPembayaran.nominal}).from(alokasiPembayaran)
    .innerJoin(jadwalAngsuran,eq(jadwalAngsuran.id,alokasiPembayaran.jadwalId)).where(eq(jadwalAngsuran.penjualanId,id));
  const pengajuan=await db.select({jadwalId:trkPayments.siJadwalId}).from(trkPayments)
    .innerJoin(jadwalAngsuran,eq(jadwalAngsuran.id,trkPayments.siJadwalId)).where(eq(jadwalAngsuran.penjualanId,id));
  const realisasi=new Map();
  for (const a of alokasi) realisasi.set(a.jadwalId,(realisasi.get(a.jadwalId)??0n)+toCents(a.nominal));
  const adaPengajuan=new Set(pengajuan.map(p=>p.jadwalId));
  const totalAktif=rows.filter(j=>j.aktif).reduce((n,j)=>n+toCents(j.jumlah),0n);
  const historis=rows.filter(j=>!j.aktif).reduce((n,j)=>n+(realisasi.get(j.id)??0n),0n);
  const items=rows.map(j=>{
    const dibayar=realisasi.get(j.id)??0n;
    return {...j,jumlah:Number(j.jumlah),dibayar:Number(centsToString(dibayar)),sisa:Number(centsToString(toCents(j.jumlah)-dibayar)),
      // Sama dengan assertBillUncommitted: tagihan dengan alokasi atau pengajuan Track tidak boleh ditimpa.
      terkunci:dibayar>0n || adaPengajuan.has(j.id)};
  });
  return {
    billingEnabled:env.billingEnabled, spprFinal:Boolean(pj.dokumenId), statusPenjualan:pj.status,
    nilaiSppr:Number(pj.nilaiSppr), totalAktif:Number(centsToString(totalAktif)), pembayaranHistoris:Number(centsToString(historis)),
    sisaPlafon:Number(centsToString(toCents(pj.nilaiSppr)-totalAktif-historis)), items,
  };
}
export async function assertBillUncommitted(tx,id) {
  const [{n}] = await tx.select({n:sql`count(*)::int`}).from(alokasiPembayaran).where(eq(alokasiPembayaran.jadwalId,id));
  const pending=await tx.select({id:trkPayments.id}).from(trkPayments).where(eq(trkPayments.siJadwalId,id)).limit(1);
  if (n || pending.length) throw new AppError('Tagihan memiliki pembayaran/alokasi. Gunakan koreksi keuangan; riwayat tidak boleh ditimpa.',409);
}
// All house bill kinds share the same contract; not restricted to SPPR down payments.
export async function save(actor,id,{id:billId,...b}) {
  if (!env.billingEnabled) throw new AppError('Fitur tagihan SI belum diaktifkan.',409);
  return db.transaction(async tx=>{
    const [pj]=await tx.select().from(penjualanKeuangan).where(eq(penjualanKeuangan.id,id)).for('update');
    if (!pj || pj.status!=='aktif' || !pj.dokumenId) throw new AppError('Penjualan aktif dengan SPPR final diperlukan.',409);
    let old;
    if (billId) {
      [old]=await tx.select().from(jadwalAngsuran).where(and(eq(jadwalAngsuran.id,billId),eq(jadwalAngsuran.penjualanId,id))).for('update');
      if (!old) throw new AppError('Tagihan tidak ditemukan.',404);
      await assertBillUncommitted(tx,billId);
    }
    const rows=await tx.select().from(jadwalAngsuran).where(eq(jadwalAngsuran.penjualanId,id));
    const issued=rows.filter(j=>j.aktif && j.id!==billId).reduce((n,j)=>n+toCents(j.jumlah),0n);
    const [{paidHistorical}]=await tx.select({paidHistorical:sql`coalesce(sum(${alokasiPembayaran.nominal}),0)::text`})
      .from(alokasiPembayaran).innerJoin(jadwalAngsuran,eq(jadwalAngsuran.id,alokasiPembayaran.jadwalId))
      .where(and(eq(jadwalAngsuran.penjualanId,id),eq(jadwalAngsuran.aktif,false)));
    if (issued+toCents(paidHistorical)+(b.aktif?toCents(b.jumlah):0n)>toCents(pj.nilaiSppr)) throw new AppError('Total tagihan dan pembayaran historis melebihi nilai SPPR.',422);
    const values={...b,jumlah:centsToString(toCents(b.jumlah)),updatedAt:new Date()};
    const [bill]=old
      ? await tx.update(jadwalAngsuran).set(values).where(eq(jadwalAngsuran.id,billId)).returning()
      : await tx.insert(jadwalAngsuran).values({...values,penjualanId:id,assignmentId:pj.assignmentId,dokumenId:pj.dokumenId}).returning();
    await enqueueBill(tx,bill.id);
    await recordAuditTx(tx,{...actor,action:old?AuditAction.UPDATE:AuditAction.CREATE,entity:'jadwal_angsuran',entityId:bill.id,summary:`Tagihan ${bill.keterangan ?? bill.noUrut}`,metadata:{aktif:bill.aktif,jumlah:bill.jumlah,jenis:bill.jenis}});
    return bill;
  });
}

// Carry settled credit into replacement amounts while allocations remain on the original IDs.
export function remainingRows(rows,credit) {
  let sisa=toCents(credit);
  return rows.flatMap(r=>{
    const nominal=toCents(r.jumlah);
    const applied=sisa<nominal?sisa:nominal;
    sisa-=applied;
    return nominal>applied?[{...r,jumlah:centsToString(nominal-applied)}]:[];
  });
}
