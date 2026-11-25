import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postJson } from '../src/drivers/http.js';
import { DriverError } from '../src/types.js';

const servers: http.Server[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  while (servers.length) servers.pop()!.close();
});

/** A server that waits `delayMs` before it sends anything, as a slow model does before a whole answer. */
async function slow(delayMs: number, status = 200, body: unknown = { ok: true }, headers: Record<string, string> = {}) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      }, delayMs);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('a slow answer is governed by omnitrix own time limit', () => {
  // Node's fetch gives up after 300 seconds without response headers, whatever the caller allows. An API
  // request sends nothing until the whole answer is ready, so a slow local model or a long reasoning answer
  // failed at five minutes as a network fault although its task allowed ten.
  it('does not depend on the built-in fetch and its fixed header timeout', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('Headers Timeout Error')));
    const url = await slow(50, 200, { answer: 42 }, { 'x-ratelimit-remaining-requests': '7' });
    const { json, headers } = await postJson(`${url}/v1/chat/completions`, {}, { a: 1 }, 5000);
    expect(json).toEqual({ answer: 42 });
    expect(headers.get('x-ratelimit-remaining-requests')).toBe('7');
  });

  it('waits for an answer that comes within the limit', async () => {
    const url = await slow(600);
    const { json } = await postJson(`${url}/v1/chat/completions`, {}, {}, 3000);
    expect(json).toEqual({ ok: true });
  });

  it('reports a timeout, not a network fault, when the limit passes first', async () => {
    const url = await slow(3000);
    const err = await postJson(`${url}/v1/chat/completions`, {}, {}, 300).catch((e) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.kind).toBe('timeout');
  });

  it('stops at once when the job is cancelled', async () => {
    const url = await slow(3000);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const started = Date.now();
    const err = await postJson(`${url}/v1/chat/completions`, {}, {}, 10_000, ctrl.signal).catch((e) => e);
    expect(err.kind).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still reads provider errors with their status and wait', async () => {
    const url = await slow(10, 429, { error: { message: 'Rate limit reached, tokens per minute' } }, { 'retry-after': '12' });
    const err = await postJson(`${url}/v1/chat/completions`, {}, {}, 5000).catch((e) => e);
    expect(err.kind).toBe('rate_limit');
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(12_000);
  });

  it('stops reading an answer over 32 MB, as a broken or hostile server may send', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        const chunk = 'x'.repeat(1024 * 1024);
        let sent = 0;
        const more = () => {
          while (sent < 40) {
            sent++;
            if (!res.write(chunk)) return void res.once('drain', more);
          }
          res.end();
        };
        more();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const err = await postJson(`${url}/v1/chat/completions`, {}, {}, 10_000).catch((e) => e);
    expect(err.message).toMatch(/too large/);
  });

  it('names a redirect, which it never follows', async () => {
    const url = await slow(0, 307, {}, { location: 'http://127.0.0.1:9/elsewhere' });
    const err = await postJson(`${url}/v1/chat/completions`, {}, {}, 5000).catch((e) => e);
    expect(err.message).toMatch(/redirect/);
  });

  it('reads compressed answers and caps their decoded size', async () => {
    const answer = JSON.stringify({ answer: 'zipped' });
    for (const [name, pack] of [
      ['gzip', zlib.gzipSync],
      ['deflate', zlib.deflateSync],
      ['br', zlib.brotliCompressSync],
    ] as const) {
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': name });
          res.end(pack(Buffer.from(answer)));
        });
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { json } = await postJson(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/x`, {}, {}, 5000);
      expect(json).toEqual({ answer: 'zipped' });
    }
    // 40 MB of zeros packs into about 40 KB; the cap counts what it unpacks to
    const bomb = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024));
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(bomb);
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const err = await postJson(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/x`, {}, {}, 5000).catch((e) => e);
    expect(err.message).toMatch(/too large/);
  });

  it('settles at once when a server switches protocols instead of answering', async () => {
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
      socket.on('error', () => undefined);
    });
    servers.push(server as unknown as http.Server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const started = Date.now();
    const err = await postJson(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/x`, {}, {}, 4000).catch((e) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.kind).not.toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a redirect as soon as it arrives, even when its body never ends', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' });
        res.write('moving');
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const started = Date.now();
    const err = await postJson(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/x`, {}, {}, 4000).catch((e) => e);
    expect(err.message).toMatch(/redirect/);
    expect(Date.now() - started).toBeLessThan(2000);
    server.closeAllConnections();
  });

  it('calls an unreachable server a network fault', async () => {
    const url = await slow(0);
    servers.pop()!.close();
    await new Promise((r) => setTimeout(r, 50));
    const err = await postJson(`${url}/v1/chat/completions`, {}, {}, 5000).catch((e) => e);
    expect(err.kind).toBe('network');
  });
});
