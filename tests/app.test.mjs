import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// A small DOM adapter exercises app state and serial integration without a browser.
class Element {
  constructor() { this.events = new Map(); this.attributes = {}; this.children = []; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; this.className = ''; this.scrollHeight = 0; this.clientHeight = 0; this.scrollTop = 0; this.classList = { toggle() {} }; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  async click() { return this.events.get('click')?.({ target: this }); }
  remove() {}
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}

test('dashboard demo, pause, export and real serial use separate sessions', async () => {
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements.get('baud').value = '115200'; elements.get('window').value = '120';
  const timers = new Map(); let timerId = 0, controller, savedBlob;
  const written=[];
  const originals = new Map();
  function mock(key, value) { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
  const originalCreateURL = URL.createObjectURL;
  const originalRevokeURL = URL.revokeObjectURL;
  try {
    mock('document', { getElementById(id) { assert.ok(elements.has(id), `HTML is missing ${id}`); return elements.get(id); }, createElement() { return new Element(); }, createElementNS() { return new Element(); }, querySelectorAll() { return []; }, addEventListener() {}, body: new Element() });
    const stored = new Map();
    mock('window', { isSecureContext: true, addEventListener() {}, confirm() { return true; }, localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } });
    mock('setInterval', (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; });
    mock('clearInterval', id => timers.delete(id));
    mock('setTimeout', callback => { callback(); return 0; });
    const port = { readable: new ReadableStream({ start(value) { controller = value; } }), writable:new WritableStream({write(value){written.push([...value]);}}), async open() {}, async close() { assert.equal(this.readable.locked, false);assert.equal(this.writable.locked,false); }, getInfo() { return {}; } };
    mock('navigator', { serial: { async requestPort() { return port; } } });
    URL.createObjectURL = blob => { savedBlob = blob; return 'blob:test'; }; URL.revokeObjectURL = () => {};
    await import('../dist/app.mjs');
    const tick = () => [...timers.values()].find(timer => timer.delay === 250).callback();
    const demoTick = () => [...timers.values()].find(timer => timer.delay === 100).callback();
    assert.equal(elements.get('frame-count').textContent, '0');
    assert.equal(elements.get('learn-baseline').disabled,true);
    await elements.get('learn-baseline').click();assert.deepEqual(written,[]);
    await elements.get('demo').click();
    for (let i = 0; i < 5; i++) demoTick();
    tick();
    assert.equal(elements.get('frame-count').textContent, '6');
    assert.match(elements.get('connection-status').textContent, /模拟/);
    assert.ok(elements.get('latest-packet').textContent.includes('"result"'));
    assert.equal(elements.has('gpio-grid'), false);
    assert.ok(elements.get('result-path').attributes.d.includes('L'));
    await elements.get('pause').click(); demoTick(); tick();
    assert.equal(elements.get('frame-count').textContent, '6');
    await elements.get('export').click();
    const exported = await savedBlob.text();
    assert.ok(exported.includes('"demo"')); assert.equal(exported.trim().split('\r\n').length, 8);
    await elements.get('pause').click();
    assert.equal(elements.get('frame-count').textContent, '7');
    await elements.get('guide-top').click(); assert.equal(elements.get('guide').open, true);
    await elements.get('guide-close').click(); assert.equal(elements.get('guide').open, false);
    await elements.get('connect').click();
    assert.equal(elements.get('frame-count').textContent, '0');
    assert.equal(elements.get('demo').disabled, true);
    assert.equal([...timers.values()].some(timer => timer.delay === 100), false);
    controller.enqueue(new TextEncoder().encode('{"result":'));
    controller.enqueue(new TextEncoder().encode('85}\n'));
    await new Promise(resolve => setImmediate(resolve)); tick();
    assert.equal(elements.get('result-value').textContent, '85');
    assert.equal(elements.get('status-value').textContent, '—');
    assert.equal(elements.get('packet-status').textContent, '未提供');
    assert.equal(elements.get('records-body').children[0].children[4].textContent, '真实串口');
    await elements.get('raw-tab').click(); assert.equal(elements.get('raw-panel').hidden, false);
    assert.ok(elements.get('raw-log').textContent.includes('"result":85'));
    assert.equal(elements.get('learn-baseline').disabled,false);
    await elements.get('learn-baseline').click();assert.deepEqual(written,[[0x43]]);
    assert.match(elements.get('notice').textContent,/等待固件回执/);
    assert.equal(elements.get('status-value').textContent,'—');
    controller.enqueue(new TextEncoder().encode('CALIBRATION START: healthy machine\n'));
    await new Promise(resolve=>setImmediate(resolve));tick();
    assert.match(elements.get('status-value').textContent,/已开始学习/);
    await elements.get('clear-baseline').click();assert.deepEqual(written,[[0x43],[0x52]]);
    const wheel=win=>`win=${win} rms_mg=12 peak_mg=30 base=0 flags=0 status=UNLEARNED\n`;
    controller.enqueue(new TextEncoder().encode(wheel(1)+wheel(3)+wheel(4)));
    await new Promise(resolve=>setImmediate(resolve));tick();
    assert.equal((elements.get('result-path').attributes.d.match(/M/g)||[]).length,2);
    assert.equal((elements.get('result-area').attributes.d.match(/Z/g)||[]).length,1);
    const cnn={version:1,pred:2,scores:[-4,1,7],trained:true,model:'a'.repeat(64),cycles:900000,rpm_ref:620,overruns:0,scope:'experimental'};
    controller.enqueue(new TextEncoder().encode(JSON.stringify({seq:5,result:110,status:0,cnn})+'\n'));
    await new Promise(resolve=>setImmediate(resolve));tick();
    assert.match(elements.get('status-value').textContent,/CNN预测：轴承松动/);
    assert.match(elements.get('latest-packet').textContent,/620 rpm/);
    assert.equal(elements.get('learn-baseline').disabled,true);
    await elements.get('learn-baseline').click();assert.deepEqual(written,[[0x43],[0x52]]);
    controller.enqueue(new TextEncoder().encode('CNN_EVENT flags=4\n'));
    await new Promise(resolve=>setImmediate(resolve));tick();
    assert.match(elements.get('status-value').textContent,/无效/);
    assert.match(elements.get('latest-packet').textContent,/上次结果/);
    await elements.get('connect').click();
    assert.equal(elements.get('connection-status').textContent, '未连接');
    assert.equal(elements.get('frame-count').textContent, '5');
    assert.equal(elements.get('demo').disabled, false);
    assert.equal(elements.get('clear-baseline').disabled,true);
  } finally {
    URL.createObjectURL = originalCreateURL; URL.revokeObjectURL = originalRevokeURL;
    for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});
