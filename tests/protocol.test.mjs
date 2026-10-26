import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSeries } from '../dist/protocol.mjs';

test('series gaps preserve missing windows, resets and source boundaries',()=>{
  const frame=(win,source='serial')=>({seq:win,wheel:{win},source,result:win});
  const segments=splitSeries([frame(1),frame(2),frame(4),frame(5),frame(1),frame(2,'demo')]);
  assert.deepEqual(segments.map(rows=>rows.map(row=>row.seq)),[[1,2],[4,5],[1],[2]]);
  assert.equal(splitSeries([{result:1,source:'serial'},{result:2,source:'serial'}]).length,1);
  assert.deepEqual(splitSeries([]),[]);
});
import { parseLine, LineFramer, MAX_LINE, csv } from '../dist/protocol.mjs';

test('accepts the AM integer frame and preserves absent optional fields', () => {
  assert.deepEqual(parseLine('{"result":85}'), { kind: 'frame', frame: { result: 85 } });
  assert.deepEqual(parseLine('{"input":120,"result":85,"gpio_in":3}'), { kind: 'frame', frame: { result: 85 } });
  assert.equal(parseLine('boot complete').kind, 'log');
  assert.equal(parseLine(' \r ').kind, 'empty');
  assert.equal(parseLine('{bad json').kind, 'invalid');
  for (const frame of [
    { result: '85' }, { input: 120 },
    { result: 2, status: -1 }, { result: 2, seq: -1 },
    { result: 2, status: .5 }, { result: 2, seq: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(parseLine(JSON.stringify(frame)).kind, 'invalid');
  assert.equal(parseLine('{"result":1e999}').kind, 'invalid');
  assert.equal(parseLine('{"result":0,"status":0}').kind, 'frame');
});

test('recovers line boundaries across serial chunks, CRLF, and UTF-8 chunks', () => {
  const lines = [];
  const framer = new LineFramer(line => lines.push(line), () => assert.fail('unexpected overflow'));
  const bytes = new TextEncoder().encode('启动完成\r\n{"input":120,"result":85}\nnext\n');
  const decoder = new TextDecoder();
  for (const byte of bytes) framer.push(decoder.decode(Uint8Array.of(byte), { stream: true }));
  assert.deepEqual(lines, ['启动完成', '{"input":120,"result":85}', 'next']);
  framer.push('unfinished'); framer.reset(); framer.push('fresh\n');
  assert.equal(lines.at(-1), 'fresh');
});

test('oversized lines are dropped once and the following frame remains usable', () => {
  const lines = []; let errors = 0;
  const framer = new LineFramer(line => lines.push(line), () => errors++);
  framer.push('x'.repeat(MAX_LINE));
  framer.push('x'.repeat(100)); framer.push('tail');
  framer.push('\n{"input":2,"result":3}\n');
  assert.equal(errors, 1);
  assert.equal(lines.length, 1);
  assert.equal(parseLine(lines[0]).kind, 'frame');
  framer.push('y'.repeat(MAX_LINE) + '\r\n');
  assert.equal(errors, 1);
  assert.equal(lines.at(-1).length, MAX_LINE);
});

test('CSV records the result and data source without inventing missing status', () => {
  const text = csv([{ received_at: '2026-10-14T12:00:00.000Z', source: 'demo', seq: 1, result: 85 }]);
  assert.ok(text.startsWith('\ufeffreceived_at,source,seq,result,status\r\n'));
  assert.ok(text.includes('"demo","1","85",""'));
  assert.ok(text.endsWith('\r\n'));
});
