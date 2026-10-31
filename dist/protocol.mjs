import { validateCnn } from "./cnn.mjs?v=20261031.2";
import { parseWheelLine, WHEEL_NUMBERS } from './uart.mjs?v=20261031.2';
export const MAX_LINE = 8192;
export const MAX_RECORDS = 10000;

// Keep missing/reset sequence numbers visible as gaps, including in filled areas.
export function splitSeries(records) {
  const segments=[];
  let previous=null;
  for(const frame of records) {
    const seq=frame.wheel?.win??frame.seq;
    const oldSeq=previous?.wheel?.win??previous?.seq;
    const gap=!previous || frame.source!==previous.source || Boolean(frame.wheel)!==Boolean(previous.wheel) || frame.cnn?.model!==previous.cnn?.model ||
      (seq!==undefined && oldSeq!==undefined && seq!==oldSeq+1);
    if(gap) segments.push([]);
    segments.at(-1).push(frame); previous=frame;
  }
  return segments;
}

export function parseLine(line) {
  const text = line.trim();
  if (!text) return { kind: 'empty' };
  if (text.length > MAX_LINE) return { kind: 'invalid', reason: '报文超过 8192 字符' };
  const wheel = parseWheelLine(text);
  if (wheel?.kind === 'invalid') return wheel;
  if (wheel?.kind === 'wheel') return { kind:'frame', frame:{seq:wheel.data.win,result:wheel.data.rms_mg,status:wheel.data.flags,wheel:wheel.data} };
  if (!text.startsWith('{')) return { kind: 'log', text };
  let data;
  try { data = JSON.parse(text); } catch { return { kind: 'invalid', reason: 'JSON 格式不正确' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'invalid', reason: '报文必须是 JSON 对象' };
  for (const key of ['result']) {
    if (typeof data[key] !== 'number' || !Number.isFinite(data[key])) return { kind: 'invalid', reason: `${key} 必须是有限数值` };
  }
  const frame = { result: data.result };
  for (const key of ['seq', 'status']) {
    if (data[key] === undefined) continue;
    const value = data[key];
    const limit = Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(value) || value < 0 || value > limit) return { kind: 'invalid', reason: `${key} 超出有效整数范围` };
    frame[key] = value;
  }
  if(data.cnn!==undefined) {try {frame.cnn=validateCnn(data.cnn);} catch(error) {return {kind:'invalid',reason:error.message};}}
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

export function csv(records) {
  const hasCnn=records.some(record=>record.cnn);
  const hasWheel=records.some(record=>record.wheel);
  const columns = ['received_at', 'source', 'seq', 'result', 'status', ...(hasWheel?[...WHEEL_NUMBERS,'wheel_status']:[]), ...(hasCnn?['cnn_pred','cnn_score0','cnn_score1','cnn_score2','cnn_model','cnn_trained','cnn_cycles','cnn_rpm_ref']:[])];
  const rows = records.map(record => columns.map(key => {
    const neural=record.cnn;
    const cnnFields=neural?{cnn_pred:neural.pred,cnn_score0:neural.scores[0],cnn_score1:neural.scores[1],cnn_score2:neural.scores[2],cnn_model:neural.model,cnn_trained:neural.trained,cnn_cycles:neural.cycles,cnn_rpm_ref:neural.rpm_ref}:{};
    const value = key.startsWith('cnn_') ? (cnnFields[key]??'') : key==='wheel_status' ? (record.wheel?.status??'') : record[key] ?? record.wheel?.[key] ?? '';
    return `"${String(value).replaceAll('"', '""')}"`;
  }).join(','));
  return '\ufeff' + [columns.join(','), ...rows].join('\r\n') + '\r\n';
}
