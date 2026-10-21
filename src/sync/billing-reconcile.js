import {and,eq,sql,inArray} from 'drizzle-orm';
import {db} from '../config/database.js';
import {jadwalAngsuran,alokasiPembayaran,penjualanKeuangan,outboxTrack} from '../shared/schemas/penjualan.schema.js';
import {trkAssignments,trkPayments,statusPembayaranSi} from '../shared/schemas/track.schema.js';
import {jurnal} from '../shared/schemas/akuntansi.schema.js';
import {toCents} from '../shared/utils/money.js';
import {enqueueBillingState,paymentResultStatus} from './billing-outbox.js';
import {TrackError} from './track-client.js';

const amount=v=>toCents(v??0).toString();
async function remoteRows(client,entity) {
  const rows=[];let after='';
  for(let page=0;page<10000;page++) {
    const result=await client.billingSnapshot(entity,after);
    let previous=after;
    for(const row of result.rows) {
      if(!/^[0-9a-f-]{36}$/i.test(row.id??'') || row.id<=previous) throw new TrackError('Urutan snapshot billing tidak valid.',{retryable:false});
      previous=row.id;
    }
    rows.push(...result.rows);
    if(!result.has_more) return rows;
    if(!result.rows.length) throw new TrackError('Snapshot billing tidak maju.',{retryable:false});
    after=result.rows.at(-1).id;
  }
  throw new TrackError('Snapshot billing melebihi batas halaman.',{retryable:false});
}
const difference=(expected,actual)=>{
  const keys=new Set([...expected.keys(),...actual.keys()]);
  return [...keys].filter(id=>JSON.stringify(expected.get(id))!==JSON.stringify(actual.get(id)));
};
export async function reconcileBilling(client,counts,{repair=true}={}) {
  const state=()=>db.select({pending:sql`count(*) filter(where ${inArray(outboxTrack.status,['tertunda','gagal'])})::int`,head:sql`coalesce(max(${outboxTrack.sequence}),0)::text`}).from(outboxTrack);
  const [{pending,head}]=await state();
  if(pending) return {dilewati:true,alasan:'Tunggu antrean kirim selesai.',pending};
  const schedules=await db.select({j:jadwalAngsuran,trackAssignmentId:trkAssignments.trackId,kontrak:penjualanKeuangan.nilaiSppr}).from(jadwalAngsuran)
    .innerJoin(trkAssignments,eq(trkAssignments.id,jadwalAngsuran.assignmentId)).innerJoin(penjualanKeuangan,eq(penjualanKeuangan.id,jadwalAngsuran.penjualanId)).where(eq(trkAssignments.isDeleted,false));
  const allocations=await db.select({id:alokasiPembayaran.jadwalId,n:sql`sum(${alokasiPembayaran.nominal})::text`}).from(alokasiPembayaran).groupBy(alokasiPembayaran.jadwalId);
  const paid=new Map(allocations.map(a=>[a.id,a.n]));
  const payments=await db.select({p:trkPayments,s:statusPembayaranSi,noBukti:jurnal.noBukti}).from(trkPayments)
    .leftJoin(statusPembayaranSi,eq(statusPembayaranSi.paymentId,trkPayments.id)).leftJoin(jurnal,eq(jurnal.id,statusPembayaranSi.jurnalId))
    .where(and(eq(trkPayments.isDeleted,false),sql`${trkPayments.siJadwalId} IS NOT NULL`));
  const expectedBills=new Map(schedules.map(({j,trackAssignmentId,kontrak})=>[j.id,[trackAssignmentId,j.noUrut,j.tanggal,amount(j.jumlah),j.jenis,j.keterangan??null,j.aktif,amount(paid.get(j.id)),amount(kontrak)]]));
  const expectedResults=new Map(payments.map(({p,s,noBukti})=>[p.trackId,[p.siJadwalId,paymentResultStatus(s),s?.alasan??null,noBukti??null]]));
  const bills=await remoteRows(client,'schedules'),results=await remoteRows(client,'results');
  const [latest]=await state();
  if(latest.pending || latest.head!==head) return {dilewati:true,alasan:'Billing SI berubah selama perbandingan; ulangi setelah antrean selesai.'};
  if(results.some(p=>!expectedResults.has(p.id) && p.status_si==='menunggu')) return {dilewati:true,alasan:'Ada pengajuan baru Track yang belum ditarik oleh worker SI.'};
  const billDiff=difference(expectedBills,new Map(bills.map(b=>[b.id,[b.assignment_id,b.no_urut,b.tanggal,amount(b.jumlah),b.jenis,b.keterangan??null,b.aktif,amount(b.realisasi),amount(b.nilai_kontrak)]])));
  const resultDiff=difference(expectedResults,new Map(results.map(p=>[p.id,[p.si_jadwal_id,p.status_si,p.alasan_si??null,p.jurnal_si??null]])));
  const cocok=!billDiff.length&&!resultDiff.length;
  if(!cocok) {counts.gagal+=billDiff.length+resultDiff.length;counts.peringatan.push('Cermin billing Track berbeda dari SI.');}
  const queued=!cocok && repair ? await enqueueBillingState(db):null;
  return {cocok,tagihan:{si:expectedBills.size,track:bills.length,selisih:billDiff},pembayaran:{si:expectedResults.size,track:results.length,selisih:resultDiff},diantrekan:queued};
}
