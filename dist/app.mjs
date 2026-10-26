import { parseLine, csv, MAX_RECORDS, splitSeries } from './protocol.mjs?v=20261026.1';
import { SerialSession, serialErrorText, SERIAL_RECEIVER_VERSION } from './serial.mjs?v=20261026.1';
import { SessionStore, BackupError, StorageConflictError, createBackup, parseBackup, MAX_BACKUP_BYTES } from './storage.mjs?v=20261026.1';
import { wheelStatus, parseEvent } from './uart.mjs?v=20261026.1';
import { mountDecoder } from './decoder-panel.mjs?v=20261026.1';

const $ = id => document.getElementById(id);
$('serial-version').textContent = `接收器 ${SERIAL_RECEIVER_VERSION}`;
const fmt = value => value === undefined ? '—' : Math.abs(value) >= 1e7 || (value !== 0 && Math.abs(value) < .001) ? value.toExponential(2) : value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
const time = stamp => new Date(stamp).toLocaleTimeString('zh-CN', { hour12: false });
let mode = 'idle', records = [], logs = [], total = 0, invalid = 0, recent = [];
let started = null, paused = false, demoTimer = null, serialSession = null, busy = false, demoSeq = 0;
let lastDeviceEvent=null;
let commandBusy=false;
let lastRender = 0, dirty = true, hasStarted = false;
let savePending = false, lastSaveAttempt = 0, storageConflict = false, unreadableSaved = false, importBusy = false, restored = false;
const store = new SessionStore();

