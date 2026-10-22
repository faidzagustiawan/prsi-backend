import {writeFileSync, mkdirSync} from 'node:fs';
// Sumber pembanding sinkronisasi. Checker membaca checksum Track production
// lewat relay baca-saja di host PRSI (10.11.26.196:9443/track-checksum/).
const SYNC_SOURCE = process.env.SYNC_SOURCE || 'Track production';
const panels=[];
let id=0;
const datasource={type:'prometheus',uid:'prometheus'};
const thresholds=(steps)=>({mode:'absolute',steps:steps.map(([value,color])=>({value,color}))});
const capacity=thresholds([[null,'green'],[0.8,'orange'],[0.9,'red']]);
const healthy=thresholds([[null,'red'],[1,'green']]);
const zeroGood=thresholds([[null,'green'],[1,'red']]);
const nullDash={type:'special',options:{match:'null',result:{text:'—',color:'gray'}}};
const mappings=(values)=>[{type:'value',options:Object.fromEntries(Object.entries(values).map(([k,text])=>[k,{text}]))}];
const upDown=[...mappings({0:'DOWN',1:'UP'}),nullDash];
function panel(title,type,pos,queries,config={}) {
  const p={id:++id,title,type,gridPos:pos,datasource,description:config.description||'',
    targets:queries.map(([expr,legend],i)=>({refId:String.fromCharCode(65+i),expr,legendFormat:legend,format:type==='table'?'table':'time_series',instant:type!=='timeseries',range:type==='timeseries'})),
    fieldConfig:{defaults:{unit:config.unit||'short',noValue:config.noValue||'—',decimals:config.decimals??(config.unit==='percentunit'?0:undefined),
      color:{mode:type==='timeseries'?'palette-classic':'thresholds'},thresholds:config.thresholds||zeroGood,mappings:config.mappings||[]},overrides:[]},
    options:type==='stat'?{colorMode:config.colorMode||'background',graphMode:'none',textMode:config.textMode||'value',justifyMode:'center',reduceOptions:{calcs:['lastNotNull'],fields:'',values:false},text:{valueSize:config.valueSize||24}}
      :type==='table'?{showHeader:true,cellHeight:'sm',footer:{show:false},sortBy:[]}
      :{legend:{displayMode:'list',placement:'bottom',calcs:config.legendCalcs||[]},tooltip:{mode:'multi'}}};
  if(type==='timeseries') p.fieldConfig.defaults.custom={drawStyle:'line',lineInterpolation:'smooth',lineWidth:2,fillOpacity:8,showPoints:'never',spanNulls:false,axisBorderShow:false,axisColorMode:'text',axisLabel:'',scaleDistribution:{type:'linear'},hideFrom:{legend:false,tooltip:false,viz:false},
    thresholdsStyle:{mode:config.thresholdLine?'line+area':'off'}};
  if(config.unit==='percentunit'){p.fieldConfig.defaults.min=0;p.fieldConfig.defaults.max=1;}
  if(config.min!==undefined) p.fieldConfig.defaults.min=config.min;
  panels.push(p);return p;
}
const row=(title,y,collapsed=false,children=[])=>{const p={id:++id,type:'row',title,gridPos:{x:0,y,w:24,h:1},collapsed,panels:children};panels.push(p);return p;};
// Panel di dalam row collapsed harus disimpan di row.panels, bukan di level atas.
function collapsedRow(title,y,build){const start=panels.length;build();const children=panels.splice(start);row(title,y,true,children);}
const namedOverride=(name,properties)=>({matcher:{id:'byName',options:name},properties:properties.map(([id,value])=>({id,value}))});
const node='job="node",application!=""';
const prsiProbe='probe_success{application="PRSI",environment="production"}';
const trackProbe='probe_success{application="Track",environment="production"}';

