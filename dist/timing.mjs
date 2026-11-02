export const TIMING_FIELDS=['frontend_cycles','nn_cycles','compute_cycles','wall_cycles','service_cycles','accelerator_cycles','skipped_windows','first_sample'];
export function validateTiming(t,c) {
 const fail=()=>{throw new Error('分阶段耗时字段无效或与模型配置不符');};
 if(!c||c.version!==3||!t||t.version!==1||t.clock_hz!==c.clock_hz)fail();
 for(const k of TIMING_FIELDS)if(!Number.isSafeInteger(t[k])||t[k]<0)fail();
 if(t.nn_cycles!==c.cycles||t.compute_cycles!==t.frontend_cycles+t.nn_cycles||t.wall_cycles<t.compute_cycles+t.service_cycles||t.wall_cycles-t.compute_cycles-t.service_cycles>10000||!t.nn_cycles||!t.frontend_cycles||t.first_sample%1024!==0)fail();
 if((c.backend==='cpu'&&t.accelerator_cycles!==0)||(c.backend==='mac4'&&(!t.accelerator_cycles||t.accelerator_cycles>t.nn_cycles)))fail();
 return Object.fromEntries(['version','clock_hz',...TIMING_FIELDS].map(k=>[k,t[k]]));
}
const median=a=>{const s=[...a].sort((x,y)=>x-y),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
export function comparisonKey(c) {return [c.model,c.architecture,c.clock_hz,c.fs,c.n,c.history].join('/');}
export function compareBackends(records,baseline=[]) {
 const last=records.at(-1);if(!last?.timing)return null;
 const key=comparisonKey(last.cnn),groups={cpu:[],mac4:[]};
 const seen=new Set();
 for(const r of [...baseline,...records])if(r.source==='serial'&&r.timing&&comparisonKey(r.cnn)===key){
  const id=JSON.stringify([r.received_ms,r.seq,r.cnn.backend,r.timing.compute_cycles,r.timing.wall_cycles,r.timing.first_sample]);
  if(!seen.has(id)){seen.add(id);groups[r.cnn.backend].push(r);}
 }
 const stats={};for(const backend of ['cpu','mac4']){
  const rows=groups[backend].slice(-20);if(rows.length)stats[backend]={count:rows.length,frontendMs:median(rows.map(r=>r.timing.frontend_cycles*1000/r.timing.clock_hz)),nnMs:median(rows.map(r=>r.timing.nn_cycles*1000/r.timing.clock_hz)),computeMs:median(rows.map(r=>r.timing.compute_cycles*1000/r.timing.clock_hz))};
 }
 return {...stats,model:last.cnn.model,ready:!!stats.cpu&&!!stats.mac4,nnSpeedup:stats.cpu&&stats.mac4?stats.cpu.nnMs/stats.mac4.nnMs:null,totalSpeedup:stats.cpu&&stats.mac4?stats.cpu.computeMs/stats.mac4.computeMs:null};
}
export function parsePhaseEvent(line){
 let e;try{e=JSON.parse(line)?.event;}catch{return null;}
 if(!e||e.version!==1||!['BOOT','INIT_ERROR','ACQUIRE_ERROR','TRAP'].includes(e.kind)||!['cpu','mac4'].includes(e.backend)||!/^[0-9a-f]{64}$/.test(e.model)||!Number.isSafeInteger(e.epoch)||e.epoch<0||!Number.isSafeInteger(e.reason)||e.reason<0)return null;
 return {label:({BOOT:'固件已重启，等待新结果',INIT_ERROR:'传感器初始化失败',ACQUIRE_ERROR:'采集失效，等待恢复',TRAP:'固件异常'})[e.kind],tone:e.kind==='BOOT'?'neutral':'warning'};
}
