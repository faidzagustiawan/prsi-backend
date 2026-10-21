import { and, eq, sql } from 'drizzle-orm';
import { jadwalAngsuran, alokasiPembayaran, outboxTrack, penjualanKeuangan } from '../shared/schemas/penjualan.schema.js';
import { trkAssignments,trkPayments,statusPembayaranSi } from '../shared/schemas/track.schema.js';
import {jurnal} from '../shared/schemas/akuntansi.schema.js';
export const paymentResultStatus=s=>s?.statusProses==='dijurnal'?'dijurnal':s?.keputusan==='tolak'?'ditolak':s?.keputusan==='dikoreksi'?'dikoreksi':
  ['gagal_validasi','perlu_ditinjau'].includes(s?.statusProses)?'perlu_ditinjau':'menunggu';

// Full snapshots make retry, cold recovery and inactive-before-active delivery safe.
export async function enqueueBill(tx, id) {
  const [hint]=await tx.select({penjualanId:jadwalAngsuran.penjualanId}).from(jadwalAngsuran).where(eq(jadwalAngsuran.id,id));
  if(!hint) return;
  const [pj]=await tx.select().from(penjualanKeuangan).where(eq(penjualanKeuangan.id,hint.penjualanId)).for('update');
  const [j] = await tx.select().from(jadwalAngsuran).where(eq(jadwalAngsuran.id,id)).for('update');
  const [a] = await tx.select().from(trkAssignments).where(eq(trkAssignments.id,j.assignmentId));
  const [{ total }] = await tx.select({total:sql`coalesce(sum(${alokasiPembayaran.nominal}),0)::text`}).from(alokasiPembayaran).where(eq(alokasiPembayaran.jadwalId,id));
  await tx.insert(outboxTrack).values({jenis:'jadwal_angsuran',refId:id,payload:{
    siJadwalId:id,trackAssignmentId:a.trackId,noUrut:j.noUrut,tanggal:j.tanggal,jumlah:j.jumlah,
    jenis:j.jenis,keterangan:j.keterangan,aktif:j.aktif,realisasi:total,nilaiKontrak:pj.nilaiSppr,
  }});
}
export async function enqueuePaymentResult(tx, p, status, {alasan=null,jurnal=null}={}) {
  await tx.insert(outboxTrack).values({jenis:'hasil_pembayaran',refId:p.id,payload:{
    trackPaymentId:p.trackId,siJadwalId:p.siJadwalId ?? null,status,alasan,jurnal,
  }});
}

export async function enqueueBillingState(db) {
  const bills=await db.select({id:jadwalAngsuran.id}).from(jadwalAngsuran)
    .innerJoin(trkAssignments,eq(trkAssignments.id,jadwalAngsuran.assignmentId)).where(eq(trkAssignments.isDeleted,false));
  for(const bill of bills) await db.transaction(tx=>enqueueBill(tx,bill.id));
  const payments=await db.select({id:trkPayments.id}).from(trkPayments)
    .where(and(eq(trkPayments.isDeleted,false),sql`${trkPayments.siJadwalId} IS NOT NULL`));
  for(const row of payments) await db.transaction(async tx=>{
    const [p]=await tx.select().from(trkPayments).where(eq(trkPayments.id,row.id)).for('update');
    if(p.isDeleted || !p.siJadwalId) return;
    const [s]=await tx.select().from(statusPembayaranSi).where(eq(statusPembayaranSi.paymentId,p.id));
    const [j]=s?.jurnalId?await tx.select({noBukti:jurnal.noBukti}).from(jurnal).where(eq(jurnal.id,s.jurnalId)):[];
    const status=paymentResultStatus(s);
    await enqueuePaymentResult(tx,p,status,{alasan:s?.alasan ?? null,jurnal:j?.noBukti ?? null});
  });
  return {tagihan:bills.length,pembayaran:payments.length};
}
