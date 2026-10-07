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
mkdirSync(new URL('./grafana/dashboards/',import.meta.url),{recursive:true});
writeFileSync(new URL('./grafana/dashboards/prsi.json',import.meta.url),JSON.stringify({uid:'prsi-monitoring',title:'PRSI — Kesehatan & Integritas',schemaVersion:41,version:1,timezone:'Asia/Jakarta',refresh:'30s',time:{from:'now-6h',to:'now'},tags:['PRSI'],panels},null,2)+'\n');
