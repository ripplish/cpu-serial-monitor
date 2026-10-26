import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeUartLog, parseWheelLine, wheelStatus, alarmLabels, wheelCsv, MAX_LOG_CHARS } from '../dist/uart.mjs';
import { parseLine, csv } from '../dist/protocol.mjs';
import { createBackup, parseBackup } from '../dist/storage.mjs';
const line='win=82 fs=200 n=512 rpm_ref=280 rms_mg=76 peak_mg=913 crest_x1000=12013 kurt_x1000=64075 peak_mHz=1171 f1_permille=28 h23_permille=44 base=12 flags=0 status=NO_THRESHOLD_EXCEEDED overrun=0 max_read_us=1173 analysis_us=72882';
const hex=text=>[...new TextEncoder().encode(text)].map(byte=>byte.toString(16).padStart(2,'0')).join(' ');

test('decodes timestamped HEX packets across a split field and CRLF',()=>{
  const a=line.slice(0,34),b=line.slice(34)+'\r\n';
  const log=`[14:12:52.533]收←◆${hex(a)}\n[14:12:52.541]收←◆${hex(b)}`;
  const result=decodeUartLog(log);
  assert.equal(result.text,line+'\r\n');assert.equal(result.windows.length,1);
  assert.equal(result.windows[0].peak_mg,913);assert.equal(result.windows[0].peak_mHz,1171);
  assert.equal(result.hexLines,2);assert.equal(result.byteCount,new TextEncoder().encode(line+'\r\n').length);
});
test('excludes transmitted commands instead of joining C into a receive window',()=>{
  const log=`[14:00:00.001]发→◇43 □\n[14:00:00.002]收←◆${hex(line+'\r\n')}`;
  const result=decodeUartLog(log);assert.equal(result.text,line+'\r\n');assert.equal(result.skippedTx,1);
});
test('UTF-8 multibyte characters may span physical receive chunks',()=>{
  const result=decodeUartLog('[01:02:03.000]收←◆E4 B8\n[01:02:03.001]收←◆AD 0D 0A');
  assert.equal(result.text,'中\r\n');assert.equal(result.warnings.length,0);
  assert.equal(decodeUartLog('D6 D0 0D 0A','hex','gb18030').text,'中\r\n');
});
test('supports existing plaintext, mixed logs, dense HEX and 0x bytes',()=>{
  assert.equal(decodeUartLog(line+'\n','text').windows.length,1);
  assert.equal(decodeUartLog(hex('OK\n').replaceAll(' ','')).text,'OK\n');
  assert.equal(decodeUartLog('0x4f,0x4b,0x0a').text,'OK\n');
  const mixed=decodeUartLog('boot complete\n'+hex(line+'\n'));
  assert.ok(mixed.text.startsWith('boot complete\n'));assert.equal(mixed.windows.length,1);
});
test('malformed HEX is rejected in forced mode, fragments are surfaced',()=>{
  assert.throws(()=>decodeUartLog('49 ZZ 0A','hex'),/第1行/);
  const result=decodeUartLog('F 4f 4b 0a');assert.equal(result.text,'[损坏HEX]OK\n');assert.ok(result.warnings.length);assert.equal(result.errors.length,1);
  assert.equal(decodeUartLog('00 17 0a').text,'\\x00\\x17\n');
  assert.ok(decodeUartLog('win=1 rms_mg=3','text').errors.length);
  assert.throws(()=>decodeUartLog('a'.repeat(MAX_LOG_CHARS+1)),/最多/);
});

test('damaged numeric bytes cannot become a different valid measurement',()=>{
  const bad=hex('win=1 rms_mg=')+' 3 '+hex('2 peak_mg=30 base=0 flags=0 status=UNLEARNED\n');
  const result=decodeUartLog(bad+'\n'+hex(line+'\n'),'hex');
  assert.equal(result.windows.length,1);assert.equal(result.windows[0].win,82);
  assert.equal(result.errors.length,1);assert.match(result.text,/损坏HEX/);
});

