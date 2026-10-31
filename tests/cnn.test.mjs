import test from 'node:test';import assert from 'node:assert/strict';
import {parseLine,csv} from '../dist/protocol.mjs';
import {createBackup,parseBackup} from '../dist/storage.mjs';
import {cnnStatus} from '../dist/cnn.mjs';
const cnn={version:1,pred:1,scores:[-12,35,9],trained:true,model:'a'.repeat(64),cycles:900000,rpm_ref:620,overruns:0,scope:'experimental'};
test('CNN result parsing, prediction label, CSV and backup preserve identity',()=>{
 const frame=parseLine(JSON.stringify({seq:1,result:123,status:0,cnn}));assert.equal(frame.kind,'frame');
 assert.match(cnnStatus(frame.frame.cnn).label,/重心偏移/);
 const record={...frame.frame,source:'serial',received_at:'2026-10-31T00:00:00.000Z',received_ms:1793404800000};
 record.received_ms=Date.parse(record.received_at);
 const backup=createBackup({records:[record],logs:[],total:1,invalid:0,started:null});
 assert.deepEqual(parseBackup(backup).records[0].cnn,cnn);assert.match(csv([record]),/cnn_model/);assert.match(csv([record]),/620/);
});
test('CNN malformed results rejected and ties use first class',()=>{
 for(const bad of [{pred:0},{scores:[1,2]},{scores:[0,NaN,2]},{trained:1},{model:'x'},{cycles:0},{rpm_ref:-1},{scope:'validated'}])
  assert.equal(parseLine(JSON.stringify({result:1,cnn:{...cnn,...bad}})).kind,'invalid');
 assert.equal(parseLine(JSON.stringify({result:1,cnn:{...cnn,pred:0,scores:[1,1,0]}})).kind,'frame');
});

test("low vibration outside known training coverage is not a fault class or stop verdict",()=>{
 const current={...cnn,model:"4174d17054269f881b1b5c5578cdd28af114f9b4b4b219ca7398dfbac80ca0cc"};
 assert.equal(cnnStatus(current,7).label,"低振动，暂不判类");
 assert.match(cnnStatus(current,7).detail,/不是停机检测/);
 assert.match(cnnStatus(current,220).label,/重心偏移/);
 assert.equal(cnnStatus({...cnn,rms_floor:166},0).label,"低振动，暂不判类");
});
