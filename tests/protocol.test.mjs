import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, LineFramer, MAX_LINE, gpioPin, csv } from '../dist/protocol.mjs';

test('accepts the AM integer frame and preserves absent optional fields', () => {
  assert.deepEqual(parseLine('{"input":120,"result":85}'), { kind: 'frame', frame: { input: 120, result: 85 } });
  assert.equal(parseLine('boot complete').kind, 'log');
  assert.equal(parseLine(' \r ').kind, 'empty');
  assert.equal(parseLine('{bad json').kind, 'invalid');
  for (const frame of [
    { input: '120', result: 85 }, { input: 120 },
    { input: 1, result: 2, gpio_in: -1 }, { input: 1, result: 2, gpio_out: 4294967296 },
    { input: 1, result: 2, status: .5 }, { input: 1, result: 2, seq: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(parseLine(JSON.stringify(frame)).kind, 'invalid');
  assert.equal(parseLine('{"input":1e999,"result":1}').kind, 'invalid');
  assert.equal(parseLine('{"input":1,"result":2,"gpio_in":4294967295}').kind, 'frame');
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

test('GPIO distinguishes unknown fields, pin levels and output direction', () => {
  assert.deepEqual(gpioPin(undefined, 0), { direction: '—', level: undefined });
  assert.deepEqual(gpioPin({ gpio_in: 1 }, 0), { direction: '—', level: 1 });
  assert.deepEqual(gpioPin({ gpio_in: 0, gpio_out: 1, gpio_dir: 1 }, 0), { direction: 'OUT', level: 1 });
  assert.deepEqual(gpioPin({ gpio_in: 0, gpio_out: 1, gpio_dir: 0 }, 0), { direction: 'IN', level: 0 });
  assert.deepEqual(gpioPin({ gpio_dir: 1 }, 0), { direction: 'OUT', level: undefined });
  assert.equal(gpioPin({ gpio_in: 0x80000000, gpio_dir: 0 }, 31).level, 1);
});

test('CSV records the data source and does not turn absent GPIO into zero', () => {
  const text = csv([{ received_at: '2026-10-14T12:00:00.000Z', source: 'demo', seq: 1, input: 120, result: 85, status: 0 }]);
  assert.ok(text.startsWith('\ufeffreceived_at,source,seq,input,result,status,gpio_in,gpio_out,gpio_dir\r\n'));
  assert.ok(text.includes('"demo","1","120","85","0","","",""'));
  assert.ok(text.endsWith('\r\n'));
});