function notice(message, type = '') { $('notice').textContent = message; $('notice').className = 'notice' + (type ? ' ' + type : ''); }
function snapshot() { return { records, logs, total, invalid, started }; }
function storageStatus(message, error = false, savedAt) {
  $('storage-state').textContent = message;
  $('storage-note').classList.toggle('error', error);
  if (savedAt) $('saved-at').textContent = `上次保存 ${time(Date.parse(savedAt))}`;
}
function saveRecords(force = false) {
  if (!savePending || storageConflict || (!force && Date.now() - lastSaveAttempt < 1000)) return;
  lastSaveAttempt = Date.now();
  try {
    const savedAt = store.save(snapshot());
    savePending = false; unreadableSaved = false;
    storageStatus('记录已自动保存在此浏览器', false, savedAt);
  } catch (error) {
    storageConflict = error instanceof StorageConflictError;
    storageStatus(storageConflict ? '其他标签页更新了记录，自动保存已暂停。请导出本页备份后刷新。' : '自动保存失败，请立即导出本地备份。浏览器存储可能已满或被禁用。', true);
  }
}
function confirmReplace(action) {
  if (!records.length && !logs.length && !unreadableSaved) return true;
  return window.confirm(`${action}会覆盖当前记录及此浏览器保存的记录。建议先导出备份。是否继续？`);
}
function recordActions() {
  $('export').disabled = records.length === 0;
  $('backup-export').disabled = records.length === 0 && logs.length === 0;
}
function restoreSession(session) {
  ({ records, logs, total, invalid, started } = session);
  lastDeviceEvent=null;
  for(const storedLine of logs) {
    const line=storedLine.replace(/^\d{1,2}:\d{2}:\d{2}\s+/, '');
    if(parseLine(line).kind==='frame') lastDeviceEvent=null;
    else { const event=parseEvent(line);if(event)lastDeviceEvent=event; }
  }
  recent = []; paused = false; restored = true;
  hasStarted = records.length > 0 || logs.length > 0 || started !== null;
  const seconds = Math.max(0, Math.floor(((records.at(-1)?.received_ms ?? started) - started) / 1000));
  $('session-time').textContent = started === null ? '00:00' : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('pause').textContent = 'Ⅱ'; $('pause').setAttribute('aria-label', '暂停图表'); $('pause').setAttribute('aria-pressed', 'false');
  dirty = true;
}
function rawLine(text) {
  if (!text.trim()) return;
  logs.push(`${time(Date.now())}  ${text.slice(0, 8192)}`);
  if (logs.length > 120) logs.shift();
  dirty = true; savePending = true; recordActions();
}
function receive(line) {
  rawLine(line);
  const event=parseEvent(line.trim());if(event)lastDeviceEvent=event;
  const parsed = parseLine(line);
  if (parsed.kind === 'invalid') { invalid++; rawLine(`[解析错误] ${parsed.reason}`); dirty = true; }
  if (parsed.kind !== 'frame') return;
  lastDeviceEvent=null;
  const stamp = Date.now();
  records.push({ ...parsed.frame, received_at: new Date(stamp).toISOString(), received_ms: stamp, source: mode === 'demo' ? 'demo' : 'serial' });
  if (records.length > MAX_RECORDS) records.shift();
  total++; recent.push(stamp); dirty = true;
  savePending = true; recordActions();
}
function resetRecords() {
  lastDeviceEvent=null;
  records = []; logs = []; total = 0; invalid = 0; recent = [];
  if (mode === 'demo' || mode === 'serial') started = Date.now();
  restored = false; savePending = true; saveRecords(true);
  dirty = true; render();
}
function newSession() {
  started = Date.now(); hasStarted = true; demoSeq = 0; paused = false;
  $('pause').textContent = 'Ⅱ'; $('pause').setAttribute('aria-label', '暂停图表'); $('pause').setAttribute('aria-pressed', 'false');
  resetRecords();
}
function controls() {
  $('connect').disabled = busy || importBusy;
  $('connect').textContent = mode === 'serial' ? '断开连接' : busy ? '连接中…' : '↔ 连接串口';
  $('demo').disabled = busy || importBusy || mode === 'serial';
  $('demo').textContent = mode === 'demo' ? '□ 停止演示' : '▷ 模拟演示';
  $('baud').disabled = busy || mode === 'serial';
  $('connection-status').textContent = mode === 'serial' ? '设备已连接' : mode === 'demo' ? '模拟演示中' : busy ? '正在连接' : '未连接';
  $('status-dot').className = 'status-dot' + (mode === 'serial' ? ' live' : mode === 'demo' ? ' demo' : '');
  $('source-tag').textContent = mode === 'serial' ? '真实串口' : mode === 'demo' ? '模拟数据' : hasStarted ? '采集已停止' : '等待设备';
  $('side-source').textContent = mode === 'serial' ? '接收真实设备数据' : mode === 'demo' ? '模拟数据源运行中' : hasStarted ? '采集已停止' : '等待数据源';
  $('record-source').textContent = mode === 'demo' ? '模拟数据会话' : mode === 'serial' ? '真实设备会话' : restored ? '已恢复的记录' : '当前会话';
  $('backup-import').disabled = busy || importBusy || mode !== 'idle';
  $('clear').disabled = busy || importBusy;
  for(const id of ['learn-baseline','clear-baseline']) $(id).disabled=commandBusy || busy || importBusy || mode!=='serial' || !serialSession?.port?.writable;
}
for(const [id,command] of [['learn-baseline','C'],['clear-baseline','R']]) $(id).addEventListener('click',async()=>{
  if(commandBusy || busy || importBusy || mode!=='serial')return;
  const question=command==='C'?'开始学习会重建正常基准。请确认机械设备正常、转速和负载稳定，是否发送 C？':'清除后需要重新学习正常基准，是否发送 R？';
  if(!window.confirm(question))return;
  commandBusy=true;controls();
  try {
    await serialSession.sendCommand(command);
    rawLine(`[发送命令] ${command}（等待固件回执）`);
    notice(`已发送 ${command}，等待固件回执确认${command==='C'?'开始学习':'清除基准'}。`);
  } catch(error) { notice(`命令发送失败：${error.message}`, 'error'); }
  finally { commandBusy=false;controls(); }
});
function stopDemo() {
  clearInterval(demoTimer); demoTimer = null;
  if (mode === 'demo') mode = 'idle';
  saveRecords(true); controls(); dirty = true;
}
function startDemo() {
  mode = 'demo'; newSession(); controls();
  notice('模拟演示中：下方处理结果为生成的示例数据，不代表 FPGA 实测。', 'demo');
  let filtered = 100;
  const frame = () => {
    demoSeq++;
    const input = 110 + 30 * Math.sin(demoSeq / 15) + 10 * Math.cos(demoSeq / 4) + (Math.random() - .5) * 15;
    filtered = filtered * .75 + input * .25;
    receive(JSON.stringify({ seq: demoSeq, result: Math.round(filtered * 100) / 100, status: 0 }));
  };
  frame(); demoTimer = setInterval(frame, 100);
}
$('demo').addEventListener('click', () => {
  if (busy || importBusy || mode === 'serial') return;
  if (mode === 'demo') { stopDemo(); notice('模拟演示已停止，记录仍保留。可以导出数据，或连接真实设备。'); }
  else if (confirmReplace('开始新的模拟演示')) startDemo();
});

