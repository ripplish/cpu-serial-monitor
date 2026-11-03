import test from 'node:test';import assert from 'node:assert/strict';
import {parseLine,csv,splitSeries} from '../dist/protocol.mjs';
import {compareBackends,parsePhaseEvent} from '../dist/timing.mjs';
import {cpuPerformance} from '../dist/performance.mjs';
import {createBackup,parseBackup} from '../dist/storage.mjs';
import {cnnStatus} from '../dist/cnn.mjs';
const make=(backend='cpu',factor=1)=>({seq:1,result:500,status:0,cnn:{version:3,pred:3,scores:[-2,4,9,12,-8],trained:true,model:'a'.repeat(64),architecture:'phase-mlp784-128-64-5',backend,cycles:270000*factor,rpm_ref:620,overruns:0,rms_floor:443,fs:800,n:1024,history:1,clock_hz:27000000,scope:'experimental'},timing:{version:1,clock_hz:27000000,frontend_cycles:2700000,nn_cycles:270000*factor,compute_cycles:2700000+270000*factor,wall_cycles:3000000+270000*factor,service_cycles:300000,accelerator_cycles:backend==='cpu'?0:3000,skipped_windows:0,first_sample:0}});
const row=(backend,f=1)=>({...make(backend,f),source:'serial',received_ms:0,received_at:'1970-01-01T00:00:00.000Z'});

test('64MHz application uses reported clock and names only the MLP backend',()=>{
 const x=make();x.cnn.clock_hz=x.timing.clock_hz=64000000;
 const parsed=parseLine(JSON.stringify(x));assert.equal(parsed.kind,'frame');
 const p=cpuPerformance([{...parsed.frame,source:'serial',received_ms:0}]);
 assert.equal(p.phase,'CPU MLP · 特征处理');
 assert.equal(p.frontendMs,42.1875);assert.equal(p.nnMs,4.21875);
 assert.equal(p.intervalMs,1280);
});
test('v3 MLP keeps exact stage timing through parse, backup, CSV and low-vibration guard',()=>{
 const frame=make();assert.deepEqual(parseLine(JSON.stringify(frame)).frame,frame);
 assert.deepEqual(parseBackup(createBackup({records:[row('cpu')],logs:[],total:1,invalid:0,started:null})).records[0],row('cpu'));
 assert.match(csv([row('cpu')]),/cnn_backend,clock_hz,frontend_cycles/);
 assert.equal(cnnStatus(frame.cnn,500).label,'MLP预测：带载松动');assert.equal(cnnStatus(frame.cnn,7).label,'低振动，暂不判类');
 const p=cpuPerformance([row('cpu')]);assert.equal(p.frontendMs,100);assert.equal(p.nnMs,10);assert.equal(p.computeMs,110);assert.equal(p.wallMs,121.11111111111111);assert.equal(p.intervalMs,1280);
});
test('reject missing timing, impossible stage totals, backend/core mismatch and model configuration',()=>{
 const samples=[];let x=make();delete x.timing;samples.push(x);
 for(const patch of [{nn_cycles:1},{compute_cycles:1},{wall_cycles:1},{clock_hz:1},{accelerator_cycles:1},{first_sample:1},{skipped_windows:-1},{frontend_cycles:Number.MAX_SAFE_INTEGER+1}]){x=make();Object.assign(x.timing,patch);samples.push(x);}
 for(const patch of [{n:512},{backend:'conv'},{history:5},{architecture:'cnn'},{fs:200},{clock_hz:0}]){x=make();Object.assign(x.cnn,patch);samples.push(x);}
 x=make('mac4');x.timing.accelerator_cycles=0;samples.push(x);
 for(const sample of samples)assert.equal(parseLine(JSON.stringify(sample)).kind,'invalid');
});
test('same configuration median comparison survives reconnect via explicit saved baseline',()=>{
 const rows=[row('cpu',4),row('cpu',6),row('cpu',100)];const c=compareBackends([row('mac4')],rows);
 assert.equal(c.ready,true);assert.equal(c.cpu.nnMs,60);assert.equal(c.nnSpeedup,6);assert.ok(c.totalSpeedup<6);
 const wrong=row('cpu');wrong.cnn.model='b'.repeat(64);assert.equal(compareBackends([row('mac4')],[wrong]).ready,false);
 wrong.cnn.model='a'.repeat(64);wrong.cnn.clock_hz=50000000;assert.equal(compareBackends([row('mac4')],[wrong]).ready,false);
 const demo={...row('mac4'),source:'demo'};assert.equal(compareBackends([demo],rows).ready,false);
});
test('phase boot/error invalidates live status without becoming an invalid data frame',()=>{
 const event=JSON.stringify({event:{version:1,kind:'ACQUIRE_ERROR',reason:2,backend:'mac4',model:'a'.repeat(64),epoch:1}});
 assert.equal(parseLine(event).kind,'log');assert.match(parsePhaseEvent(event).label,/采集失效/);
 assert.equal(parsePhaseEvent(event.replace('ACQUIRE_ERROR','BOGUS')),null);
 const b=row('mac4');assert.equal(splitSeries([row('cpu'),b]).length,2);
});
