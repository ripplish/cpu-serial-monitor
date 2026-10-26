// Pure browser/Node helpers. No device access, network requests or persistence.
export const MAX_LOG_CHARS = 2 * 1024 * 1024;
export const WHEEL_NUMBERS = ['win','fs','n','rpm_ref','rms_mg','peak_mg','crest_x1000','kurt_x1000','peak_mHz','f1_permille','h23_permille','base','flags','overrun','max_read_us','analysis_us'];
const REQUIRED = ['win','rms_mg','peak_mg','base','flags'];
const STATES = new Set(['UNLEARNED','LEARNING','BASELINE_READY','NO_THRESHOLD_EXCEEDED','SUSPECT']);
export function validateWheel(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('轮轴数据必须是对象');
  const out = {};
  for (const key of WHEEL_NUMBERS) {
    const value = data[key];
    if (value === undefined) { if (REQUIRED.includes(key)) throw new Error(`窗口缺少 ${key}，可能截断`); continue; }
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`${key} 不是有效的非负整数`);
    out[key] = value;
  }
  if (!STATES.has(data.status)) throw new Error('窗口状态缺失或无法识别，可能截断');
  if ((out.fs !== undefined && !out.fs) || (out.n !== undefined && !out.n)) throw new Error('采样率和窗口点数必须大于0');
  if (out.f1_permille > 1000 || out.h23_permille > 1000) throw new Error('频带占比超过100%');
  out.status = data.status;
  return out;
}
export function parseWheelLine(line) {
  if (!/^win=/.test(line.trim())) return null;
  try {
    const fields = {};
    for (const token of line.trim().split(/\s+/)) {
      const match = /^([a-zA-Z][\w]*)=(\S+)$/.exec(token);
      if (!match) throw new Error('窗口包含不完整字段');
      const [, key, value] = match;
      if (Object.hasOwn(fields, key)) throw new Error(`重复字段 ${key}`);
      fields[key] = WHEEL_NUMBERS.includes(key) ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
    }
    return { kind: 'wheel', data: validateWheel(fields), raw: line };
  } catch (error) { return { kind: 'invalid', reason: error.message, raw: line }; }
}
export function alarmLabels(flags) {
  const labels = [];
  for (const [bit, label] of [[1,'振动增强'],[2,'疑似不平衡 / 偏心'],[4,'疑似松动'],[8,'疑似冲击 / 轴承异常']]) if (flags & bit) labels.push(label);
  const unknown = (flags >>> 0) & 0xfffffff0;
  if (unknown) labels.push(`未知标志 0x${(unknown >>> 0).toString(16).toUpperCase()}`);
  return labels;
}
export function wheelStatus(data) {
  const alarms = alarmLabels(data.flags);
  if (data.status === 'UNLEARNED') return { label:'尚未学习', tone:'neutral', detail:'先确认正常运转、转速和负载稳定，再发送文本 C（十六进制 43）学习基准。未学习时 flags=0 不表示设备健康。' };
  if (data.status === 'LEARNING') return { label:`学习中 · ${data.base}/12 窗`, tone:'learning', detail:'保持正常工况和安装状态稳定。base 是学习数量，win 是总窗口编号；再次发送 C 会重新学习。' };
  if (data.base < 12) return { label:'基准状态不一致', tone:'warning', detail:'报文声称学习完成，但 base 小于12。请核对固件配置和报文，不能据此认定监测有效。' };
  if (data.status === 'SUSPECT' || data.flags) return { label: alarms.length ? alarms.join('、') : '报警状态待核对', tone:'warning', detail: alarms.length ? '这是固件给出的疑似异常标志，需要结合安装、转速、负载与实测情况分析。' : 'status=SUSPECT 但 flags=0，报文字段不一致。' };
  if (data.status === 'BASELINE_READY') return { label:'基准学习完成', tone:'ready', detail:'12个正常基准窗口已建立。后续按同转速、同负载进行相对比较，改变安装或工况后需要重新学习。' };
  return { label:'未超过当前门限', tone:'ready', detail:'相对于学习基准尚未触发固件判据，不代表机械设备无故障。rpm_ref 是设定参考转速，主峰频率也不是实测转速。' };
}
const REASONS = { 1:'I²C 通信失败', 2:'FIFO 溢出 / 丢样', 3:'软件双缓冲积压', 4:'长时间没有新数据', 5:'传感器量程饱和' };
export function parseEvent(line) {
  let match;
  if ((match = /^INVALID\s+reason=(\d+)\b/.exec(line))) return { kind:'event', tone:'error', label:REASONS[Number(match[1])] || `未知采集错误 ${match[1]}`, detail:'本窗口无效，固件会丢弃数据并清除正常基准。请等待采集恢复后重新学习。', raw:line };
  if (/^ERROR INIT\b/.test(line)) return { kind:'event', tone:'error', label:'传感器初始化失败', detail:'可能是设备ID读取或配置读回失败，尚未进入采集。此时发送 C 不能开始基准学习。', raw:line };
  if (/^CALIBRATION START\b/.test(line)) return { kind:'event', tone:'learning', label:'已开始学习基准', detail:'命令 C 已被接收。等待12个有效窗口，标称约30.72秒；保持正常且稳定的运转工况。', raw:line };
  if (/^BASELINE CLEARED\b/.test(line)) return { kind:'event', tone:'neutral', label:'正常基准已清除', detail:'当前尚无正常基准。确认正常、稳定运转后发送 C 重新学习。', raw:line };
  if (/^INIT OK\b/.test(line)) return { kind:'event', tone:'neutral', label:'传感器初始化成功', detail:'等待后续窗口确认采集和学习状态。初始化成功本身不表示基准已建立。', raw:line };
  return null;
}