$('connect').addEventListener('click', async () => {
  if (busy || importBusy) return;
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
  if (!confirmReplace('开始新的串口采集')) return;
  stopDemo(); busy = true; controls();
  const session = new SerialSession({
    onLine: receive,
    onOverflow: () => { invalid++; rawLine('[解析错误] 报文超过 8192 字符，已丢弃至下一个换行'); },
    onRecoverable: (error, count) => {
      if (serialSession !== session) return;
      invalid++; dirty = true;
      const message = `串口仍保持连接，正在恢复接收（第 ${count} 次）：${serialErrorText(error)}。等待下一条完整报文，期间数据可能缺失。`;
      rawLine(`[串口恢复] ${message}`);
      notice(message);
    },
    onResumed: count => {
      if (serialSession !== session || mode !== 'serial') return;
      notice(`串口正在接收，已收到恢复后的完整新报文。当前 ${$('baud').value} baud / 8N1；本次累计恢复 ${count} 次，受影响的数据已丢弃。详情可在“原始报文”查看。`);
    },
    onEnd: (error, intentional) => {
      if (serialSession !== session) return;
      mode = 'idle'; dirty = true; controls();
      saveRecords(true);
      notice(error ? `串口连接中断：${serialErrorText(error)}。数据已保留；确认设备连接及波特率后重新连接。` : intentional ? '串口已断开，接收记录已保留。' : '设备数据流已结束，记录已保留。', error ? 'error' : '');
    },
  });
  serialSession = session;
  try {
    await session.connect(navigator.serial, Number($('baud').value));
    mode = 'serial'; newSession();
    const info = session.port.getInfo?.() ?? {};
    const label = info.usbVendorId === undefined ? '' : ` · USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}`;
    notice(`串口已连接${label}。支持 JSON 结果和 win= 开头的轮轴文本；当前 ${$('baud').value} baud / 8N1。`);
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
  const isWheel=Boolean(records.at(-1)?.wheel);
  const frames = records.filter(frame=>Boolean(frame.wheel)===isWheel).slice(-Number($('window').value));
  const grid = $('chart-grid'), labels = $('chart-labels'); grid.replaceChildren(); labels.replaceChildren();
  const left = 54, right = 742, top = 20, bottom = 232;
  const values = frames.map(frame => frame.result);
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
  let offset=0;
  const paths=[],areas=[];
  for(const segment of splitSeries(frames)) {
    const start=offset;
    const line=segment.map((frame,index)=>`${index?'L':'M'}${x(offset++).toFixed(2)},${y(frame.result).toFixed(2)}`).join(' ');
    paths.push(line);
    if(segment.length>1)areas.push(`${line} L${x(offset-1)},${bottom} L${x(start)},${bottom} Z`);
  }
  $('result-path').setAttribute('d', paths.join(' '));
  $('result-area').setAttribute('d', areas.join(' '));
  $('chart-empty').hidden = frames.length > 0;
  $('chart-description').textContent = frames.length ? `显示最近 ${frames.length} 帧 FPGA 处理结果。最新结果 ${fmt(frames.at(-1).result)}。` : '连接串口或开启模拟演示后显示曲线。';
  $('chart-caption').textContent = frames.length ? `横轴：接收时间 · 已显示 ${frames.length} 帧${isWheel?' · 纵轴：RMS（mg）':''}` : '横轴：接收时间 · 纵轴：数据值';
}
function render() {
  const latest = records.at(-1);
  const wheel=latest?.wheel;
  const wheelInfo=lastDeviceEvent || (wheel?wheelStatus(wheel):null);
  $('result-label').textContent=wheel?'振动有效值（mg）':'最新处理结果';
  $('record-result-heading').textContent=wheel?'有效值（mg）':'处理结果';
  $('packet-note').textContent=wheelInfo?wheelInfo.detail:'GPIO 接入 FPGA 输入端，网页通过串口查看结果。';
  $('result-value').textContent = fmt(latest?.result);
  $('status-value').textContent = wheelInfo?wheelInfo.label:latest?.status === undefined ? '—' : latest.status === 0 ? '正常' : fmt(latest.status);
  $('frame-count').textContent = total.toLocaleString('zh-CN'); $('invalid-count').textContent = `异常报文 ${invalid}`;
  $('device-status').textContent = lastDeviceEvent?`状态：${lastDeviceEvent.label}`:wheel?`学习 ${wheel.base}/12 · 标志 ${wheel.flags}`:latest?.status === undefined ? '状态：未提供' : latest.status === 0 ? '状态：正常' : `状态码：${latest.status}`;
  const rangeFrames = records.slice(-Number($('window').value));
  for (const field of ['result']) {
    const values = rangeFrames.map(frame => frame[field]);
    $(field + '-range').textContent = values.length ? `范围 ${fmt(Math.min(...values))} – ${fmt(Math.max(...values))}` : '等待第一组数据';
  }
  const now = Date.now(); recent = recent.filter(stamp => stamp > now - 5000);
  const live = mode === 'serial' || mode === 'demo';
  const interval = started === null ? 5 : Math.min(5, Math.max(.5, (now - started) / 1000));
  $('rate-value').textContent = (live ? recent.length / interval : 0).toFixed(1);
  $('chart-state').textContent = paused ? '显示已暂停 · 接收继续' : mode === 'demo' ? '模拟数据' : mode === 'serial' ? '实时接收' : latest ? '采集已停止' : '等待数据';
  $('packet-seq').textContent = latest?.seq === undefined ? '—' : String(latest.seq);
  $('packet-result').textContent = fmt(latest?.result);
  $('packet-status').textContent = latest?.status === undefined ? '未提供' : String(latest.status);
  $('packet-time').textContent = latest ? time(latest.received_ms) : '—';
  $('latest-packet').textContent = wheel ? `窗口：${wheel.win}\n状态：${wheelInfo.label}\n峰值：${fmt(wheel.peak_mg)} mg\n已学习：${wheel.base}/12 窗\n溢出事件：${fmt(wheel.overrun)}\n参考转速：${fmt(wheel.rpm_ref)} rpm（配置值）` : latest ? JSON.stringify({ ...(latest.seq === undefined ? {} : { seq: latest.seq }), result: latest.result, ...(latest.status === undefined ? {} : { status: latest.status }) }, null, 2) : '等待 FPGA 通过 UART 发送结果…';
  recordActions();
  $('record-note').textContent = total > MAX_RECORDS ? `已接收 ${total.toLocaleString()} 帧 · 保留最近 10,000 帧` : '最多保留最近 10,000 帧';
  const body = $('records-body'); body.replaceChildren();
  if (!records.length) {
    const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.className = 'empty-cell'; cell.textContent = '采集开始后，最新数据将显示在这里。'; row.append(cell); body.append(row);
  } else for (const frame of records.slice(-6).reverse()) {
    const row = document.createElement('tr');
    for (const value of [frame.seq === undefined ? '—' : String(frame.seq).padStart(4, '0'), time(frame.received_ms), fmt(frame.result)]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    const statusCell = document.createElement('td'), status = document.createElement('span');
    status.className = 'status-pill' + (frame.status === undefined ? ' unknown' : frame.status ? ' warning' : '');
    status.textContent = frame.wheel?wheelStatus(frame.wheel).label:frame.status === undefined ? '未提供' : frame.status === 0 ? '正常' : `状态 ${frame.status}`; statusCell.append(status); row.append(statusCell);
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
$('clear').addEventListener('click', () => {
  if (busy || importBusy || !confirmReplace('清空记录')) return;
  resetRecords(); controls();
  notice(mode === 'demo' ? '演示记录已清空，模拟数据仍在生成。' : '记录已清空。采集会话保持当前状态。', mode === 'demo' ? 'demo' : '');
});
function download(content, type, extension) {
  const sources = new Set(records.map(record => record.source));
  const source = sources.size === 1 ? records[0].source : 'mixed';
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `cpu-lab-${source}-${new Date().toISOString().replaceAll(':', '-')}.${extension}`; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export').addEventListener('click', () => {
  if (!records.length) return;
  download(csv(records), 'text/csv;charset=utf-8', 'csv');
});
$('backup-export').addEventListener('click', () => {
  if (!records.length && !logs.length) return;
  download(createBackup(snapshot()), 'application/json;charset=utf-8', 'json');
});
$('backup-import').addEventListener('click', () => {
  if (mode !== 'idle' || busy || importBusy) return;
  $('backup-file').click();
});
$('backup-file').addEventListener('change', async () => {
  const file = $('backup-file').files?.[0];
  if (!file || mode !== 'idle' || busy || importBusy) { $('backup-file').value = ''; return; }
  importBusy = true; controls();
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new BackupError('备份文件过大，最多支持 8 MB');
    const session = parseBackup(await file.text());
    if (!confirmReplace('导入备份')) return;
    restoreSession(session); savePending = true; saveRecords(true); render();
    notice(`已导入 ${records.length.toLocaleString('zh-CN')} 帧记录。可以查看、导出，或开始新的采集。`);
  } catch (error) { notice(`导入失败：${error.message}。当前记录未改变。`, 'error'); }
  finally { importBusy = false; $('backup-file').value = ''; controls(); }
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
window.addEventListener('pagehide', () => saveRecords(true));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveRecords(true); });
window.addEventListener('beforeunload', () => { saveRecords(true); stopDemo(); if (mode === 'serial') void serialSession?.disconnect(); });
setInterval(() => {
  saveRecords();
  if ((mode === 'demo' || mode === 'serial') && started !== null) {
    const seconds = Math.floor((Date.now() - started) / 1000);
    $('session-time').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  if (!paused && (dirty || Date.now() - lastRender >= 1000)) render();
}, 250);
try {
  const session = store.load();
  if (session) {
    restoreSession(session);
    storageStatus('记录已自动保存在此浏览器', false, session.saved_at);
    if (hasStarted) notice(`已从此浏览器恢复 ${records.length.toLocaleString('zh-CN')} 帧记录。串口需要重新连接；开始新采集前可先导出备份。`);
  }
} catch (error) {
  unreadableSaved = error instanceof BackupError;
  storageStatus(unreadableSaved ? '浏览器中的旧备份无法读取，开始新采集或导入前会请你确认。' : '浏览器存储不可用，请使用导出备份保存数据。', true);
}
controls(); render();
mountDecoder();
if (!hasStarted && (!window.isSecureContext || !('serial' in navigator))) notice('当前浏览器环境未提供串口接口。你可以先点击「模拟演示」；连接设备时请用支持 Web Serial 的桌面浏览器打开 HTTPS 或 localhost 页面。');
