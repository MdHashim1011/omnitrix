import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { files } from '../src/store.js';
import { compactLedger, LedgerTail, readLedger, recordUsage } from '../src/usage.js';
import type { UsageRecord } from '../src/types.js';
import { tempHome } from './helpers.js';

const DAY = 24 * 3600_000;
const rec = (ts: number, accountId = 'a'): UsageRecord => ({ ts, accountId, model: 'm', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: 1 });

beforeEach(() => tempHome());
afterEach(() => vi.restoreAllMocks());

describe('LedgerTail', () => {
  it('reads only what was appended and matches a full read', () => {
    const now = Date.now();
    const tail = new LedgerTail();
    recordUsage(rec(now - 1000, 'a'));
    expect(tail.read(0).map((r) => r.accountId)).toEqual(['a']);
    recordUsage(rec(now, 'b'));
    expect(tail.read(0).map((r) => r.accountId)).toEqual(['a', 'b']);
    expect(tail.read(0)).toEqual(readLedger(0));
  });

  it('waits for a half-written line to be finished', () => {
    const tail = new LedgerTail();
    const line = JSON.stringify(rec(Date.now(), 'late'));
    fs.appendFileSync(files.ledger(), line.slice(0, 20));
    expect(tail.read(0)).toEqual([]);
    fs.appendFileSync(files.ledger(), line.slice(20) + '\n');
    expect(tail.read(0).map((r) => r.accountId)).toEqual(['late']);
  });

  it('reads everything again after the ledger was compacted', () => {
    const now = Date.now();
    const tail = new LedgerTail();
    recordUsage(rec(now - 40 * DAY, 'old'));
    recordUsage(rec(now - DAY, 'recent'));
    expect(tail.read(0)).toHaveLength(2);
    compactLedger(1);
    expect(tail.read(0).map((r) => r.accountId)).toEqual(['recent']);
  });

  it('counts the lines of a compaction in progress', () => {
    const now = Date.now();
    const tail = new LedgerTail();
    recordUsage(rec(now, 'new'));
    tail.read(0);
    fs.writeFileSync(`${files.ledger()}.compacting.${process.pid + 1}`, JSON.stringify(rec(now - DAY, 'moving')) + '\n');
    expect(tail.read(0).map((r) => r.accountId).sort()).toEqual(['moving', 'new']);
  });

  it('leaves out records older than the window', () => {
    const now = Date.now();
    const tail = new LedgerTail();
    recordUsage(rec(now - 40 * DAY, 'old'));
    recordUsage(rec(now, 'new'));
    // the first read keeps everything; the second must still leave the old one out
    expect(tail.read(0)).toHaveLength(2);
    expect(tail.read(now - 32 * DAY).map((r) => r.accountId)).toEqual(['new']);
  });
});

describe('compactLedger', () => {
  it('drops records older than 35 days and keeps the rest', () => {
    const now = Date.now();
    recordUsage(rec(now - 40 * DAY, 'old'));
    recordUsage(rec(now - DAY, 'recent'));
    compactLedger(1);
    expect(readLedger().map((r) => r.accountId)).toEqual(['recent']);
    expect(fs.readdirSync(process.env.OMNITRIX_HOME!).filter((n) => n.includes('compacting'))).toEqual([]);
  });

  it('keeps a line another process appends while compaction runs', () => {
    const now = Date.now();
    recordUsage(rec(now - 40 * DAY, 'old'));
    recordUsage(rec(now - DAY, 'recent'));
    const real = fs.readFileSync;
    let appended = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, opts?: unknown) => {
      const out = real(file, opts as never);
      // the moment compaction has read the old lines, another omnitrix process logs a request
      if (!appended && String(file).includes('usage.jsonl')) {
        appended = true;
        fs.appendFileSync(files.ledger(), JSON.stringify(rec(now, 'other-process')) + '\n');
      }
      return out;
    }) as typeof fs.readFileSync);
    compactLedger(1);
    vi.restoreAllMocks();
    expect(readLedger().map((r) => r.accountId).sort()).toEqual(['other-process', 'recent']);
  });

  it('finishes a compaction left behind by a process that crashed', () => {
    const now = Date.now();
    fs.writeFileSync(`${files.ledger()}.compacting.2000000000`, [rec(now - 40 * DAY, 'old'), rec(now - DAY, 'stranded')].map((r) => JSON.stringify(r)).join('\n') + '\n');
    recordUsage(rec(now, 'new'));
    compactLedger();
    expect(readLedger().map((r) => r.accountId).sort()).toEqual(['new', 'stranded']);
    expect(fs.existsSync(`${files.ledger()}.compacting.2000000000`)).toBe(false);
  });

  it('still counts old lines while another process is compacting them', () => {
    const now = Date.now();
    fs.writeFileSync(`${files.ledger()}.compacting.${process.pid + 1}`, JSON.stringify(rec(now - DAY, 'being-compacted')) + '\n');
    recordUsage(rec(now, 'new'));
    expect(readLedger().map((r) => r.accountId).sort()).toEqual(['being-compacted', 'new']);
  });

  it('finishes a leftover file named for its own pid instead of overwriting it', () => {
    const now = Date.now();
    fs.writeFileSync(`${files.ledger()}.compacting.${process.pid}`, JSON.stringify(rec(now - DAY, 'leftover')) + '\n');
    recordUsage(rec(now, 'new'));
    compactLedger(1);
    expect(readLedger().map((r) => r.accountId).sort()).toEqual(['leftover', 'new']);
  });

  it('does not let a half-written last line swallow the kept records', () => {
    const now = Date.now();
    fs.writeFileSync(`${files.ledger()}.compacting.2000000000`, JSON.stringify(rec(now - DAY, 'kept')) + '\n');
    fs.writeFileSync(files.ledger(), '{"ts": 1, "acc');
    compactLedger();
    expect(readLedger().map((r) => r.accountId)).toEqual(['kept']);
  });

  it('leaves a small ledger alone', () => {
    recordUsage(rec(Date.now() - 40 * DAY, 'old'));
    compactLedger();
    expect(readLedger()).toHaveLength(1);
  });
});