// ── 1. Status sekarang: satu baris, jawab "aman atau tidak?" dalam 5 detik ──
row('Status sekarang',0);
const S=(x,title,expr,config)=>panel(title,'stat',{x,y:1,w:3,h:4},[[expr,title]],config);
S(0,'PRSI API',prsiProbe,{thresholds:healthy,mappings:upDown,description:'Health https://podorukunsi.my.id/health dari VPS monitoring.'});
S(3,'Track API',trackProbe,{thresholds:healthy,mappings:upDown,description:'Health https://api.podorukuntrack.com/health dari VPS monitoring.'});
S(6,'Alert aktif','count(ALERTS{alertstate="firing"}) or vector(0)',{thresholds:zeroGood,description:'Jumlah alert Prometheus yang sedang firing. Rinciannya di tabel "Alert aktif" di bawah.'});
S(9,'Siklus sync PRSI','sync_last_cycle_age_seconds',{unit:'s',decimals:0,thresholds:thresholds([[null,'green'],[600,'orange'],[900,'red']]),description:'Detik sejak worker PRSI terakhir menyelesaikan siklus tarik/kirim ke Track production. Nilai dibaca dari cache collector (~5 menit), jadi normal sampai ~7-8 menit.'});
S(12,'Galat sync','sum(sync_error_unresolved) + sum(outbox_failed)',{thresholds:zeroGood,description:'Galat sinkron belum selesai + outbox gagal di worker PRSI. Target nol.'});
S(15,'Entitas cocok','sum((sync_entity_match==bool 1)*on(entity)(sync_checker_success==bool 1))',{thresholds:thresholds([[null,'orange'],[7,'green']]),mappings:mappings(Object.fromEntries(Array.from({length:8},(_,n)=>[n,`${n} / 7`]))),description:`Checker membandingkan checksum ${SYNC_SOURCE} dengan mirror PRSI tiap 2 menit.`});
S(18,'Integritas buku','(min(monitor_collection_success)==bool 1)*(max(accounting_invariant_violations)==bool 0)*(max(monitor_collection_age_seconds)<=bool 660)',{thresholds:healthy,mappings:mappings({0:'PERIKSA',1:'VALID'}),description:'VALID bila seluruh invariant pembukuan nol, pemeriksaan berhasil, dan cache maksimal 11 menit.'});
S(21,'Backup PRSI','backup_last_age_seconds',{unit:'s',decimals:0,thresholds:thresholds([[null,'green'],[86400,'orange'],[93600,'red']]),description:'Umur backup PRSI terakhir yang terverifikasi. Oranye > 24 jam, merah > 26 jam.'});

// ── 2. Alert aktif + ringkasan VPS ──
const alerts=panel('Alert aktif','table',{x:0,y:5,w:9,h:7},[['ALERTS{alertstate="firing"}','']],{noValue:'Tidak ada alert aktif ✓',description:'Alert yang sedang firing beserta labelnya. Kosong = semua normal.'});
alerts.transformations=[{id:'filterFieldsByName',options:{include:{pattern:'^(alertname|severity|entity|instance|application)$'}}},
  {id:'organize',options:{indexByName:{severity:0,alertname:1,entity:2,application:3,instance:4},renameByName:{alertname:'Alert',severity:'Level',entity:'Entitas',application:'Aplikasi',instance:'Target'}}}];
alerts.fieldConfig.overrides=[namedOverride('Level',[['mappings',[{type:'value',options:{critical:{text:'KRITIS',color:'red'},warning:{text:'WARNING',color:'orange'}}}]],['custom.cellOptions',{type:'color-text'}],['custom.width',80]])];

