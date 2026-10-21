import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import bcrypt from 'bcrypt';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {buildStagingApp} from '../../../Podorukuntrack/backend/staging/app.js';
import billingRoutes from '../../../Podorukuntrack/backend/src/modules/sync/billing.routes.js';
import {createBillingCapture} from '../../../Podorukuntrack/backend/src/modules/sync/billing.capture.js';

function localUrl(name,prefix) {
  const value=process.env[name];
  if(!value) throw new Error(`${name} required; no environment fallback`);
  const u=new URL(value);
  if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!u.pathname.startsWith('/'+prefix)) throw new Error('Only disposable local test databases allowed');
  return value;
}
async function withIntegrationProcess(env,run) {
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../../Podorukuntrack/backend/src/sync-server.js',import.meta.url))],{
  env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,NODE_ENV:'development',TRACK_SYNC_HOST:'127.0.0.1',TRACK_SYNC_PORT:'0',TRACK_SYNC_ALLOWED_IPS:'127.0.0.1',...env},
  stdio:['ignore','pipe','pipe'],windowsHide:true,
 });
 let timer;
 try {
  const address=await new Promise((resolve,reject)=>{
   let stderr='';
   timer=setTimeout(()=>reject(new Error('integration listener startup timeout')),10000);
   child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-6000);});
   child.stdout.on('data',b=>{const m=b.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});
   child.once('exit',code=>reject(new Error('integration listener exited '+code+': '+stderr)));
   child.once('error',reject);
  });
  return await run(address);
 } finally {
  clearTimeout(timer);
  if(child.exitCode===null && child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}
 }
}
test('billing integration across two isolated databases',async t=>{
 const siUrl=localUrl('TEST_DATABASE_URL','prsi_test_');
 const track=postgres(localUrl('TEST_TRACK_DATABASE_URL','prtrack_test_'),{prepare:false,onnotice:()=>{}});
 const si=postgres(siUrl,{prepare:false,onnotice:()=>{}});
 let api,source,closeDatabase;
 const readToken='a'.repeat(64),writeToken='b'.repeat(64);
 try {
  for(const [sql,schema] of [[si,'finance'],[track,'staging_control']]) {
   const [{n}]=await sql`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=${schema}`;
   assert.equal(n,0,'Use fresh test databases; never deletes pre-existing data');
  }
  await si`CREATE SCHEMA finance`;
  await migrate(drizzle(si),{migrationsFolder:'./drizzle',migrationsSchema:'finance'});
  await track.unsafe(`
   CREATE TABLE companies(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),nama_pt text,kode_pt text,alamat text);
   CREATE TABLE projects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies,nama_proyek text,status text);
   CREATE TABLE clusters(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid REFERENCES projects,nama_cluster text);
   CREATE TABLE units(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cluster_id uuid REFERENCES clusters,nomor_unit text,tipe_rumah text,luas_tanah numeric,luas_bangunan numeric,status_pembangunan text);
   CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),nama text,email text,nomor_telepon text,role text DEFAULT 'customer');
   CREATE TABLE property_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES users,unit_id uuid REFERENCES units,tipe_pembayaran text,harga_total numeric,dp numeric,status_kepemilikan text,tanggal_pembelian date,total_dibayar numeric NOT NULL DEFAULT 0);
   CREATE TABLE payment_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),assignment_id uuid REFERENCES property_assignments, jumlah_bayar numeric(18,2),tanggal_bayar date,catatan text,bukti_pembayaran text,is_auto_inject boolean DEFAULT false,created_at timestamptz DEFAULT now(),created_by uuid REFERENCES users);
   CREATE SCHEMA staging_control;
   CREATE TABLE staging_control.identity(singleton boolean PRIMARY KEY DEFAULT true,instance_id uuid,database_oid oid,sanitized boolean);
   INSERT INTO staging_control.identity VALUES(true,'00000000-0000-4000-8000-000000000099',(SELECT oid FROM pg_database WHERE datname=current_database()),true);
  `);
  await track.begin(async tx=>{
   await tx`SELECT set_config('prtrack.staging_id','00000000-0000-4000-8000-000000000099',true)`;
   await tx.unsafe(await readFile(new URL('../../../Podorukuntrack/backend/staging/sync.sql',import.meta.url),'utf8'));
   await tx.unsafe(await readFile(new URL('../../../Podorukuntrack/backend/staging/billing.sql',import.meta.url),'utf8'));
  });
  await track.unsafe('CREATE TRIGGER trigger_update_total_dibayar AFTER INSERT OR UPDATE OR DELETE ON payment_history FOR EACH ROW EXECUTE FUNCTION update_total_dibayar()');
  const [company]=await track`INSERT INTO companies(nama_pt,kode_pt) VALUES('Fixture PT','TEST') RETURNING id`;
  const [project]=await track`INSERT INTO projects(company_id,nama_proyek,status) VALUES(${company.id},'Fixture project','active') RETURNING id`;
  const [cluster]=await track`INSERT INTO clusters(project_id,nama_cluster) VALUES(${project.id},'Cluster') RETURNING id`;
  const [unit]=await track`INSERT INTO units(cluster_id,nomor_unit,status_pembangunan) VALUES(${cluster.id},'A1','selesai') RETURNING id`;
  const [customer]=await track`INSERT INTO users(nama,email) VALUES('Fixture buyer','buyer@example.test') RETURNING id`;
  const [assignment]=await track`INSERT INTO property_assignments(user_id,unit_id,tipe_pembayaran,harga_total,dp,status_kepemilikan,tanggal_pembelian) VALUES(${customer.id},${unit.id},'cash_cicil',1000,200,'active','2026-10-01') RETURNING id`;
  source=await buildStagingApp(track,readToken);
  await source.register(billingRoutes,{prefix:'/sync/v1',db:track,token:writeToken,allowedIps:['127.0.0.1']});
  const address=await source.listen({host:'127.0.0.1',port:0});
  Object.assign(process.env,{DATABASE_URL:siUrl,REPORT_DATABASE_URL:siUrl,SESSION_DATABASE_URL:siUrl,
   JWT_SECRET:'billing-test-only-jwt-secret-32-characters',COOKIE_SECRET:'billing-test-only-cookie-secret-32-characters',
   NODE_ENV:'development',API_URL:'http://localhost:3100',SYNC_ENABLED:'true',SYNC_WRITE_ENABLED:'true',SYNC_PROTOCOL:'v2',
   TRACK_API_URL:address,TRACK_SYNC_TOKEN:readToken,TRACK_SCHEDULE_TOKEN:writeToken,SI_BILLING_ENABLED:'true',ALLOW_UNSAFE_DB_ROLE:'false'});
  ({closeDatabase}=await import('../src/config/database.js'));
  const {buildApp}=await import('../src/app.js');
  const {runCycle,runReconcile}=await import('../src/sync/runner.js');
  const {createTrackClient}=await import('../src/sync/track-client.js');
  const {env}=await import('../src/config/env.js');
  const client=createTrackClient();
  api=await buildApp({logger:false,documentationOnly:true});
  const userId=randomUUID();
  await si`INSERT INTO finance.users(id,nama,email,password_hash,role) VALUES(${userId},'Finance','finance@example.test',${await bcrypt.hash('TestOnlyPassword123',4)},'keuangan')`;
  const login=await api.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'finance@example.test',password:'TestOnlyPassword123'}});
  assert.equal(login.statusCode,200,login.body);
  const headers={authorization:'Bearer '+login.json().data.accessToken};
  const call=async(method,path,payload,expected=200)=>{
   const r=await api.inject({method,url:'/api/v1'+path,headers,payload});
   assert.equal(r.statusCode,expected,`${method} ${path}: ${r.body}`);
   return r.json().data;
  };
  const cycle=async()=>{const r=await runCycle();assert.equal(r.tarik.status,'sukses',JSON.stringify(r));assert.equal(r.tarik.counts.gagal,0);assert.equal(r.kirim.counts.gagalKirim,0,JSON.stringify(r.kirim));return r;};
  await t.test('bootstrap resumes after a network failure after the first entity',async()=>{
   let failed=false;
   await assert.rejects(runCycle({client:{...client,snapshot:async(...args)=>{
    if(args[0]==='projects'&&!failed){failed=true;throw new Error('simulated interruption');}
    return client.snapshot(...args);
   }}}),/simulated interruption/);
   const [state]=await si`SELECT bootstrap FROM finance.sync_cursor WHERE id='global'`;
   assert.equal(state.bootstrap.entityIndex,1);
   await cycle();
   assert.equal((await si`SELECT bootstrap FROM finance.sync_cursor WHERE id='global'`)[0].bootstrap,null);
   const r=await runReconcile();assert.equal(r.result.filter(x=>x.cocok).length,7);
  });
  const [localAssignment]=await si`SELECT * FROM finance.trk_assignments WHERE track_id=${assignment.id}`;
  const [localUnit]=await si`SELECT * FROM finance.trk_units WHERE track_id=${unit.id}`;
  const [localCompany]=await si`SELECT id FROM finance.trk_companies WHERE track_id=${company.id}`;
  const pt=await call('POST','/master-pt',{namaPt:'Fixture PT',namaDirektur:'Director',perumahanId:localUnit.project_id,trackCompanyId:localCompany.id},201);
  const [cash]=await si`INSERT INTO finance.akun(kode,nama,kategori,tipe_saldo,klasifikasi,is_kas_bank,no_rekening) VALUES('111','Bank','aktiva','d','neraca',true,'123456') RETURNING id`;
  const [credit]=await si`INSERT INTO finance.akun(kode,nama,kategori,tipe_saldo,klasifikasi) VALUES('211','Customer advances','hutang','k','neraca') RETURNING id`;
  for(const key of ['titipan_booking_fee','uang_muka_penjualan','piutang_penjualan']) await si`INSERT INTO finance.akun_sistem(kunci,akun_id) VALUES(${key},${credit.id})`;
  const doc=await call('POST','/dokumen',{ptId:pt.id,kavlingId:localUnit.id,assignmentId:localAssignment.id,tanggalPerjanjian:'2026-10-01',hargaAwal:1000,uangMuka:200},201);
  await call('PUT',`/dokumen/${doc.id}/jadwal`,{tanggalAcuan:10,nominalPerBulan:100,tanggalMulai:'2026-10-01',jatuhTempoTerakhir:'2026-11-30'});
  await call('POST',`/dokumen/${doc.id}/finalisasi`);
  await cycle();
  await track`UPDATE si_billing_config SET enabled=true WHERE singleton`;
  const [pj]=await si`SELECT * FROM finance.penjualan_keuangan WHERE assignment_id=${localAssignment.id}`;
  const bills=await si`SELECT * FROM finance.jadwal_angsuran WHERE penjualan_id=${pj.id} ORDER BY no_urut`;
  const capture=createBillingCapture(track);
  const submission=(bill,extra={})=>({si_jadwal_id:bill.id,request_id:randomUUID(),tanggal_bayar:'2026-10-15',rekening_tujuan:'123456',bukti_pembayaran:'https://evidence.example.test/bukti.jpg',...extra});
  let payment,localPayment,posted;
  await t.test('only writer token and allowed source may deliver; retries and stale versions are safe',async()=>{
   const row=bills[0];
   const payload={siJadwalId:row.id,trackAssignmentId:assignment.id,aktif:false,versi:1};
   assert.equal((await source.inject({method:'PUT',url:'/sync/v1/schedules/'+row.id,headers:{authorization:'Bearer '+readToken,'idempotency-key':randomUUID()},payload})).statusCode,401);
   const key=randomUUID(),body={...payload,versi:999,aktif:true,noUrut:1,tanggal:'2026-10-10',jumlah:'100.00'};
   const send=async(b=body,k=key)=>source.inject({method:'PUT',url:'/sync/v1/schedules/'+row.id,headers:{authorization:'Bearer '+writeToken,'idempotency-key':k},payload:b});
   const first=await send();assert.equal(first.statusCode,200,first.body);assert.deepEqual((await send()).json(),first.json());
   assert.equal((await send({...body,jumlah:'101.00'})).statusCode,409);
   assert.equal((await send({...body,jumlah:'101.00'},randomUUID())).statusCode,409);
   assert.equal((await send({...body,versi:998},randomUUID())).json().data.applied,false);
   // Return to current sequence namespace before business scenarios.
   await track`UPDATE si_schedules SET versi=0 WHERE id=${row.id}`;
  });
  await t.test('amount tampering, another assignment, inactive bills and duplicate submissions are rejected',async()=>{
   await assert.rejects(track`INSERT INTO payment_history(assignment_id,jumlah_bayar,tanggal_bayar) VALUES(${assignment.id},1,'2026-10-15')`,/Pilih tagihan/);
   await assert.rejects(capture(assignment.id,submission(bills[1],{jumlah_bayar:99}),customer.id),/Nominal/);
   await assert.rejects(capture(randomUUID(),submission(bills[1]),customer.id),/Tagihan/);
   const request=submission(bills[1]);
   payment=await capture(assignment.id,request,customer.id);
   assert.equal((await capture(assignment.id,request,customer.id)).id,payment.id);
   await assert.rejects(capture(assignment.id,{...request,catatan:'different'},customer.id),/request_id/);
   await assert.rejects(capture(assignment.id,submission(bills[1]),customer.id),/sedang diproses/);
   await assert.rejects(track`UPDATE payment_history SET jumlah_bayar=99 WHERE id=${payment.id}`,/koreksi/);
   await assert.rejects(track`DELETE FROM payment_history WHERE id=${payment.id}`,/koreksi/);
   assert.equal(Number((await track`SELECT total_dibayar FROM property_assignments WHERE id=${assignment.id}`)[0].total_dibayar),0,'unverified submissions do not change customer paid total');
   await cycle();
   [localPayment]=await si`SELECT * FROM finance.trk_payments WHERE track_id=${payment.id}`;
   assert.equal((await si`SELECT status_proses FROM finance.status_pembayaran_si WHERE payment_id=${localPayment.id}`)[0].status_proses,'menunggu');
  });
  await t.test('SI verifies bill 2, journals exactly once, and never allocates it to unpaid bill 1',async()=>{
   const listed=async()=>(await call('GET',`/pembayaran-track?assignmentId=${localPayment.assignment_id}`)).find(r=>r.id===localPayment.id);
   const before=await listed();
   assert.equal(before.tagihan.id,localPayment.si_jadwal_id);
   assert.equal(before.tagihan.sisa,Number(localPayment.nominal),'dialog shows the remaining bill amount before verification');
   posted=await call('POST',`/pembayaran-track/${localPayment.id}/verifikasi`,{keputusan:'terima'});
   assert.equal(posted.statusProses,'dijurnal');
   await call('POST',`/pembayaran-track/${localPayment.id}/verifikasi`,{keputusan:'terima'});
   await cycle();await cycle();
   const allocations=await si`SELECT jadwal_id,nominal FROM finance.alokasi_pembayaran WHERE payment_id=${localPayment.id}`;
   assert.equal(allocations.length,1);assert.equal(allocations[0].jadwal_id,bills[1].id);
   assert.equal((await listed()).tagihan.sisa,Number(localPayment.nominal),'own allocation is excluded from the remaining amount');
   assert.equal((await si`SELECT count(*)::int n FROM finance.jurnal WHERE ref_type='trk_payments' AND ref_id=${localPayment.id}`)[0].n,1);
   const [remote]=await track`SELECT status_si,dikunci_si FROM payment_history WHERE id=${payment.id}`;
   assert.equal(remote.status_si,'dijurnal');assert.equal(remote.dikunci_si,true);
   assert.equal(Number((await track`SELECT total_dibayar FROM property_assignments WHERE id=${assignment.id}`)[0].total_dibayar),100);
   await call('POST',`/piutang/${pj.id}/alokasi/pindah`,{dariJadwalId:bills[1].id,keJadwalId:bills[0].id,nominal:10},409);
   await call('POST',`/pembayaran-track/${localPayment.id}/verifikasi`,{keputusan:'tolak',alasan:'cannot reject posted'},409);
  });
  await t.test('rejection is returned to Track; a fresh submission can be accepted; concurrent captures have one winner',async()=>{
   const entries=await Promise.allSettled([capture(assignment.id,submission(bills[0]),customer.id),capture(assignment.id,submission(bills[0]),customer.id)]);
   assert.equal(entries.filter(x=>x.status==='fulfilled').length,1);
   const rejected=entries.find(x=>x.status==='fulfilled').value;
   await cycle();
   const [p]=await si`SELECT id FROM finance.trk_payments WHERE track_id=${rejected.id}`;
   await call('POST',`/pembayaran-track/${p.id}/verifikasi`,{keputusan:'tolak'},400);
   await call('POST',`/pembayaran-track/${p.id}/verifikasi`,{keputusan:'tolak',alasan:'Wrong transfer evidence'});
   await cycle();
   assert.equal((await track`SELECT status_si FROM payment_history WHERE id=${rejected.id}`)[0].status_si,'ditolak');
   const next=await capture(assignment.id,submission(bills[0]),customer.id);assert.notEqual(next.id,rejected.id);
   await cycle();
   const [p2]=await si`SELECT id FROM finance.trk_payments WHERE track_id=${next.id}`;
   await call('POST',`/pembayaran-track/${p2.id}/verifikasi`,{keputusan:'tolak',alasan:'Test cleanup'});
   await cycle();
  });
  await t.test('adendum preserves settled history and only bills the remaining amount',async()=>{
   const add=await call('POST',`/dokumen/${doc.id}/adendum`,{alasan:'New due dates',tanggal:'2026-10-16'},201);
   await call('POST',`/dokumen/${add.id}/finalisasi`);
   const [al]=await si`SELECT jadwal_id FROM finance.alokasi_pembayaran WHERE payment_id=${localPayment.id}`;
   assert.equal(al.jadwal_id,bills[1].id);
   const [{n}]=await si`SELECT coalesce(sum(jumlah),0)::text n FROM finance.jadwal_angsuran WHERE penjualan_id=${pj.id} AND aktif`;
   assert.equal(Number(n),100);
   await cycle();
   assert.equal((await track`SELECT aktif FROM si_schedules WHERE id=${bills[1].id}`)[0].aktif,false);
   await assert.rejects(capture(assignment.id,submission(bills[0]),customer.id),/Tagihan/);
  });
  await t.test('journal reversal returns correction and releases allocated money without deleting history',async()=>{
   await call('POST',`/jurnal/${posted.jurnalId}/balik`,{tanggal:'2026-10-17',uraian:'Reverse fixture transfer'},201);
   await cycle();
   assert.equal((await track`SELECT status_si FROM payment_history WHERE id=${payment.id}`)[0].status_si,'dikoreksi');
   assert.equal(Number((await track`SELECT total_dibayar FROM property_assignments WHERE id=${assignment.id}`)[0].total_dibayar),0);
   assert.equal((await si`SELECT count(*)::int n FROM finance.alokasi_pembayaran WHERE payment_id=${localPayment.id}`)[0].n,0);
   assert.equal((await si`SELECT status FROM finance.jurnal WHERE id=${posted.jurnalId}`)[0].status,'dikoreksi');
  });
  await t.test('all house bill kinds, immutable settled bills and bounded contract totals',async()=>{
   await call('PUT',`/piutang/${pj.id}/tagihan`,{id:bills[1].id,noUrut:2,tanggal:'2026-11-10',jumlah:100,jenis:'uang_muka',aktif:true},409);
   for(const [i,jenis] of ['booking_fee','uang_muka','angsuran','pencairan_kpr'].entries()) {
    await call('PUT',`/piutang/${pj.id}/tagihan`,{noUrut:10+i,tanggal:'2026-12-01',jumlah:100,jenis,keterangan:jenis,aktif:true});
   }
   await call('PUT',`/piutang/${pj.id}/tagihan`,{noUrut:99,tanggal:'2026-12-01',jumlah:1000,jenis:'angsuran',aktif:true},422);
   const daftar=await call('GET',`/piutang/${pj.id}/tagihan`);
   assert.equal(daftar.billingEnabled,true);
   assert.equal(daftar.totalAktif,daftar.items.filter(b=>b.aktif).reduce((n,b)=>n+b.jumlah,0));
   assert.equal(daftar.sisaPlafon,daftar.nilaiSppr-daftar.totalAktif-daftar.pembayaranHistoris,'UI headroom matches the save() limit');
   assert.equal(daftar.items.find(b=>b.id===bills[1].id).terkunci,true,'bill with payment history is locked in the UI');
   assert.equal(daftar.items.find(b=>b.noUrut===13).terkunci,false);
   await call('PUT',`/piutang/${pj.id}/tagihan`,{noUrut:98,tanggal:'2026-12-01',jumlah:daftar.sisaPlafon+1,jenis:'angsuran',aktif:true},422);
   await call('GET',`/piutang/${randomUUID()}/tagihan`,undefined,404);
   await cycle();
  });
  await t.test('committed receiver response loss retries the same inbox key; semantic 409 stays failed',async()=>{
   const [{id}]=await si`SELECT id FROM finance.jadwal_angsuran WHERE aktif AND jenis='angsuran' LIMIT 1`;
   await call('PUT',`/piutang/${pj.id}/tagihan`,{id,noUrut:12,tanggal:'2026-12-02',jumlah:100,jenis:'angsuran',aktif:true});
   const {TrackError}=await import('../src/sync/track-client.js');
   const failed=await runCycle({client:{...client,putSchedule:async(...args)=>{await client.putSchedule(...args);throw new TrackError('response lost');}}});
   assert.equal(failed.kirim.counts.gagalKirim,1);
   await cycle();
   assert.equal((await si`SELECT count(*)::int n FROM finance.outbox_track WHERE status='gagal'`)[0].n,0);
   await call('PUT',`/piutang/${pj.id}/tagihan`,{id,noUrut:12,tanggal:'2026-12-03',jumlah:100,jenis:'angsuran',aktif:true});
   const conflict=await runCycle({client:{...client,putSchedule:async()=>{throw new TrackError('semantic conflict',{status:409,retryable:false});}}});
   assert.equal(conflict.kirim.counts.gagalKirim,1);assert.equal(conflict.kirim.counts.terkirim,0);
   await cycle();
  });
  await t.test('source identity mismatch stops pull and failed writes remain pending',async()=>{
   const [state]=await si`SELECT cursor_seq,cursor_txid FROM finance.sync_cursor WHERE id='global'`;
   await assert.rejects(runCycle({client:{...client,eventsV2:async(...args)=>({...await client.eventsV2(...args),source_id:randomUUID()})}}),/Identitas sumber/);
   const [after]=await si`SELECT cursor_seq,cursor_txid FROM finance.sync_cursor WHERE id='global'`;
   assert.deepEqual(after,state);
   env.sync.writeEnabled=false;assert.equal((await runCycle()).kirim.status,'ditahan');env.sync.writeEnabled=true;
  });
  await t.test('reverse reconciliation detects content drift even when no outbox is pending and repairs the mirror',async()=>{
   const [{id}]=await track`SELECT id FROM si_schedules WHERE aktif LIMIT 1`;
   await track`UPDATE si_schedules SET jumlah=jumlah+1 WHERE id=${id}`;
   const observed=await runReconcile();
   assert.equal(observed.billing.status,'beda');assert.equal(observed.billing.result.cocok,false);
   assert.ok(observed.billing.result.tagihan.selisih.includes(id));
   await cycle();await cycle();
   const repaired=await runReconcile();assert.equal(repaired.billing.result.cocok,true,JSON.stringify(repaired.billing.result));
  });
  await t.test('retryable failure during resnapshot holds reverse writes until bootstrap finishes',async()=>{
   const {prepareResnapshot}=await import('../src/sync/runner.js');
   const {TrackError}=await import('../src/sync/track-client.js');
   await prepareResnapshot((await client.startV2()).source_id);
   const interrupted=await runCycle({client:{...client,snapshot:async(...args)=>{
    if(args[0]==='projects') throw new TrackError('temporary read outage');return client.snapshot(...args);
   }}});
   assert.equal(interrupted.tarik.status,'gagal');assert.equal(interrupted.kirim.status,'ditahan');
   assert.ok((await si`SELECT bootstrap FROM finance.sync_cursor WHERE id='global'`)[0].bootstrap);
   await cycle();await cycle();
   assert.equal((await si`SELECT bootstrap FROM finance.sync_cursor WHERE id='global'`)[0].bootstrap,null);
  });
  await t.test('a late Track commit is held, then both transactions reach SI without losing the lower sequence',async()=>{
   let opened,release;
   const ready=new Promise(resolve=>{opened=resolve;});
   const gate=new Promise(resolve=>{release=resolve;});
   const low=randomUUID(),high=randomUUID();
   const pending=track.begin(async tx=>{await tx`INSERT INTO companies(id,nama_pt) VALUES(${low},'Late commit')`;opened();await gate;});
   await ready;
   try {
    await track`INSERT INTO companies(id,nama_pt) VALUES(${high},'Early commit')`;
    const r=await cycle();assert.ok(r.tarik.result.tertahanSejak);
    assert.equal((await si`SELECT count(*)::int n FROM finance.trk_companies WHERE track_id IN (${low},${high})`)[0].n,0);
   } finally {release();await pending;}
   await cycle();
   assert.equal((await si`SELECT count(*)::int n FROM finance.trk_companies WHERE track_id IN (${low},${high})`)[0].n,2);
  });
  await t.test('backlog crosses page boundaries and concurrent cycles cannot overlap',async()=>{
   await track`INSERT INTO companies(nama_pt) SELECT 'Backlog ' || i FROM generate_series(1,503) i`;
   const r=await cycle();assert.equal(r.tarik.counts.baru,503);
   const runs=await Promise.all([runCycle(),runCycle()]);
   assert.equal(runs.filter(x=>x.dilewati).length,1);
  });
  await t.test('retention expiry refuses incremental sync; controlled resnapshot preserves financial history',async()=>{
   await track`UPDATE sync_outbox SET created_at=now()-interval '40 days'`;
   assert.ok(Number((await track`SELECT sync_prune_outbox(interval '30 days') n`)[0].n)>0);
   await assert.rejects(client.eventsV2('0:0'),e=>e.status===410 && !e.retryable);
   await si`UPDATE finance.sync_cursor SET cursor_txid=0,cursor_seq=0 WHERE id='global'`;
   const blocked=await runCycle();assert.equal(blocked.tarik.status,'gagal');assert.equal(blocked.kirim.status,'ditahan');
   const start=await client.startV2();
   const {prepareResnapshot}=await import('../src/sync/runner.js');
   await prepareResnapshot(start.source_id);await cycle();await cycle();
   const r=await runReconcile();assert.equal(r.result.filter(x=>x.cocok).length,7);
   assert.equal((await si`SELECT status FROM finance.jurnal WHERE id=${posted.jurnalId}`)[0].status,'dikoreksi');
  });
  await t.test('restricted reader cannot fetch account secrets or write; writer cannot change nominal',async()=>{
   await track.unsafe(await readFile(new URL('../../../Podorukuntrack/backend/staging/integration-roles.sql',import.meta.url),'utf8'));
   await track.unsafe(await readFile(new URL('../../../Podorukuntrack/backend/staging/integration-grants.sql',import.meta.url),'utf8'));
   await track.unsafe('ALTER ROLE prtrack_integration_reader LOGIN; ALTER ROLE prtrack_integration_writer LOGIN; ALTER TABLE users ADD COLUMN password_hash text');
   const u=new URL(process.env.TEST_TRACK_DATABASE_URL);u.username='prtrack_integration_reader';
   const restricted=postgres(u.toString(),{prepare:false,max:1});
   const {createSyncRepository}=await import('../../../Podorukuntrack/backend/src/modules/sync/sync.repository.js');
   const repo=createSyncRepository(restricted);
   try {
    assert.equal((await repo.getSnapshot({entity:'customers',pageAfterId:null,limit:10})).rows.length,1);
    assert.equal((await repo.getChecksumV2({entity:'payments'})).count,3);
    await assert.rejects(restricted`SELECT password_hash FROM users`,e=>e.code==='42501');
    await assert.rejects(restricted`UPDATE payment_history SET jumlah_bayar=1`,e=>['42501','25006'].includes(e.code));
   } finally {await restricted.end();}
   u.username='prtrack_integration_writer';const writer=postgres(u.toString(),{prepare:false,max:1});
   try {
    await assert.rejects(writer`UPDATE payment_history SET jumlah_bayar=1`,e=>e.code==='42501');
    await writer.begin(async tx=>{
     await tx`SELECT set_config('prtrack.finance_writer','result',true)`;
     await tx`UPDATE payment_history SET status_si=status_si WHERE id=${payment.id}`;
    });
   } finally {await writer.end();}
  });
  await t.test('all financial and typed-mirror invariants remain zero after the full lifecycle',async()=>{
   const {INVARIANTS,mirrorInvariantSql}=await import('../src/monitoring/invariants.js');
   await si.begin('read only',async tx=>{
    await tx`SET LOCAL TIME ZONE 'UTC'`;
    for(const [name,query] of Object.entries(INVARIANTS)) assert.equal(Number((await tx.unsafe(query))[0].count),0,name);
    for(const entity of ['companies','projects','clusters','units','customers','assignments','payments']) assert.equal(Number((await tx.unsafe(mirrorInvariantSql(entity)))[0].count),0,entity);
   });
  });
  await t.test('generated cutover SQL refuses an unconfirmed target and is repeatable on the confirmed test source',async()=>{
   const file=new URL('../../../Podorukuntrack/backend/staging/generated/billing-v2-cutover.sql',import.meta.url);
   const sql=await readFile(file,'utf8');
   const isolated=await track.reserve();
   try {
    await assert.rejects(isolated.unsafe(sql),/Explicit target/);await isolated`ROLLBACK`;
    const [{name}]=await isolated`SELECT current_database() name`;
    await isolated`SELECT set_config('prtrack.target_database',${name},false),set_config('prtrack.sync_migration_approved','billing-v2-20261019',false)`;
    const sourceId=(await client.startV2()).source_id;
    for(let i=0;i<2;i++) await isolated.unsafe(sql);
    assert.equal((await client.startV2()).source_id,sourceId);
    assert.equal((await isolated`SELECT count(*)::int n FROM payment_history`)[0].n,3);
    // Backfill pembayaran lama (keputusan 21 Okt 2026): hanya sekali, hanya baris sebelum penanda.
    await isolated`DELETE FROM public.si_legacy_backfill`;
    await isolated`UPDATE si_billing_config SET enabled=false WHERE singleton`;
    const legacy=await isolated`INSERT INTO payment_history(assignment_id,jumlah_bayar,tanggal_bayar,is_auto_inject)
      VALUES(${assignment.id},10,'2025-01-02',false),(${assignment.id},20,'2025-01-03',true) RETURNING id`;
    await isolated.unsafe(sql);
    const filled=await isolated`SELECT jenis,status_verifikasi,diverifikasi_oleh FROM payment_history WHERE id IN ${isolated(legacy.map(r=>r.id))} ORDER BY jumlah_bayar`;
    assert.deepEqual(filled.map(r=>[r.jenis,r.status_verifikasi]),[['uang_muka','terverifikasi'],['pencairan_kpr','terverifikasi']]);
    assert.match(filled[0].diverifikasi_oleh,/Sistem lama/);
    const billed=await isolated`SELECT count(*)::int n FROM payment_history WHERE si_jadwal_id IS NOT NULL AND diverifikasi_oleh LIKE 'Sistem lama%'`;
    assert.equal(billed[0].n,0,'bill-linked submissions are never auto-verified');
    const [late]=await isolated`INSERT INTO payment_history(assignment_id,jumlah_bayar,tanggal_bayar) VALUES(${assignment.id},30,'2025-01-04') RETURNING id`;
    await isolated.unsafe(sql);
    const [after]=await isolated`SELECT jenis,status_verifikasi FROM payment_history WHERE id=${late.id}`;
    assert.deepEqual([after.jenis,after.status_verifikasi],[null,'menunggu'],'rerunning cutover SQL does not validate later payments');
    const marker=await isolated`SELECT rows_updated FROM public.si_legacy_backfill`;
    assert.deepEqual(marker.map(r=>r.rows_updated),[2]);
    await isolated`DELETE FROM payment_history WHERE id IN ${isolated([...legacy.map(r=>r.id),late.id])}`;
    await isolated`UPDATE si_billing_config SET enabled=true WHERE singleton`;
    // Cakupan pilot: billing hanya untuk perusahaan terdaftar; perusahaan lain tetap alur lama.
    const [{applies}]=await isolated`SELECT public.si_billing_applies(${assignment.id}::uuid) AS applies`;
    assert.equal(applies,true,'company_ids NULL covers every company');
    await isolated`UPDATE si_billing_config SET company_ids=ARRAY[gen_random_uuid()] WHERE singleton`;
    assert.equal((await isolated`SELECT public.si_billing_applies(${assignment.id}::uuid) AS a`)[0].a,false);
    const [outside]=await isolated`INSERT INTO payment_history(assignment_id,jumlah_bayar,tanggal_bayar) VALUES(${assignment.id},5,'2026-10-20') RETURNING id`;
    assert.ok(outside.id,'assignments outside the pilot keep the legacy input');
    await isolated`DELETE FROM payment_history WHERE id=${outside.id}`;
    const [{company}]=await isolated`SELECT p.company_id AS company FROM property_assignments a JOIN units u ON u.id=a.unit_id JOIN clusters k ON k.id=u.cluster_id JOIN projects p ON p.id=k.project_id WHERE a.id=${assignment.id}`;
    await isolated`UPDATE si_billing_config SET company_ids=ARRAY[${company}::uuid] WHERE singleton`;
    await assert.rejects(isolated`INSERT INTO payment_history(assignment_id,jumlah_bayar,tanggal_bayar) VALUES(${assignment.id},5,'2026-10-20')`,/Pilih tagihan/);
    await isolated`UPDATE si_billing_config SET company_ids=NULL WHERE singleton`;
   } finally {isolated.release();}
  });
  await t.test('dedicated integration process starts with restricted credentials and accepts only scoped writes',async()=>{
   const start=await client.startV2();
   const u=new URL(process.env.TEST_TRACK_DATABASE_URL);u.username='prtrack_integration_reader';
   const w=new URL(u);w.username='prtrack_integration_writer';
   const child=spawn(process.execPath,[fileURLToPath(new URL('../../../Podorukuntrack/backend/src/sync-server.js',import.meta.url))],{
    env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,NODE_ENV:'development',TRACK_SYNC_HOST:'127.0.0.1',TRACK_SYNC_PORT:'0',TRACK_SYNC_ALLOWED_IPS:'127.0.0.1',
      TRACK_SYNC_SOURCE_ID:start.source_id,TRACK_SYNC_DATABASE_URL:u.toString(),TRACK_SYNC_WRITER_DATABASE_URL:w.toString(),TRACK_SYNC_TOKEN:readToken,TRACK_SCHEDULE_TOKEN:writeToken,SYNC_WRITE_ENABLED:'true'},
    stdio:['ignore','pipe','pipe'],windowsHide:true,
   });
   try {
    const address=await new Promise((resolve,reject)=>{
     const timer=setTimeout(()=>reject(new Error('integration listener startup timeout')),10000);
     child.stdout.on('data',buffer=>{const m=buffer.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});
     child.once('exit',code=>{clearTimeout(timer);reject(new Error('integration listener exited '+code));});
     child.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    assert.equal((await fetch(address+'/health')).status,200);
    assert.equal((await fetch(address+'/sync/v2/start',{headers:{authorization:'Bearer '+readToken}})).status,200);
    const response=await fetch(address+'/sync/v1/payment-results/'+randomUUID(),{method:'PUT',headers:{authorization:'Bearer '+writeToken,'idempotency-key':randomUUID(),'content-type':'application/json'},body:JSON.stringify({trackPaymentId:randomUUID(),siJadwalId:null,status:'ditolak',versi:99999})});
    assert.equal(response.status,400,'route/body key mismatch fails before any write');
    const missing=randomUUID();
    const validMissing=await fetch(address+'/sync/v1/payment-results/'+missing,{method:'PUT',headers:{authorization:'Bearer '+writeToken,'idempotency-key':randomUUID(),'content-type':'application/json'},body:JSON.stringify({trackPaymentId:missing,siJadwalId:null,status:'ditolak',versi:99999})});
    assert.equal(validMissing.status,404,'restricted writer can read the target without broad write rights');
    const [bill]=await track`SELECT * FROM si_schedules WHERE aktif ORDER BY no_urut LIMIT 1`;
    const positive=await fetch(address+'/sync/v1/schedules/'+bill.id,{method:'PUT',headers:{authorization:'Bearer '+writeToken,'idempotency-key':randomUUID(),'content-type':'application/json'},body:JSON.stringify({siJadwalId:bill.id,trackAssignmentId:bill.assignment_id,noUrut:bill.no_urut,tanggal:bill.tanggal instanceof Date?bill.tanggal.toISOString().slice(0,10):bill.tanggal,jumlah:bill.jumlah,jenis:bill.jenis,keterangan:bill.keterangan,aktif:bill.aktif,realisasi:bill.realisasi,nilaiKontrak:'1000.00',versi:100000})});
    assert.equal(positive.status,200,await positive.text());
   } finally {if(child.exitCode===null && child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}}
  });
  await t.test('existing Track application account works without CREATEROLE and only through scoped APIs',async()=>{
   await track.unsafe(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='prtrack_existing_app_fixture') THEN
     CREATE ROLE prtrack_existing_app_fixture LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
   END $$;`);
   for(const table of ['companies','projects','clusters','units','users','property_assignments','payment_history']) {
    await track.unsafe(`ALTER TABLE public.${table} OWNER TO prtrack_existing_app_fixture`);
   }
   await track.unsafe('GRANT USAGE ON SCHEMA public TO prtrack_existing_app_fixture; GRANT ALL ON ALL TABLES IN SCHEMA public TO prtrack_existing_app_fixture; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO prtrack_existing_app_fixture');
   const u=new URL(process.env.TEST_TRACK_DATABASE_URL);u.username='prtrack_existing_app_fixture';
   const existing=postgres(u.toString(),{prepare:false,max:1});
   try {assert.equal((await existing`SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user`)[0].rolcreaterole,false);}
   finally {await existing.end();}
   const config={TRACK_SYNC_SOURCE_ID:(await client.startV2()).source_id,TRACK_SYNC_DATABASE_URL:u.toString(),TRACK_SYNC_TOKEN:readToken,TRACK_SCHEDULE_TOKEN:writeToken,SYNC_WRITE_ENABLED:'true'};
   await assert.rejects(withIntegrationProcess(config,()=>assert.fail('owner silently accepted')),/restricted read-only role/);
   const selected={...config,TRACK_SYNC_DB_MODE:'application',TRACK_SYNC_DB_USER:'prtrack_existing_app_fixture'};
   for(const [override,error] of [
    [{TRACK_SYNC_DB_MODE:'typo'},/must be restricted or application/],
    [{TRACK_SYNC_DB_USER:''},/explicit TRACK_SYNC_DB_USER/],
    [{TRACK_SYNC_DB_USER:'wrong_account'},/pinned owner/],
    [{TRACK_SYNC_DATABASE_URL:process.env.TEST_TRACK_DATABASE_URL},/administrative privileges/],
    [{TRACK_SYNC_WRITER_DATABASE_URL:process.env.TEST_TRACK_DATABASE_URL},/one Track database connection string/],
    [{TRACK_SYNC_SOURCE_ID:randomUUID()},/source identity mismatch/],
    [{TRACK_SCHEDULE_TOKEN:readToken},/tokens must be independent/],
   ]) await assert.rejects(withIntegrationProcess({...selected,...override},()=>assert.fail('invalid config accepted')),error);
   await withIntegrationProcess(selected,async address=>{
    assert.equal((await fetch(address+'/health')).status,200);
    const start=await fetch(address+'/sync/v2/start',{headers:{authorization:'Bearer '+readToken}});
    assert.equal(start.status,200);
    const [bill]=await track`SELECT * FROM si_schedules WHERE aktif ORDER BY no_urut LIMIT 1`;
    const body={siJadwalId:bill.id,trackAssignmentId:bill.assignment_id,noUrut:bill.no_urut,tanggal:bill.tanggal instanceof Date?bill.tanggal.toISOString().slice(0,10):bill.tanggal,jumlah:bill.jumlah,jenis:bill.jenis,keterangan:bill.keterangan,aktif:bill.aktif,realisasi:bill.realisasi,nilaiKontrak:'1000.00',versi:100001};
    const key=randomUUID();
    const put=(token,b=body,id=key)=>fetch(address+'/sync/v1/schedules/'+bill.id,{method:'PUT',headers:{authorization:'Bearer '+token,'idempotency-key':id,'content-type':'application/json'},body:JSON.stringify(b)});
    assert.equal((await put(readToken)).status,401);
    assert.equal((await put(writeToken,{...body,sql:'DELETE FROM users'})).status,400);
    const applied=await put(writeToken);assert.equal(applied.status,200,await applied.text());
    assert.equal((await put(writeToken)).status,200,'same key can retry');
    assert.equal((await put(writeToken,{...body,jumlah:'999'})).status,409,'key cannot be reused for a different payload');
    assert.equal((await fetch(address+'/sync/v1/billing-snapshot/schedules',{headers:{authorization:'Bearer '+readToken}})).status,401);
    assert.equal((await fetch(address+'/sync/v1/billing-snapshot/schedules',{headers:{authorization:'Bearer '+writeToken}})).status,200);
    // Use the same HTTP client as the SI worker for a whitelist snapshot.
    const cfg={...env.sync,trackApiUrl:address+'/',readToken,writeToken};
    const httpClient=createTrackClient(cfg);
    const customerPage=await httpClient.snapshot('customers',null,10);
    assert.equal(customerPage.rows.length,1);
    assert.equal('password_hash' in customerPage.rows[0],false);
    assert.equal((await fetch(address+'/sync/v1/sql',{method:'POST',headers:{authorization:'Bearer '+writeToken,'content-type':'application/json'},body:'{}'})).status,404);
   });
   await withIntegrationProcess({...selected,SYNC_WRITE_ENABLED:'false'},async address=>{
    assert.equal((await fetch(address+'/sync/v2/start',{headers:{authorization:'Bearer '+readToken}})).status,200);
    assert.equal((await fetch(address+'/sync/v1/billing-snapshot/schedules',{headers:{authorization:'Bearer '+writeToken}})).status,404);
   });
  });
 } finally {await api?.close();await closeDatabase?.();await source?.close();await track.end();await si.end();}
});
