import { parseLine, gpioPin, csv, MAX_RECORDS } from './protocol.mjs';
import { SerialSession } from './serial.mjs';

const $ = id => document.getElementById(id);
const fmt = value => value === undefined ? '—' : Math.abs(value) >= 1e7 || (value !== 0 && Math.abs(value) < .001) ? value.toExponential(2) : value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
const time = stamp => new Date(stamp).toLocaleTimeString('zh-CN', { hour12: false });
const hex = value => value === undefined ? '—' : '0x' + value.toString(16).toUpperCase().padStart(8, '0');
let mode = 'idle', records = [], logs = [], total = 0, invalid = 0, recent = [];
let started = null, paused = false, demoTimer = null, serialSession = null, busy = false, demoSeq = 0;
let lastRender = 0, dirty = true, hasStarted = false;
const gpioElements = [];

for (let pin = 0; pin < 8; pin++) {
  const node = document.createElement('div'); node.className = 'gpio-pin unknown';
  const number = document.createElement('span'); number.className = 'pin-number'; number.textContent = 'P' + pin;
  const level = document.createElement('span'); level.className = 'pin-level'; level.textContent = '—';
  const direction = document.createElement('span'); direction.className = 'pin-direction'; direction.textContent = '—';
  node.append(number, level, direction); $('gpio-grid').append(node); gpioElements.push({ node, level, direction });
}

function notice(message, type = '') { $('notice').textContent = message; $('notice').className = 'notice' + (type ? ' ' + type : ''); }
function rawLine(text) {
  if (!text.trim()) return;
  logs.push(`${time(Date.now())}  ${text.slice(0, 8192)}`);
  if (logs.length > 120) logs.shift();
  dirty = true;
}
function receive(line) {
  rawLine(line);
  const parsed = parseLine(line);
  if (parsed.kind === 'invalid') { invalid++; rawLine(`[解析错误] ${parsed.reason}`); dirty = true; }
  if (parsed.kind !== 'frame') return;
  const stamp = Date.now();
  records.push({ ...parsed.frame, received_at: new Date(stamp).toISOString(), received_ms: stamp, source: mode === 'demo' ? 'demo' : 'serial' });
  if (records.length > MAX_RECORDS) records.shift();
  total++; recent.push(stamp); dirty = true;
}
function resetRecords() {
  records = []; logs = []; total = 0; invalid = 0; recent = [];
  if (mode === 'demo' || mode === 'serial') started = Date.now();
  dirty = true; render();
}
function newSession() {
  started = Date.now(); hasStarted = true; demoSeq = 0; paused = false;
  $('pause').textContent = 'Ⅱ'; $('pause').setAttribute('aria-label', '暂停图表'); $('pause').setAttribute('aria-pressed', 'false');
  resetRecords();
}
function controls() {
  $('connect').disabled = busy;
  $('connect').textContent = mode === 'serial' ? '断开连接' : busy ? '连接中…' : '↔ 连接串口';
  $('demo').disabled = busy || mode === 'serial';
  $('demo').textContent = mode === 'demo' ? '□ 停止演示' : '▷ 模拟演示';
  $('baud').disabled = busy || mode === 'serial';
  $('connection-status').textContent = mode === 'serial' ? '设备已连接' : mode === 'demo' ? '模拟演示中' : busy ? '正在连接' : '未连接';
  $('status-dot').className = 'status-dot' + (mode === 'serial' ? ' live' : mode === 'demo' ? ' demo' : '');
  $('source-tag').textContent = mode === 'serial' ? '真实串口' : mode === 'demo' ? '模拟数据' : hasStarted ? '采集已停止' : '等待设备';
  $('side-source').textContent = mode === 'serial' ? '接收真实设备数据' : mode === 'demo' ? '模拟数据源运行中' : hasStarted ? '采集已停止' : '等待数据源';
  $('record-source').textContent = mode === 'demo' ? '模拟数据会话' : mode === 'serial' ? '真实设备会话' : '当前会话';
}
function stopDemo() {
  clearInterval(demoTimer); demoTimer = null;
  if (mode === 'demo') mode = 'idle';
  controls(); dirty = true;
}
function startDemo() {
  mode = 'demo'; newSession(); controls();
  notice('模拟演示中：下方数值、曲线和 GPIO 均为生成的示例数据，不代表板子实测。', 'demo');
  let filtered = 100;
  const frame = () => {
    demoSeq++;
    const input = 110 + 30 * Math.sin(demoSeq / 15) + 10 * Math.cos(demoSeq / 4) + (Math.random() - .5) * 15;
    filtered = filtered * .75 + input * .25;
    receive(JSON.stringify({ seq: demoSeq, input: Math.round(input * 100) / 100, result: Math.round(filtered * 100) / 100, status: 0, gpio_in: (Math.floor(demoSeq / 8) * 13) & 255, gpio_out: filtered > 110 ? 17 : 16, gpio_dir: 17 }));
  };
  frame(); demoTimer = setInterval(frame, 100);
}
$('demo').addEventListener('click', () => {
  if (mode === 'demo') { stopDemo(); notice('模拟演示已停止，记录仍保留。可以导出数据，或连接真实设备。'); }
  else startDemo();
});

