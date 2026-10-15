import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, StorageConflictError, BackupError, STORAGE_KEY, createBackup, parseBackup } from '../dist/storage.mjs';
import { MAX_RECORDS } from '../dist/protocol.mjs';

const received_at = '2026-10-15T14:00:00.000Z', received_ms = Date.parse(received_at);
const state = () => ({ records: [{ result: 85, source: 'serial', received_at, received_ms }], logs: ['14:00:00  {"result":85}'], total: 18, invalid: 2, started: received_ms - 1000 });

test('backup round trip retains original sources, missing fields, statistics and logs', () => {
  const input = state();
  input.records.push({ result: -3.25, seq: 0, status: 0, source: 'demo', received_at, received_ms });
  const result = parseBackup(createBackup(input, received_at));
  assert.deepEqual(result, { ...input, saved_at: received_at });
  assert.equal(Object.hasOwn(result.records[0], 'status'), false);
  assert.equal(Object.hasOwn(result.records[0], 'seq'), false);
});

test('invalid backups are rejected in full, including invalid values, timestamps and limits', () => {
  const valid = JSON.parse(createBackup(state()));
  const cases = [null, [], {}, { ...valid, version: 2 }, { ...valid, total: 0 }, { ...valid, invalid: -1 },
    { ...valid, started: 'yesterday' }, { ...valid, saved_at: 'bad date' },
    { ...valid, records: Array(MAX_RECORDS + 1).fill(valid.records[0]) },
    { ...valid, logs: Array(121).fill('log') }, { ...valid, logs: ['x'.repeat(8301)] }];
  for (const change of [{ source: 'unknown' }, { result: '85' }, { result: null }, { seq: -1 }, { status: .5 }, { received_at: 'invalid' }, { received_ms: received_ms + 1 }]) {
    cases.push({ ...valid, records: [{ ...valid.records[0], ...change }] });
  }
  assert.throws(() => parseBackup('{broken'), BackupError);
  for (const value of cases) assert.throws(() => parseBackup(JSON.stringify(value)), BackupError);
});

test('a new page restores the saved session, and a saved clear stays empty on reload', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const page = new SessionStore(() => storage);
  assert.equal(page.load(), null);
  page.save(state());
  const reloaded = new SessionStore(() => storage);
  assert.deepEqual(reloaded.load().records, state().records);
  reloaded.save({ records: [], logs: [], total: 0, invalid: 0, started: null });
  assert.deepEqual(new SessionStore(() => storage).load().records, []);
});

test('quota errors preserve the previous backup, and another tab cannot silently overwrite it', () => {
  let saved = createBackup(state());
  const storage = { getItem: () => saved, setItem() { throw new DOMException('full', 'QuotaExceededError'); } };
  const page = new SessionStore(() => storage);
  page.load();
  const original = saved;
  assert.throws(() => page.save(state()), { name: 'QuotaExceededError' });
  assert.equal(saved, original);
  saved = createBackup({ ...state(), total: 19 });
  assert.throws(() => page.save(state()), StorageConflictError);
  assert.equal(JSON.parse(saved).total, 19);
  assert.throws(() => new SessionStore(() => { throw new DOMException('blocked', 'SecurityError'); }).load(), { name: 'SecurityError' });
});

test('full capacity backups can be restored without losing retained records', () => {
  const input = state(); input.records = Array.from({ length: MAX_RECORDS }, (_, seq) => ({ ...input.records[0], seq })); input.total = MAX_RECORDS + 20;
  const output = parseBackup(createBackup(input));
  assert.equal(output.records.length, MAX_RECORDS);
  assert.equal(output.records.at(-1).seq, MAX_RECORDS - 1);
  assert.equal(output.total, MAX_RECORDS + 20);
});
