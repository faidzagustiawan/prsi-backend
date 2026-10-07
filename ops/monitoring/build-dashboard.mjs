import { writeFileSync, mkdirSync } from 'node:fs';
const panels=[];
let id=0, y=0;
const row=(title)=>{panels.push({id:++id,type:'row',title,gridPos:{x:0,y,w:24,h:1},collapsed:false});y++;};
const panel=(title,expr,type='timeseries',legend='{{instance}}')=>{
  panels.push({id:++id,title,type,gridPos:{x:0,y,w:24,h:7},datasource:{type:'prometheus',uid:'prometheus'},
    targets:[{refId:'A',expr,legendFormat:legend}],
    fieldConfig:{defaults:{noValue:'UNKNOWN',color:{mode:'thresholds'},thresholds:{mode:'absolute',steps:[{color:'red',value:null},{color:'green',value:1}]}},overrides:[]},
    options:type==='stat'?{colorMode:'background',reduceOptions:{calcs:['lastNotNull'],fields:'',values:false}}:{legend:{displayMode:'list',placement:'bottom'}}}); y+=7;
};
row('Ringkasan');
panel('Semua target dapat di-scrape', 'min(up)', 'stat');
panel('Integritas tersedia dan tanpa pelanggaran', '(min(monitor_collection_success) == bool 1) * (max(accounting_invariant_violations) == bool 0)', 'stat');
panel('Tujuh entitas cocok — pending/unknown bukan sehat', 'sum(sync_entity_match == bool 1) == bool 7', 'stat');
row('Uptime dan host');
panel('Health API publik dan Track staging','probe_success');
panel('Uptime host (detik)','time() - node_boot_time_seconds');
panel('RAM terpakai (rasio)','1-node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes');
panel('Disk terpakai (rasio)','1-node_filesystem_avail_bytes{mountpoint="/"}/node_filesystem_size_bytes{mountpoint="/"}');
panel('Service backend aktif','node_systemd_unit_state{name="podorukun-si-api.service",state="active"}', 'stat');
row('API');
panel('Request per detik','rate(api_requests_total[5m])');
panel('Error 5xx per detik','rate(api_errors_5xx_total[5m])');
panel('Latensi p95 (detik)','histogram_quantile(0.95, sum by(le)(rate(api_request_duration_seconds_bucket[5m])))');
row('Sinkronisasi Track ↔ PRSI');
panel('Status entitas: 1 cocok, 0 mismatch, -1 pending','sync_entity_match','timeseries','{{entity}}');
panel('Jumlah baris Track','sync_entity_rows_track','timeseries','{{entity}}');
panel('Jumlah baris PRSI','sync_entity_rows_prsi','timeseries','{{entity}}');
panel('Umur siklus terakhir / held / beda teramati','{__name__=~"sync_last_cycle_age_seconds|sync_held_seconds|sync_observed_difference_seconds"}','timeseries','{{__name__}} {{entity}}');
panel('Galat sinkron belum selesai','sync_error_unresolved');
row('Integritas pembukuan');
panel('Jumlah pelanggaran — target 0','accounting_invariant_violations','timeseries','{{invariant}}');
panel('Umur cache pemeriksaan (detik)','monitor_collection_age_seconds');
row('Backup');
panel('Umur backup (detik) — batas 93600','backup_last_age_seconds');
panel('Bukti backup tersedia','backup_timestamp_available','stat');
// Keep the complete historical views available without extending the overview.
const details = panels.splice(0).filter(p => p.type !== 'row');
details.forEach((p,index) => { p.gridPos = {x:(index%2)*12,y:13+Math.floor(index/2)*7,w:12,h:7}; });
const colors = (steps) => ({mode:'absolute',steps:steps.map(([value,color])=>({value,color}))});
const good = colors([[null,'red'],[1,'green']]);
const zeroGood = colors([[null,'green'],[1,'red']]);
const map = (values) => [{type:'value',options:Object.fromEntries(Object.entries(values).map(([key,text])=>[key,{text}]))}];
function compact(title,description,pos,targets,{unit='short',thresholds=good,mappings=[],noValue='N/A',type='stat',colorMode='value'}={}) {
  const p={id:++id,title,description,type,gridPos:pos,datasource:{type:'prometheus',uid:'prometheus'},
    targets:targets.map(([expr,legend],i)=>({refId:String.fromCharCode(65+i),expr,legendFormat:legend,instant:type!=='timeseries',range:type==='timeseries'})),
    fieldConfig:{defaults:{unit,noValue,mappings:[...mappings,...['null','nan'].map(match=>({type:'special',options:{match,result:{text:noValue,color:'gray'}}}))],color:{mode:'thresholds'},thresholds,decimals:unit==='percentunit'?0:undefined},overrides:[]},
    options:type==='stat'?{colorMode,graphMode:'none',textMode:'auto',orientation:'auto',wideLayout:true,justifyMode:'auto',text:{titleSize:12,valueSize:24},reduceOptions:{calcs:['lastNotNull'],fields:'',values:false}}
      :type==='bargauge'?{orientation:'horizontal',displayMode:'basic',showUnfilled:true,reduceOptions:{calcs:['lastNotNull'],fields:'',values:false}}
      :{legend:{displayMode:'list',placement:'bottom'},tooltip:{mode:'multi'}}};
  panels.push(p);return p;
}
compact('LAYANAN','Semua target terpantau, kedua health probe berhasil, dan service PRSI aktif.',{x:0,y:0,w:6,h:3},[
  ['min(up) * min(probe_success) * min(node_systemd_unit_state{name="podorukun-si-api.service",state="active"})','Layanan']
],{mappings:map({0:'PERIKSA',1:'SEHAT'}),colorMode:'background'});
compact('INTEGRITAS','Seluruh aturan yang dipantau harus nol; pemeriksaan harus berhasil dan berumur paling lama 11 menit.',{x:6,y:0,w:6,h:3},[
  ['(min(monitor_collection_success) == bool 1) * (max(accounting_invariant_violations) == bool 0) * (max(monitor_collection_age_seconds) <= bool 660)','Integritas']
],{mappings:map({0:'PERIKSA',1:'VALID'}),colorMode:'background'});
compact('DATA COCOK','Jumlah entitas yang isi dan jumlah barisnya cocok. Pembanding adalah Track STAGING, bukan production.',{x:12,y:0,w:6,h:3},[
  ['sum((sync_entity_match == bool 1) * on(entity) (sync_checker_success == bool 1))','Entitas']
],{thresholds:colors([[null,'orange'],[7,'green']]),mappings:map({7:'7 / 7 COCOK'}),colorMode:'background'});
compact('BACKUP TERAKHIR','Umur backup yang berhasil diverifikasi. Batas peringatan 26 jam; unknown berarti bukti tidak tersedia.',{x:18,y:0,w:6,h:3},[
  ['backup_last_age_seconds','Umur backup']
],{unit:'s',thresholds:colors([[null,'green'],[86400,'orange'],[93600,'red']]),colorMode:'background'});
const entities=compact('Track staging ↔ PRSI','Setiap entitas: cocok, beda isi terkonfirmasi, atau pending. Pemeriksaan berjalan setiap dua menit.',{x:0,y:3,w:12,h:5},[
  ['sync_entity_match','{{entity}}']
],{type:'bargauge',thresholds:colors([[null,'orange'],[0,'red'],[1,'green']]),mappings:map({'-1':'PENDING',0:'BEDA',1:'COCOK'})});
entities.fieldConfig.defaults.min=0;entities.fieldConfig.defaults.max=1;
entities.options.text={titleSize:12,valueSize:14};
entities.options.minVizHeight=16;
const host=compact('Kapasitas server','Aplikasi = VPS backend; Monitor = VPS monitoring. Hijau <80%, kuning 80–90%, merah ≥90%.',{x:12,y:3,w:6,h:5},[
  ['1-node_memory_MemAvailable_bytes{instance="10.11.26.196:9100"}/node_memory_MemTotal_bytes{instance="10.11.26.196:9100"}','RAM · Aplikasi'],
  ['1-node_memory_MemAvailable_bytes{instance="127.0.0.1:9100"}/node_memory_MemTotal_bytes{instance="127.0.0.1:9100"}','RAM · Monitor'],
  ['1-node_filesystem_avail_bytes{mountpoint="/",instance="10.11.26.196:9100"}/node_filesystem_size_bytes{mountpoint="/",instance="10.11.26.196:9100"}','Disk · Aplikasi'],
  ['1-node_filesystem_avail_bytes{mountpoint="/",instance="127.0.0.1:9100"}/node_filesystem_size_bytes{mountpoint="/",instance="127.0.0.1:9100"}','Disk · Monitor']
],{type:'bargauge',unit:'percentunit',thresholds:colors([[null,'green'],[0.8,'orange'],[0.9,'red']])});
host.fieldConfig.defaults.min=0;host.fieldConfig.defaults.max=1;
const api=compact('API · 5 menit terakhir','Latensi kosong saat belum ada request dalam jendela lima menit. Ini bukan bukti API mati; lihat status layanan.',{x:18,y:3,w:6,h:5},[
  ['rate(api_requests_total[5m])','Request / detik'],
  ['rate(api_errors_5xx_total[5m])','Error 5xx / detik'],
  ['histogram_quantile(0.95, sum by(le)(rate(api_request_duration_seconds_bucket[5m])))','Latensi p95']
],{thresholds:colors([[null,'blue']]),noValue:'—'});
api.options.orientation='vertical';
api.options.text={titleSize:12,valueSize:20};
api.fieldConfig.overrides=[{matcher:{id:'byName',options:'Latensi p95'},properties:[{id:'unit',value:'s'}]}];
compact('Lalu lintas API','Tren request dan error server. Gunakan rentang waktu di pojok kanan atas.',{x:0,y:8,w:12,h:4},[
  ['rate(api_requests_total[5m])','Request / detik'],['rate(api_errors_5xx_total[5m])','Error 5xx / detik']
],{type:'timeseries',thresholds:colors([[null,'blue']])}).fieldConfig.defaults.color={mode:'palette-classic'};
compact('Galat & pelanggaran','Target semua nol. Rincian jenis pelanggaran tersedia dalam bagian yang dapat dibuka di bawah.',{x:12,y:8,w:6,h:4},[
  ['sum(accounting_invariant_violations)','Pelanggaran'],['sync_error_unresolved','Galat sinkron'],['outbox_failed','Outbox gagal']
],{thresholds:zeroGood});
compact('Kesegaran pemeriksaan','Umur cache ideal ≤5 menit; held berarti sinkronisasi tertahan. Umur siklus terakhir bukan umur event sumber dan tersedia di rincian.',{x:18,y:8,w:6,h:4},[
  ['monitor_collection_age_seconds','Umur pemeriksaan'],['sync_held_seconds','Tertahan']
],{unit:'s',thresholds:colors([[null,'green'],[600,'orange'],[660,'red']])});
panels.push({id:++id,type:'row',title:'Rincian · jumlah baris, aturan pembukuan, uptime & riwayat',gridPos:{x:0,y:12,w:24,h:1},collapsed:true,panels:details});
mkdirSync(new URL('./grafana/dashboards/',import.meta.url),{recursive:true});
writeFileSync(new URL('./grafana/dashboards/prsi.json',import.meta.url),JSON.stringify({uid:'prsi-monitoring',title:'PRSI — Ringkasan Monitoring',description:'Ringkasan satu layar untuk Track staging ↔ PRSI. Buka Rincian untuk pemeriksaan mendalam.',schemaVersion:41,version:2,timezone:'Asia/Jakarta',refresh:'30s',time:{from:'now-1h',to:'now'},tags:['PRSI'],panels},null,2)+'\n');
