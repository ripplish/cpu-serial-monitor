export const MAX_LINE = 8192;
export const MAX_RECORDS = 10000;

export function parseLine(line) {
  const text = line.trim();
  if (!text) return { kind: 'empty' };
  if (text.length > MAX_LINE) return { kind: 'invalid', reason: '报文超过 8192 字符' };
  if (!text.startsWith('{')) return { kind: 'log', text };
  let data;
  try { data = JSON.parse(text); } catch { return { kind: 'invalid', reason: 'JSON 格式不正确' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'invalid', reason: '报文必须是 JSON 对象' };
  for (const key of ['input', 'result']) {
    if (typeof data[key] !== 'number' || !Number.isFinite(data[key])) return { kind: 'invalid', reason: `${key} 必须是有限数值` };
  }
  const frame = { input: data.input, result: data.result };
  for (const key of ['seq', 'status', 'gpio_in', 'gpio_out', 'gpio_dir']) {
    if (data[key] === undefined) continue;
    const value = data[key];
    const limit = key.startsWith('gpio_') ? 0xffffffff : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(value) || value < 0 || value > limit) return { kind: 'invalid', reason: `${key} 超出有效整数范围` };
    frame[key] = value;
  }
  return { kind: 'frame', frame };
}

// A chunk can contain part of a line, many lines, or part of a UTF-8 character.
export class LineFramer {
  constructor(onLine, onOverflow) { this.onLine = onLine; this.onOverflow = onOverflow; this.buffer = ''; this.dropping = false; }
  push(chunk) {
    for (const part of chunk.split(/(?<=\n)/)) {
      const terminated = part.endsWith('\n');
      if (!this.dropping) {
        this.buffer += part;
        if (this.buffer.replace(/\r?\n$/, '').length > MAX_LINE) {
          this.buffer = ''; this.dropping = true; this.onOverflow();
        }
      }
      if (terminated) {
        if (!this.dropping) this.onLine(this.buffer.replace(/\r?\n$/, ''));
        this.buffer = ''; this.dropping = false;
      }
    }
  }
  reset() { this.buffer = ''; this.dropping = false; }
}

export function gpioPin(frame, pin) {
  const mask = 2 ** pin;
  const direction = frame?.gpio_dir;
  const isOutput = direction === undefined ? undefined : (direction & mask) !== 0;
  const bits = isOutput === true ? frame?.gpio_out : frame?.gpio_in;
  return { direction: isOutput === undefined ? '—' : isOutput ? 'OUT' : 'IN', level: bits === undefined ? undefined : (bits & mask) !== 0 ? 1 : 0 };
}

export function csv(records) {
  const columns = ['received_at', 'source', 'seq', 'input', 'result', 'status', 'gpio_in', 'gpio_out', 'gpio_dir'];
  const rows = records.map(record => columns.map(key => {
    const value = record[key] ?? '';
    return `"${String(value).replaceAll('"', '""')}"`;
  }).join(','));
  return '\ufeff' + [columns.join(','), ...rows].join('\r\n') + '\r\n';
}