export function decodeUartLog(input, mode='auto', encoding='utf-8') {
  if (typeof input !== 'string' || input.length > MAX_LOG_CHARS) throw new Error('日志最多支持2 MiB字符，请分段导入');
  if (!['auto','hex','text'].includes(mode)) throw new Error('未知输入格式');
  if (!['utf-8','gb18030'].includes(encoding)) throw new Error('不支持的文本编码');
  const warnings = [], parts = [], bytes = [];
  const damagedMarker = '\uFFF9';
  let byteCount=0, hexLines=0, skippedTx=0, controls=0;
  const warn = value => { if (warnings.length < 20) warnings.push(value); };
  const flush = () => {
    if (!bytes.length) return;
    const text = new TextDecoder(encoding).decode(Uint8Array.from(bytes));
    if (text.includes('\uFFFD')) warn('存在不能按所选编码解码的字节，可尝试切换 UTF-8 / GB18030。');
    parts.push(text); bytes.length=0;
  };
  const physicalLines = input.replaceAll('\r\n','\n').split('\n');
  for (let i=0; i<physicalLines.length; i++) {
    let line = physicalLines[i].replace(/^\s*\[?\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\]?\s*/, '');
    const direction = /^\s*(收\s*[←⇐]|发\s*[→⇒])\s*[◆◇]?/.exec(line);
    if (direction?.[1].startsWith('发')) { skippedTx++; continue; }
    if (direction) line=line.slice(direction[0].length);
    line=line.replace(/^\s*[◆◇]\s*/, '').replace(/\s*[□◇◆]+\s*$/, '');
    const clean=line.trim();
    if (!clean) { if (mode==='text' && i<physicalLines.length-1) { flush(); parts.push('\n'); } continue; }
    const tokens=clean.split(/[\s,;]+/);
    const hexLike=tokens.every(token => /^(?:0x)?[\da-f]+$/i.test(token));
    if (mode!=='text' && hexLike) {
      let valid=0;
      for (let token of tokens) {
        token=token.replace(/^0x/i,'');
        if (token.length%2) {
          flush(); parts.push(damagedMarker);
          warn(`第${i+1}行有不完整的十六进制片段，受影响的整条接收报文不会计为有效数据。`);
          continue;
        }
        for (let n=0;n<token.length;n+=2) { bytes.push(parseInt(token.slice(n,n+2),16)); valid++; }
      }
      byteCount+=valid; if(valid) hexLines++;
    } else if (mode==='hex') {
      throw new Error(`第${i+1}行包含非十六进制内容，请选择「自动识别」或检查输入。`);
    } else {
      flush(); parts.push(line + (i<physicalLines.length-1 ? '\n' : ''));
    }
  }
  flush();
  const rawText=parts.join('');
  let text=rawText.replaceAll(damagedMarker,'[损坏HEX]');
  text=text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, char => { controls++; return `\\x${char.charCodeAt(0).toString(16).padStart(2,'0')}`; });
  if (controls) warn(`发现${controls}个不可见控制字节，已显示为 \\xNN，未将其当成正常文本。`);
  if (skippedTx) warn(`已排除${skippedTx}条发送记录，只分析 CPU 接收日志。`);
  if (input.trim() && !text) warn('没有可解码的接收数据。');
  const windows=[], events=[], errors=[], entries=[];
  const rawLines=rawText.split(/\r?\n/);
  for (const [index,line] of rawLines.entries()) {
    if (line.includes(damagedMarker) || line.includes('\uFFFD') || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) {
      errors.push({line:index+1,reason:'接收报文包含损坏或无法解码的字节，整行无效'});
      continue;
    }
    if(index===rawLines.length-1 && line.trim()) {
      if(parseWheelLine(line) || parseEvent(line.trim())) errors.push({line:index+1,reason:'最后一条报文未以换行结束，未计入有效数据'});
      continue;
    }
    const wheel=parseWheelLine(line);
    if (wheel?.kind==='wheel') { windows.push(wheel.data); entries.push(wheel); }
    else if (wheel?.kind==='invalid') errors.push({ line:index+1, reason:wheel.reason });
    else { const event=parseEvent(line.trim()); if(event) { events.push(event); entries.push(event); } }
  }
  if (errors.length) warn(`有${errors.length}条报文损坏、不完整或不合法，未计入有效窗口或状态事件。`);
  const tail=text.split(/\r?\n/).at(-1);
  if (tail && !/\r?\n$/.test(text)) warn('最后一行没有换行结束标记，可能是截断片段；请结合原始日志确认。');
  return { text, byteCount, hexLines, skippedTx, warnings, windows, events, errors, entries };
}
export function wheelCsv(windows) {
  const columns=[['win','窗口'],['rms_mg','有效值_mg'],['peak_mg','峰值_mg'],['crest_x1000','波峰因数_x1000'],['kurt_x1000','峭度_x1000'],['peak_mHz','主峰_mHz'],['f1_permille','1X功率_千分比'],['h23_permille','2与3X功率_千分比'],['base','已学习窗口'],['flags','报警标志'],['status','固件状态'],['overrun','FIFO溢出事件'],['max_read_us','最大读取_us'],['analysis_us','分析_us'],['rpm_ref','参考转速_rpm'],['fs','配置采样率_Hz'],['n','窗口点数']];
  const escape = value => `"${String(value ?? '').replaceAll('"','""')}"`;
  return '\uFEFF'+[columns.map(([,title])=>escape(title)).join(','),...windows.map(row=>columns.map(([key])=>escape(row[key])).join(','))].join('\r\n')+'\r\n';
}