$('connect').addEventListener('click', async () => {
  if (busy) return;
  if (mode === 'serial') {
    busy = true; controls();
    try { await serialSession.disconnect(); }
    catch (error) { notice('断开连接时发生错误：' + error.message, 'error'); }
    finally { busy = false; controls(); }
    return;
  }
  if (!window.isSecureContext || !('serial' in navigator)) {
    notice('当前环境不支持直接连接串口。请用支持 Web Serial 的桌面浏览器打开 HTTPS 或 localhost 页面；现在仍可使用模拟演示。', 'error');
    return;
  }
  stopDemo(); busy = true; controls();
  const session = new SerialSession({
    onLine: receive,
    onOverflow: () => { invalid++; rawLine('[解析错误] 报文超过 8192 字符，已丢弃至下一个换行'); },
    onEnd: (error, intentional) => {
      if (serialSession !== session) return;
      mode = 'idle'; dirty = true; controls();
      notice(error ? `串口连接中断：${error.message}。数据已保留，可重新连接。` : intentional ? '串口已断开，接收记录已保留。' : '设备数据流已结束，记录已保留。', error ? 'error' : '');
    },
  });
  serialSession = session;
  try {
    await session.connect(navigator.serial, Number($('baud').value));
    mode = 'serial'; newSession();
    const info = session.port.getInfo?.() ?? {};
    const label = info.usbVendorId === undefined ? '' : ` · USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}`;
    notice(`串口已连接${label}。等待设备发送每行一组 JSON 数据；当前 ${$('baud').value} baud / 8N1。`);
    session.start();
  } catch (error) {
    mode = 'idle';
    if (error.name === 'NotFoundError') notice('已取消选择串口。点击「连接串口」可以重新选择设备。');
    else if (error.name === 'SecurityError') notice('浏览器未允许访问串口。请在独立标签页打开网页，并检查浏览器的串口权限。', 'error');
    else notice(`无法打开串口：${error.message}。请检查设备连接及串口是否被其他工具占用。`, 'error');
  } finally { busy = false; controls(); }
});