const fleet=panel('Ringkasan VPS','table',{x:9,y:5,w:15,h:7},[
  [`max by(application,public_ip)(up{${node}})`,'Host'],
  ['max by(public_ip)(probe_success{environment="production",application!=""})','API'],
  [`1-avg by(public_ip)(rate(node_cpu_seconds_total{${node},mode="idle"}[5m]))`,'CPU'],
  [`max by(public_ip)(1-node_memory_MemAvailable_bytes{${node}}/node_memory_MemTotal_bytes{${node}})`,'RAM'],
  [`max by(public_ip)(1-node_filesystem_avail_bytes{${node},mountpoint="/"}/node_filesystem_size_bytes{${node},mountpoint="/"})`,'Disk'],
  [`max by(public_ip)(time()-node_boot_time_seconds{${node}})`,'Uptime']
],{description:'Satu baris per VPS. Host = node exporter terjangkau; API = health production (VPS monitoring tidak punya API). CPU rata-rata 5 menit; RAM dan disk root terpakai.'});
fleet.transformations=[{id:'joinByField',options:{byField:'public_ip',mode:'outerTabular'}},
  {id:'filterFieldsByName',options:{include:{names:['application','public_ip','Value #A','Value #B','Value #C','Value #D','Value #E','Value #F']}}},
  {id:'organize',options:{excludeByName:{},indexByName:{application:0,public_ip:1,'Value #A':2,'Value #B':3,'Value #C':4,'Value #D':5,'Value #E':6,'Value #F':7},renameByName:{application:'Aplikasi',public_ip:'IP publik','Value #A':'Host','Value #B':'API','Value #C':'CPU','Value #D':'RAM','Value #E':'Disk','Value #F':'Uptime'}}}];
fleet.fieldConfig.overrides=[
  namedOverride('Aplikasi',[['mappings',mappings({Track:'Track production',PRSI:'PRSI production',monitoring:'Monitoring'})],['custom.width',140]]),
  namedOverride('IP publik',[['custom.width',120]]),
  ...['Host','API'].map(n=>namedOverride(n,[['mappings',upDown],['thresholds',healthy],['custom.cellOptions',{type:'color-text'}],['custom.width',60]])),
  ...['CPU','RAM','Disk'].map(n=>namedOverride(n,[['unit','percentunit'],['decimals',0],['min',0],['max',1],['thresholds',capacity],['custom.cellOptions',{type:'gauge',mode:'basic'}]])),
  namedOverride('Uptime',[['unit','s'],['decimals',0],['custom.width',90]])
];
fleet.fieldConfig.defaults.mappings=[nullDash];

// ── 3. PRSI production ──
row('PRSI production · API & worker sync',12);
panel('Request & error 5xx','timeseries',{x:0,y:13,w:8,h:7},[['sum(rate(api_requests_total{job="prsi"}[5m]))','Request/s'],['sum(rate(api_errors_5xx_total{job="prsi"}[5m]))','Error 5xx/s']],{unit:'reqps',description:'Lalu lintas backend PRSI. Error 5xx seharusnya nol.'})
  .fieldConfig.overrides=[namedOverride('Error 5xx/s',[['color',{mode:'fixed',fixedColor:'red'}]])];
panel('Latensi p50 / p95','timeseries',{x:8,y:13,w:8,h:7},[
  ['histogram_quantile(0.5,sum by(le)(rate(api_request_duration_seconds_bucket{job="prsi"}[5m])))','p50'],
  ['histogram_quantile(0.95,sum by(le)(rate(api_request_duration_seconds_bucket{job="prsi"}[5m])))','p95']
],{unit:'s',description:'p95 = 95% request lebih cepat dari nilai ini. Kosong saat tidak ada request.'});
panel('Worker sync · umur siklus & ditahan','timeseries',{x:16,y:13,w:8,h:7},[['sync_last_cycle_age_seconds','Umur siklus'],['sync_held_seconds','Sync ditahan']],
  {unit:'s',thresholds:thresholds([[null,'transparent'],[600,'red']]),thresholdLine:true,description:'Umur siklus naik-turun normal (interval 2 menit). Garis merah 10 menit = batas alert SyncLag.'});

