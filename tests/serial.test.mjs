import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialSession, serialErrorText } from '../dist/serial.mjs';

function fixture() {
  let controller, opened = 0, closed = 0, options;
  const written=[];
  const port = {
    readable: new ReadableStream({ start(value) { controller = value; } }),
    writable:new WritableStream({write(value){written.push([...value]);}}),
    async open(value) { opened++; options = value; },
    async close() { assert.equal(this.readable.locked, false); assert.equal(this.writable.locked,false); closed++; },
  };
  const serial = { async requestPort() { return port; } };
  return { port, serial, controller,written, get opened() { return opened; }, get closed() { return closed; }, get options() { return options; } };
}

test('commands send exactly one byte and require an active writable session',async()=>{
  const f=fixture(),s=new SerialSession({onLine(){},onOverflow(){},onEnd(){}});
  await assert.rejects(s.sendCommand('C'),/先连接/);
  await s.connect(f.serial,115200);
  await assert.rejects(s.sendCommand('C'),/先连接/);
  s.start();
  await assert.rejects(s.sendCommand('C\n'),/只支持/);
  await s.sendCommand('C');await s.sendCommand('R');
  assert.deepEqual(f.written,[[0x43],[0x52]]);assert.equal(f.port.writable.locked,false);
  await s.disconnect();await assert.rejects(s.sendCommand('R'),/先连接/);
  const second=fixture();await s.connect(second.serial,115200);
  await assert.rejects(s.sendCommand('R'),/先连接/);
  await s.disconnect();
});

test('disconnect waits for pending writes to release their lock and refuses overlap',{timeout:2000},async()=>{
  const f=fixture();let release;
  f.port.writable=new WritableStream({write(){return new Promise(resolve=>{release=resolve;});}});
  const s=new SerialSession({onLine(){},onOverflow(){},onEnd(){}});
  await s.connect(f.serial,115200);s.start();
  const sending=s.sendCommand('C');
  await new Promise(resolve=>setTimeout(resolve,5));
  await assert.rejects(s.sendCommand('R'),/上一条/);
  const disconnecting=s.disconnect();
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.closed,0);
  release();await Promise.allSettled([sending,disconnecting]);
  assert.equal(f.closed,1);assert.equal(f.port.writable.locked,false);
});

test('failed writes release the writer and propagate without reporting successful commands',async()=>{
  const f=fixture();f.port.writable=new WritableStream({write(){throw new Error('write failed');}});
  const s=new SerialSession({onLine(){},onOverflow(){},onEnd(){}});
  await s.connect(f.serial,115200);s.start();
  await assert.rejects(s.sendCommand('C'),/write failed/);assert.equal(f.port.writable.locked,false);
  await s.disconnect();assert.equal(f.closed,1);
});

test('opens 8N1, reads frames, cancels reads and releases locks before close', async () => {
  const f = fixture(), lines = [], endings = [];
  const session = new SerialSession({ onLine: line => lines.push(line), onOverflow: () => assert.fail(), onEnd: (...args) => endings.push(args) });
  await session.connect(f.serial, 115200); session.start();
  f.controller.enqueue(new TextEncoder().encode('{"input":1,'));
  f.controller.enqueue(new TextEncoder().encode('"result":2}\n'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(lines, ['{"input":1,"result":2}']);
  await session.disconnect();
  assert.deepEqual(f.options, { baudRate: 115200, bufferSize: 65536, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
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

test('recovers replacement streams without closing and discards damaged fragments', async () => {
  const f = fixture(), lines = [], recoveries = [], endings = [], resumptions = [];
  const session = new SerialSession({ onLine: line => lines.push(line), onOverflow() {}, onRecoverable: (...args) => recoveries.push(args), onResumed: count => resumptions.push(count), onEnd: (...args) => endings.push(args) });
  await session.connect(f.serial, 115200); session.start();
  f.controller.enqueue(new TextEncoder().encode('before\npartial'));
  await new Promise(resolve => setTimeout(resolve, 5));
  let replacementController;
  const oldStream = f.port.readable;
  f.port.readable = new ReadableStream({ start(c) { replacementController = c; } });
  const error = new DOMException('A framing error has been detected.', 'FramingError');
  f.controller.error(error);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(oldStream.locked, false); assert.equal(f.closed, 0);
  replacementController.enqueue(new TextEncoder().encode('damaged-tail'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(resumptions, []);
  replacementController.enqueue(new TextEncoder().encode('\nafter\n'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(lines, ['before', 'after']);
  assert.deepEqual(resumptions, [1]);
  replacementController.enqueue(new TextEncoder().encode('another\n'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(resumptions, [1]);
  assert.deepEqual(recoveries, [[error, 1]]); assert.deepEqual(endings, []);
  await session.disconnect();
  assert.equal(f.closed, 1); assert.deepEqual(endings, [[null, true]]);
});

test('a non-replaced error stream terminates instead of retrying forever', async () => {
  const f = fixture(), endings = [];
  const session = new SerialSession({ onLine() {}, onOverflow() {}, onRecoverable() { assert.fail(); }, onEnd: (...args) => endings.push(args) });
  await session.connect(f.serial, 115200); session.start();
  const error = new DOMException('break', 'BreakError');
  f.controller.error(error); await session.readTask;
  assert.equal(endings[0][0], error); assert.equal(f.closed, 1);
});

test('repeated replacement failures are bounded and cancellation during recovery is safe', async () => {
  const f = fixture(), recoveries = [], endings = [];
  const error = new DOMException('overflow', 'BufferOverrunError');
  const failingStream = () => new ReadableStream({ pull(c) {
    f.port.readable = failingStream(); c.error(error);
  } }, { highWaterMark: 0 });
  f.port.readable = failingStream();
  const session = new SerialSession({ onLine() {}, onOverflow() {}, onRecoverable: (_, count) => recoveries.push(count), onEnd: (...args) => endings.push(args) });
  await session.connect(f.serial, 115200); session.start();
  await session.readTask;
  assert.deepEqual(recoveries, [1, 2, 3, 4, 5]);
  assert.equal(endings[0][0], error); assert.equal(f.closed, 1);

  const f2 = fixture(), ends2 = [];
  const second = new SerialSession({ onLine() {}, onOverflow() {}, onRecoverable() { void second.disconnect(); }, onEnd: (...args) => ends2.push(args) });
  await second.connect(f2.serial, 115200); second.start();
  f2.port.readable = new ReadableStream();
  f2.controller.error(error); await second.readTask;
  assert.deepEqual(ends2, [[null, true]]); assert.equal(f2.closed, 1);
});

test('consumer errors are not mistaken for recoverable serial driver errors', async () => {
  const f = fixture(), endings = [], error = new Error('parser failed');
  const session = new SerialSession({ onLine() { throw error; }, onOverflow() {}, onRecoverable() { assert.fail(); }, onEnd: (...args) => endings.push(args) });
  await session.connect(f.serial, 115200); session.start();
  f.controller.enqueue(new TextEncoder().encode('line\n')); await session.readTask;
  assert.equal(endings[0][0], error); assert.equal(f.closed, 1);
  assert.match(serialErrorText(new DOMException('lost', 'NetworkError')), /USB.*NetworkError: lost/);
  assert.match(serialErrorText(new DOMException('bad frame', 'FramingError')), /波特率.*FramingError: bad frame/);
});