function svgElement(tag, attributes, label) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (label !== undefined) element.textContent = label;
  return element;
}
function drawChart() {
  const frames = records.slice(-Number($('window').value));
  const grid = $('chart-grid'), labels = $('chart-labels'); grid.replaceChildren(); labels.replaceChildren();
  const left = 54, right = 742, top = 20, bottom = 232;
  const values = frames.flatMap(frame => [frame.input, frame.result]);
  const maxAbs = Math.max(1, ...values.map(value => Math.abs(value)));
  let low = values.length ? Math.min(...values.map(value => value / maxAbs)) : 0;
  let high = values.length ? Math.max(...values.map(value => value / maxAbs)) : 1;
  const padding = Math.max((high - low) * .15, values.length ? .015 : 0);
  low -= padding; high += padding;
  const y = value => bottom - ((value / maxAbs - low) / (high - low)) * (bottom - top);
  for (let i = 0; i <= 4; i++) {
    const position = top + (bottom - top) * i / 4;
    grid.append(svgElement('line', { x1: left, x2: right, y1: position, y2: position, stroke: '#e9eee2', 'stroke-dasharray': '3 5' }));
    const labelValue = (high - (high - low) * i / 4) * maxAbs;
    labels.append(svgElement('text', { x: left - 10, y: position + 3, 'text-anchor': 'end', fill: '#9fac93', 'font-size': 9, 'font-family': 'monospace' }, Number.isFinite(labelValue) ? fmt(labelValue) : '—'));
  }
  for (let i = 0; i <= 4; i++) {
    const x = left + (right - left) * i / 4;
    grid.append(svgElement('line', { x1: x, x2: x, y1: top, y2: bottom, stroke: '#f0f3eb' }));
    if (frames.length) {
      const frame = frames[Math.round((frames.length - 1) * i / 4)];
      labels.append(svgElement('text', { x, y: 256, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', fill: '#9fac93', 'font-size': 9, 'font-family': 'monospace' }, time(frame.received_ms)));
    }
  }
  const x = index => frames.length <= 1 ? (left + right) / 2 : left + (right - left) * index / (frames.length - 1);
  const path = field => frames.map((frame, index) => `${index ? 'L' : 'M'}${x(index).toFixed(2)},${y(frame[field]).toFixed(2)}`).join(' ');
  $('input-path').setAttribute('d', path('input')); $('result-path').setAttribute('d', path('result'));
  $('result-area').setAttribute('d', frames.length > 1 ? `${path('result')} L${x(frames.length - 1)},${bottom} L${x(0)},${bottom} Z` : '');
  $('chart-empty').hidden = frames.length > 0;
  $('chart-description').textContent = frames.length ? `显示最近 ${frames.length} 帧。最新输入 ${fmt(frames.at(-1).input)}，最新结果 ${fmt(frames.at(-1).result)}。` : '连接串口或开启模拟演示后显示曲线。';
  $('chart-caption').textContent = frames.length ? `横轴：接收时间 · 已显示 ${frames.length} 帧` : '横轴：接收时间 · 纵轴：数据值';
}
function render() {
  const latest = records.at(-1);
  $('input-value').textContent = fmt(latest?.input); $('result-value').textContent = fmt(latest?.result);
  $('frame-count').textContent = total.toLocaleString('zh-CN'); $('invalid-count').textContent = `异常报文 ${invalid}`;
  $('device-status').textContent = latest?.status === undefined ? '状态：未提供' : latest.status === 0 ? '状态：正常' : `状态码：${latest.status}`;
  const rangeFrames = records.slice(-Number($('window').value));
  for (const field of ['input', 'result']) {
    const values = rangeFrames.map(frame => frame[field]);
    $(field + '-range').textContent = values.length ? `范围 ${fmt(Math.min(...values))} – ${fmt(Math.max(...values))}` : '等待第一组数据';
  }
  const now = Date.now(); recent = recent.filter(stamp => stamp > now - 5000);
  const live = mode === 'serial' || mode === 'demo';
  const interval = started === null ? 5 : Math.min(5, Math.max(.5, (now - started) / 1000));
  $('rate-value').textContent = (live ? recent.length / interval : 0).toFixed(1);
  $('chart-state').textContent = paused ? '显示已暂停 · 接收继续' : mode === 'demo' ? '模拟数据' : mode === 'serial' ? '实时接收' : latest ? '采集已停止' : '等待数据';
  for (const [pin, elements] of gpioElements.entries()) {
    const state = gpioPin(latest, pin);
    elements.level.textContent = state.level === undefined ? '—' : String(state.level);
    elements.direction.textContent = state.direction;
    elements.node.className = 'gpio-pin' + (state.level === undefined ? ' unknown' : state.level ? ' high' : '');
    elements.node.setAttribute('aria-label', `GPIO ${pin}，${state.level === undefined ? '电平未提供' : state.level ? '高电平' : '低电平'}，${state.direction}`);
  }
  $('gpio-input').textContent = hex(latest?.gpio_in); $('gpio-output').textContent = hex(latest?.gpio_out); $('gpio-direction').textContent = hex(latest?.gpio_dir);
  $('export').disabled = records.length === 0;
  $('record-note').textContent = total > MAX_RECORDS ? `已接收 ${total.toLocaleString()} 帧 · 保留最近 10,000 帧` : '最多保留最近 10,000 帧';
  const body = $('records-body'); body.replaceChildren();
  if (!records.length) {
    const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 6; cell.className = 'empty-cell'; cell.textContent = '采集开始后，最新数据将显示在这里。'; row.append(cell); body.append(row);
  } else for (const frame of records.slice(-6).reverse()) {
    const row = document.createElement('tr');
    for (const value of [frame.seq === undefined ? '—' : String(frame.seq).padStart(4, '0'), time(frame.received_ms), fmt(frame.input), fmt(frame.result)]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    const statusCell = document.createElement('td'), status = document.createElement('span');
    status.className = 'status-pill' + (frame.status === undefined ? ' unknown' : frame.status ? ' warning' : '');
    status.textContent = frame.status === undefined ? '未提供' : frame.status === 0 ? '正常' : `状态 ${frame.status}`; statusCell.append(status); row.append(statusCell);
    const source = document.createElement('td'); source.className = 'table-source'; source.textContent = frame.source === 'demo' ? '模拟数据' : '真实串口'; row.append(source); body.append(row);
  }
  const terminal = $('raw-log');
  const atBottom = terminal.scrollHeight - terminal.clientHeight - terminal.scrollTop < 30;
  terminal.textContent = logs.length ? logs.join('\n') : '等待串口报文…';
  if (atBottom) terminal.scrollTop = terminal.scrollHeight;
  drawChart(); dirty = false; lastRender = now;
}

$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').textContent = paused ? '▷' : 'Ⅱ'; $('pause').setAttribute('aria-label', paused ? '恢复图表' : '暂停图表'); $('pause').setAttribute('aria-pressed', String(paused));
  $('chart-state').textContent = paused ? '显示已暂停 · 接收继续' : '实时显示';
  if (!paused) { dirty = true; render(); }
});
$('window').addEventListener('change', () => { if (!paused) { dirty = true; render(); } });
$('clear').addEventListener('click', () => { resetRecords(); notice(mode === 'demo' ? '演示记录已清空，模拟数据仍在生成。' : '记录已清空。采集会话保持当前状态。', mode === 'demo' ? 'demo' : ''); });
$('export').addEventListener('click', () => {
  if (!records.length) return;
  const content = csv(records), source = records[0].source;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `cpu-lab-${source}-${new Date().toISOString().replaceAll(':', '-')}.csv`; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function selectTab(raw) {
  $('data-tab').classList.toggle('active', !raw); $('raw-tab').classList.toggle('active', raw);
  $('data-tab').setAttribute('aria-selected', String(!raw)); $('raw-tab').setAttribute('aria-selected', String(raw));
  $('data-tab').tabIndex = raw ? -1 : 0; $('raw-tab').tabIndex = raw ? 0 : -1;
  $('data-panel').hidden = raw; $('raw-panel').hidden = !raw;
}
$('data-tab').addEventListener('click', () => selectTab(false)); $('raw-tab').addEventListener('click', () => selectTab(true));
for (const tab of [$('data-tab'), $('raw-tab')]) tab.addEventListener('keydown', event => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const raw = event.key === 'End' || (event.key !== 'Home' && tab.id === 'data-tab'); selectTab(raw); $(raw ? 'raw-tab' : 'data-tab').focus();
  }
});
for (const id of ['guide-open', 'guide-top']) $(id).addEventListener('click', () => $('guide').showModal());
for (const id of ['guide-close', 'guide-done']) $(id).addEventListener('click', () => $('guide').close());
$('guide').addEventListener('click', event => { if (event.target !== $('guide')) return; const bounds = $('guide').getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $('guide').close(); });
for (const link of document.querySelectorAll('a.nav-link')) link.addEventListener('click', () => {
  for (const item of document.querySelectorAll('a.nav-link')) item.classList.toggle('active', item === link);
});
window.addEventListener('beforeunload', () => { stopDemo(); if (mode === 'serial') void serialSession?.disconnect(); });
setInterval(() => {
  if ((mode === 'demo' || mode === 'serial') && started !== null) {
    const seconds = Math.floor((Date.now() - started) / 1000);
    $('session-time').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  if (!paused && (dirty || Date.now() - lastRender >= 1000)) render();
}, 250);
controls(); render();
if (!window.isSecureContext || !('serial' in navigator)) notice('当前浏览器环境未提供串口接口。你可以先点击「模拟演示」；连接设备时请用支持 Web Serial 的桌面浏览器打开 HTTPS 或 localhost 页面。');