test('damage taints an entire logical frame across physical receive fragments',()=>{
  const bad='[10:00:00.001]收←◆'+hex(line.slice(0,40))+' F\n[10:00:00.002]收←◆'+hex(line.slice(40)+'\n'+line+'\n');
  const result=decodeUartLog(bad);
  assert.equal(result.windows.length,1);assert.equal(result.errors.length,1);
  assert.equal(decodeUartLog(line,'text').windows.length,0);
  assert.equal(decodeUartLog('BASELINE CLEARED','text').events.length,0);
});

test('undecodable or control bytes cannot be hidden in ignored extension fields',()=>{
  for(const suffix of ['\ufffd','\x00']) {
    const result=decodeUartLog(line+' extra='+suffix+'\n','text');
    assert.equal(result.windows.length,0);assert.equal(result.errors.length,1);
  }
});
test('parses all telemetry without converting absent fields into zeros',()=>{
  const parsed=parseWheelLine(line);assert.equal(parsed.kind,'wheel');
  assert.equal(parsed.data.crest_x1000,12013);assert.equal(parsed.data.analysis_us,72882);
  const partial=parseWheelLine('win=1 rms_mg=2 peak_mg=3 base=0 flags=0 status=UNLEARNED');
  assert.equal(partial.kind,'wheel');assert.equal(partial.data.overrun,undefined);
  for(const bad of [line.replace('win=82','win=-1'),line+' flags=8',line.replace('base=12','base=oops'),line.replace('f1_permille=28','f1_permille=1001'),line.replace('status=NO_THRESHOLD_EXCEEDED','status=NO_THRESHOLD_EXCEEDE')]) assert.equal(parseWheelLine(bad).kind,'invalid');
});
test('translates learning, baselines and combined flags without claiming mechanical health',()=>{
  const row=parseWheelLine(line).data;
  assert.match(wheelStatus(row).label,/未超过/);assert.match(wheelStatus(row).detail,/不代表/);
  assert.equal(wheelStatus({...row,status:'UNLEARNED',base:0}).label,'尚未学习');
  assert.match(wheelStatus({...row,status:'LEARNING',base:7}).label,/7\/12/);
  assert.equal(wheelStatus({...row,status:'BASELINE_READY'}).label,'基准学习完成');
  assert.equal(wheelStatus({...row,base:3}).tone,'warning');
  assert.equal(alarmLabels(15).length,4);assert.match(alarmLabels(0x80000000)[0],/80000000/);
  assert.equal(wheelStatus({...row,flags:3,status:'SUSPECT'}).tone,'warning');
});
test('a later capture failure overrides an earlier learned frame',()=>{
  const result=decodeUartLog(line+'\nINVALID reason=3 overrun=1 restarts=4 window discarded; baseline cleared\n','text');
  assert.equal(result.windows.length,1);assert.equal(result.entries.at(-1).label,'软件双缓冲积压');
  for(const reason of [1,2,3,4,5])assert.equal(decodeUartLog(`INVALID reason=${reason}\n`,'text').events[0].tone,'error');
  assert.equal(decodeUartLog('ERROR INIT; retry\n','text').events[0].label,'传感器初始化失败');
  assert.match(decodeUartLog('CALIBRATION START: x\n','text').events[0].label,/学习/);
});
test('live protocol, CSV and version-1 backups retain every wheel field',()=>{
  const frame=parseLine(line).frame;assert.equal(frame.result,76);assert.equal(frame.seq,82);assert.equal(frame.status,0);
  const record={...frame,source:'serial',received_ms:1000,received_at:new Date(1000).toISOString()};
  const restored=parseBackup(createBackup({records:[record],logs:[line],total:1,invalid:0,started:1000}));
  assert.deepEqual(restored.records[0].wheel,frame.wheel);
  assert.ok(csv([record]).includes('wheel_status'));assert.ok(csv([record]).includes('NO_THRESHOLD_EXCEEDED'));
  const exported=wheelCsv([frame.wheel]);assert.ok(exported.startsWith('\uFEFF'));assert.match(exported,/有效值_mg/);assert.match(exported,/"913"/);
  const invalid=JSON.parse(createBackup({records:[{...record,result:999}],logs:[],total:1,invalid:0,started:1000}));
  assert.throws(()=>parseBackup(JSON.stringify(invalid)),/损坏/);
});
