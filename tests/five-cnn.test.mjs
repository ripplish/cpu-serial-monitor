import test from 'node:test';import assert from 'node:assert/strict';
import {parseLine,csv} from '../dist/protocol.mjs';
import {cnnStatus} from '../dist/cnn.mjs';
import {createBackup,parseBackup} from '../dist/storage.mjs';
import {cpuPerformance} from '../dist/performance.mjs';
import {readFileSync} from 'node:fs';
const cnn={version:2,pred:4,scores:[-4,3,7,8,19],trained:true,model:'b'.repeat(64),cycles:2700000,rpm_ref:620,overruns:0,scope:'experimental',fs:800,n:512,history:5,rms_floor:30};
test('five classes keep unloaded/loaded normal neutral and separate loaded/unloaded looseness',()=>{
 const names=['正常空载','正常带载','重心偏移','带载松动','空载松动'];
 for(let i=0;i<5;i++) {const c={...cnn,pred:i,scores:Array.from({length:5},(_,j)=>i===j?5:-1)};const frame=parseLine(JSON.stringify({seq:i,result:80,status:0,cnn:c}));assert.equal(frame.kind,'frame');assert.match(cnnStatus(frame.frame.cnn,80).label,new RegExp(names[i]));assert.equal(cnnStatus(c,80).tone,i<2?'neutral':'warning');}
 assert.equal(cnnStatus(cnn,1).label,'低振动，暂不判类');
 assert.match(cnnStatus(cnn,80).detail,/3.2秒/);assert.match(cnnStatus(cnn,80).detail,/0.64秒/);
});
test('five scores, schema version and sampling profile survive backup and CSV',()=>{
 const frame={...parseLine(JSON.stringify({seq:1,result:80,status:0,cnn})).frame,source:'serial',received_at:'2026-11-01T00:00:00.000Z',received_ms:Date.parse('2026-11-01T00:00:00.000Z')};
 assert.deepEqual(parseBackup(createBackup({records:[frame],logs:[],total:1,invalid:0,started:null})).records[0].cnn,cnn);
 assert.match(csv([frame]),/cnn_score3,cnn_score4,cnn_version,cnn_fs,cnn_n/);
 const performance=cpuPerformance([frame]);assert.equal(performance.intervalMs,640);assert.match(performance.intervalSource,/800 Hz/);
});
test('reject mixed class counts, unsupported schemas, inconsistent argmax and invalid sampling',()=>{
 for(const bad of [{version:1},{version:3},{scores:[1,2,3]},{pred:5},{pred:3},{fs:200},{n:256},{fs:undefined},{history:6}])assert.equal(parseLine(JSON.stringify({result:80,cnn:{...cnn,...bad}})).kind,'invalid');
});
test('actual native AHB2 CPU UART v2 frame is accepted without overriding low-vibration guard',()=>{
 const line=readFileSync(new URL('./fixtures/five-predict.json',import.meta.url),'utf8');const parsed=parseLine(line.trim());
 assert.equal(parsed.kind,'frame');assert.equal(parsed.frame.cnn.history,5);assert.equal(parsed.frame.cnn.scores.length,5);
 assert.equal(cnnStatus(parsed.frame.cnn,parsed.frame.result).label,'低振动，暂不判类');
 assert.equal(cpuPerformance([{...parsed.frame,source:'serial',received_ms:1}]).intervalMs,640);
});
