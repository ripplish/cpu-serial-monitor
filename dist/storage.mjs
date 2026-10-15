import { MAX_RECORDS, parseLine } from './protocol.mjs';

export const STORAGE_KEY = 'cpu-lab:serial-monitor:session:v1';
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const FORMAT = 'cpu-lab-session';

export class BackupError extends Error {
  constructor(message) { super(message); this.name = 'BackupError'; }
}
export class StorageConflictError extends Error {
  constructor() { super('另一个标签页已更新保存的记录'); this.name = 'StorageConflictError'; }
}

export function createBackup({ records, logs, total, invalid, started }, savedAt = new Date().toISOString(), space = 2) {
  return JSON.stringify({ format: FORMAT, version: 1, saved_at: savedAt, records, logs, total, invalid, started }, null, space);
}

export function parseBackup(text) {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_BYTES) throw new BackupError('备份文件过大，最多支持 8 MB');
  let data;
  try { data = JSON.parse(text); } catch { throw new BackupError('备份不是有效的 JSON 文件'); }
  const fail = () => { throw new BackupError('备份格式不正确或数据已损坏，请选择本站导出的 JSON 备份'); };
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const stamp = value => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;
  if (!data || data.format !== FORMAT || data.version !== 1 || !Array.isArray(data.records) ||
      data.records.length > MAX_RECORDS || !Array.isArray(data.logs) || data.logs.length > 120 ||
      !count(data.total) || data.total < data.records.length || !count(data.invalid) ||
      !(data.started === null || stamp(data.started)) ||
      typeof data.saved_at !== 'string' || !Number.isFinite(Date.parse(data.saved_at))) fail();
  const records = data.records.map(record => {
    if (!record || typeof record !== 'object' || !['demo', 'serial'].includes(record.source) ||
        typeof record.received_at !== 'string' || !stamp(record.received_ms) ||
        Date.parse(record.received_at) !== record.received_ms) fail();
    const parsed = parseLine(JSON.stringify({ result: record.result, seq: record.seq, status: record.status }));
    if (parsed.kind !== 'frame') fail();
    return { ...parsed.frame, source: record.source, received_ms: record.received_ms, received_at: new Date(record.received_ms).toISOString() };
  });
  if (data.logs.some(line => typeof line !== 'string' || line.length > 8300)) fail();
  return { records, logs: [...data.logs], total: data.total, invalid: data.invalid, started: data.started, saved_at: new Date(data.saved_at).toISOString() };
}

export class SessionStore {
  constructor(getStorage = () => window.localStorage) { this.getStorage = getStorage; this.lastText = null; }
  load() {
    this.lastText = this.getStorage().getItem(STORAGE_KEY);
    return this.lastText === null ? null : parseBackup(this.lastText);
  }
  save(state) {
    const storage = this.getStorage();
    if (storage.getItem(STORAGE_KEY) !== this.lastText) throw new StorageConflictError();
    const savedAt = new Date().toISOString();
    // Keep browser storage compact; downloaded backups are formatted for reading.
    const text = createBackup(state, savedAt, 0);
    storage.setItem(STORAGE_KEY, text);
    this.lastText = text;
    return savedAt;
  }
}