// ── 4. Track production ──
row('Track production · ketersediaan',20);
panel('Waktu respons health','timeseries',{x:0,y:21,w:12,h:7},[
  ['probe_duration_seconds{application="Track",environment="production"}','Track production'],
  ['probe_duration_seconds{application="PRSI",environment="production"}','PRSI production'],
  ['probe_duration_seconds{application="Track",environment="staging"}','Track staging']
],{unit:'s',legendCalcs:['mean','max'],description:'Durasi probe blackbox ke endpoint /health (termasuk DNS + TLS lewat Cloudflare).'});
panel('Uptime 24 jam','stat',{x:12,y:21,w:6,h:7},[
  [`avg_over_time(${trackProbe}[24h])`,'Track'],[`avg_over_time(${prsiProbe}[24h])`,'PRSI']
],{unit:'percentunit',decimals:2,colorMode:'value',textMode:'value_and_name',thresholds:thresholds([[null,'red'],[0.99,'orange'],[0.999,'green']]),description:'Persentase probe sukses 24 jam terakhir.'});
panel('Sertifikat TLS berakhir','stat',{x:18,y:21,w:6,h:7},[
  ['probe_ssl_earliest_cert_expiry{application="Track",environment="production"}-time()','Track'],
  ['probe_ssl_earliest_cert_expiry{application="PRSI",environment="production"}-time()','PRSI']
],{unit:'s',decimals:0,colorMode:'value',textMode:'value_and_name',thresholds:thresholds([[null,'red'],[7*86400,'orange'],[21*86400,'green']]),description:'Sisa waktu sertifikat yang terlihat dari luar (Cloudflare edge). Merah < 7 hari.'});
panels.push({id:++id,type:'text',title:'',gridPos:{x:0,y:28,w:24,h:2},options:{mode:'markdown',content:'Track production belum mengekspos metrik aplikasi (request/error/latensi). Yang terpantau: health API, host (CPU/RAM/disk via tunnel), dan checksum sinkron.'}});

// ── 5. Sinkronisasi PRSI ↔ Track ──
row(`Sinkronisasi PRSI ↔ ${SYNC_SOURCE}`,30);
const entity=panel('Status per entitas','table',{x:0,y:31,w:12,h:9},[
  ['sync_entity_match',''],['sync_entity_rows_track',''],['sync_entity_rows_prsi',''],['sync_entity_rows_prsi - on(entity) sync_entity_rows_track',''],['time() - sync_entity_last_match_timestamp','']
],{description:`COCOK = jumlah baris dan hash isi sama. PENDING = beda tapi belum stabil 3 siklus (bisa lag normal). BEDA = beda stabil (perlu dicek). Pembanding: ${SYNC_SOURCE}.`});
entity.transformations=[{id:'merge',options:{}},
  {id:'filterFieldsByName',options:{include:{names:['entity','Value #A','Value #B','Value #C','Value #D','Value #E']}}},
  {id:'organize',options:{indexByName:{entity:0,'Value #A':1,'Value #B':2,'Value #C':3,'Value #D':4,'Value #E':5},renameByName:{entity:'Entitas','Value #A':'Status','Value #B':'Baris Track','Value #C':'Baris PRSI','Value #D':'Selisih','Value #E':'Terakhir cocok'}}}];
entity.fieldConfig.overrides=[
  namedOverride('Status',[['mappings',mappings({'-1':'PENDING',0:'BEDA',1:'COCOK'})],['thresholds',thresholds([[null,'orange'],[0,'red'],[1,'green']])],['custom.cellOptions',{type:'color-text'}]]),
  namedOverride('Selisih',[['thresholds',thresholds([[null,'red'],[0,'green'],[1,'red']])],['custom.cellOptions',{type:'color-text'}]]),
  namedOverride('Terakhir cocok',[['unit','s'],['decimals',0],['custom.cellOptions',{type:'auto'}]])
];
panel('Selisih baris (PRSI − Track)','timeseries',{x:12,y:31,w:12,h:9},[['sync_entity_rows_prsi - on(entity) sync_entity_rows_track','{{entity}}']],
  {description:'Nol = jumlah baris sama. Positif = PRSI punya baris yang belum ada di pembanding.'});

