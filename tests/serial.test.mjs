import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialSession } from '../dist/serial.mjs';

function fixture() {
  let controller, opened = 0, closed = 0, options;
  const port = {
    readable: new ReadableStream({ start(value) { controller = value; } }),
    async open(value) { opened++; options = value; },
    async close() { assert.equal(this.readable.locked, false); closed++; },
  };
  const serial = { async requestPort() { return port; } };
  return { port, serial, controller, get opened() { return opened; }, get closed() { return closed; }, get options() { return options; } };
}

test('opens 8N1, reads frames, cancels reads and releases locks before close', async () => {
  const f = fixture(), lines = [], endings = [];
  const session = new SerialSession({ onLine: line => lines.push(line), onOverflow: () => assert.fail(), onEnd: (...args) => endings.push(args) });
  await session.connect(f.serial, 115200); session.start();
  f.controller.enqueue(new TextEncoder().encode('{"input":1,'));
  f.controller.enqueue(new TextEncoder().encode('"result":2}\n'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(lines, ['{"input":1,"result":2}']);
  await session.disconnect();
  assert.deepEqual(f.options, { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  assert.equal(f.opened, 1); assert.equal(f.closed, 1); assert.equal(session.port, null);
  assert.deepEqual(endings, [[null, true]]);
});

test('unplugged devices report failure and preserve already completed lines', async () => {
  const f = fixture(), lines = [], endings = [];
  const session = new SerialSession({ onLine: line => lines.push(line), onOverflow: () => assert.fail(), onEnd: (...args) => endings.push(args) });
  await session.connect(f.serial, 9600); session.start();
  f.controller.enqueue(new TextEncoder().encode('complete\npartial'));
  await new Promise(resolve => setTimeout(resolve, 5));
  const error = new Error('device removed'); f.controller.error(error);
  await session.readTask;
  assert.deepEqual(lines, ['complete']);
  assert.equal(endings[0][0], error); assert.equal(endings[0][1], false);
  assert.equal(f.closed, 1); assert.equal(session.port, null);
});

test('port selection and open failures propagate without starting a reader', async () => {
  const f = fixture();
  const session = new SerialSession({ onLine() {}, onOverflow() {}, onEnd() {} });
  const cancel = new Error('cancelled');
  await assert.rejects(session.connect({ async requestPort() { throw cancel; } }, 115200), cancel);
  assert.equal(session.port, null);
  f.port.open = async () => { throw new Error('port busy'); };
  await assert.rejects(session.connect(f.serial, 115200), /port busy/);
  assert.equal(session.port, null); assert.equal(session.reader, null);
});