// ── 6. Rincian (collapsed) ──
collapsedRow('Rincian · integritas pembukuan & checker',40,()=>{
  panel('Pelanggaran per aturan','timeseries',{x:0,y:41,w:12,h:7},[['accounting_invariant_violations','{{invariant}}']],{description:'Target setiap aturan nol.'});
  panel('Kesehatan collector & checker','stat',{x:12,y:41,w:12,h:7},[
    ['monitor_collection_age_seconds','Umur cache PRSI'],['min(sync_checker_success)','Checker'],['sync_checker_storage_success','Penyimpanan checker'],['backup_timestamp_available','Bukti backup'],
    ['probe_success{application="Track",environment="staging"}','Track staging']
  ],{colorMode:'value',textMode:'value_and_name',thresholds:healthy,mappings:upDown,description:'Komponen pendukung monitoring. 1/UP = sehat.'})
    .fieldConfig.overrides=[namedOverride('Umur cache PRSI',[['unit','s'],['decimals',0],['mappings',[]],['thresholds',thresholds([[null,'green'],[600,'orange'],[660,'red']])]])];
  panel('Jumlah baris per entitas','timeseries',{x:0,y:48,w:24,h:7},[['sync_entity_rows_track','Track · {{entity}}'],['sync_entity_rows_prsi','PRSI · {{entity}}']]);
});
collapsedRow('Riwayat sumber daya per VPS',41,()=>{
  const hosts=[
    {name:'Track production',app:'Track',ip:'43.173.8.59',services:'Backend/API Track · Redis · WhatsApp WAHA'},
    {name:'PRSI production',app:'PRSI',ip:'43.173.11.71',services:'API + worker PRSI · database · Track staging'},
    {name:'Monitoring',app:'monitoring',ip:'43.157.230.218',services:'Grafana · Prometheus · Alertmanager · checker · ntfy · ai-stack'}
  ];
  hosts.forEach((host,i)=>{
    const x=i*8, selector=`job="node",application="${host.app}",public_ip="${host.ip}"`;
    panels.push({id:++id,type:'text',title:host.name,gridPos:{x,y:42,w:8,h:3},options:{mode:'markdown',content:host.services}});
    panel('CPU','timeseries',{x,y:45,w:8,h:6},[[`1-avg(rate(node_cpu_seconds_total{${selector},mode="idle"}[5m]))`,'CPU']],{unit:'percentunit',thresholds:capacity,description:'Pemakaian CPU host, rata-rata 5 menit.'})
      .fieldConfig.defaults.color={mode:'fixed',fixedColor:'purple'};
    panel('RAM & disk','timeseries',{x,y:51,w:8,h:6},[
      [`1-node_memory_MemAvailable_bytes{${selector}}/node_memory_MemTotal_bytes{${selector}}`,'RAM'],
      [`1-node_filesystem_avail_bytes{${selector},mountpoint="/"}/node_filesystem_size_bytes{${selector},mountpoint="/"}`,'Disk']
    ],{unit:'percentunit',thresholds:capacity,description:'RAM dan disk root terpakai.'})
      .fieldConfig.overrides=[namedOverride('RAM',[['color',{mode:'fixed',fixedColor:'blue'}]]),namedOverride('Disk',[['color',{mode:'fixed',fixedColor:'orange'}]])];
  });
});

mkdirSync(new URL('./grafana/dashboards/',import.meta.url),{recursive:true});
writeFileSync(new URL('./grafana/dashboards/prsi.json',import.meta.url),JSON.stringify({uid:'prsi-monitoring',title:'PodoRukun — Infrastruktur & PRSI',
  description:`Status sekarang di baris atas; rincian PRSI, Track, sinkronisasi (pembanding: ${SYNC_SOURCE}) dan sumber daya di bawah.`,
  schemaVersion:41,version:5,timezone:'Asia/Jakarta',refresh:'30s',time:{from:'now-6h',to:'now'},tags:['PodoRukun','infrastruktur','PRSI','Track'],graphTooltip:1,panels},null,2)+'\n');
