import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { createProxyFetch, publicProxySettings } from './proxy.mjs';

const TARGET = 'http://synthetic.invalid/proxy-test';

async function localProxy(t, handler) {
  const entry = { id: randomUUID(), hits: 0 };
  const server = http.createServer((req, res) => {
    entry.hits += 1;
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  entry.url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return entry;
}

function proxyFetch(entries, options = {}) {
  return createProxyFetch(() => ({ enabled: true, strategy: 'failover', maxRetries: 2, timeoutMs: 1500, entries, ...options }));
}

async function connectProxy(t, { stall = false } = {}) {
  const sockets = new Set();
  const entry = { id: randomUUID(), connects: [], sockets };
  let disconnected;
  entry.disconnected = new Promise((resolve) => { disconnected = resolve; });
  const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); disconnected(); });
  });
  server.on('connect', (req, socket, head) => {
    entry.connects.push({ target: req.url, auth: req.headers['proxy-authorization'] });
    if (stall) {
      socket.resume();
      socket.once('end', () => socket.end());
      return;
    }
    const target = new URL(`http://${req.url}`);
    // This fixture may only connect to other local fixture servers.
    if (target.hostname !== '127.0.0.1') { socket.destroy(); return; }
    const onward = net.connect({ host: target.hostname, port: Number(target.port) });
    sockets.add(onward);
    onward.once('close', () => sockets.delete(onward));
    onward.once('error', () => socket.destroy());
    socket.once('error', () => onward.destroy());
    socket.once('close', () => onward.destroy());
    onward.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) onward.write(head);
      socket.pipe(onward).pipe(socket);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  entry.url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  return entry;
}

test('public proxy defaults keep the local hop disabled with a loopback URL', () => {
  assert.deepEqual(publicProxySettings(), {
    enabled: false,
    localProxyEnabled: false,
    localProxyUrl: 'http://127.0.0.1:7897',
    strategy: 'failover',
    timeoutMs: 15000,
    maxRetries: 2,
    entries: [],
  });
});

test('routes a request through the local proxy and selected pool proxy in order', async (t) => {
  let received;
  const target = await localProxy(t, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = { method: req.method, path: req.url, body: Buffer.concat(chunks).toString(), proxyAuth: req.headers['proxy-authorization'] };
      res.setHeader('content-type', 'application/json');
      res.end('{"route":"two-proxies"}');
    });
  });
  const upstream = await connectProxy(t);
  const local = await connectProxy(t);
  const upstreamUrl = new URL(upstream.url);
  upstreamUrl.username = 'fixture-user';
  upstreamUrl.password = 'fixture-password';
  upstream.url = upstreamUrl.href;
  const response = await proxyFetch([upstream], {
    localProxyEnabled: true,
    localProxyUrl: local.url,
    maxRetries: 0,
  })(`${target.url}/token?fixture=1`, { method: 'POST', body: 'fixture-payload' });
  assert.deepEqual(await response.json(), { route: 'two-proxies' });
  assert.deepEqual(local.connects, [{ target: upstreamUrl.host, auth: undefined }]);
  assert.deepEqual(upstream.connects, [{
    target: new URL(target.url).host,
    auth: `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`,
  }]);
  assert.deepEqual(received, { method: 'POST', path: '/token?fixture=1', body: 'fixture-payload', proxyAuth: undefined });
  assert.equal(target.hits, 1);
});

test('uses only the local proxy when the pool is disabled', async (t) => {
  const local = await localProxy(t, (req, res) => {
    assert.equal(req.url, TARGET);
    res.end('{"route":"local-only"}');
  });
  const unusedPool = await localProxy(t, (_req, res) => res.end('{"wrong":true}'));
  const response = await proxyFetch([unusedPool], {
    enabled: false,
    localProxyEnabled: true,
    localProxyUrl: local.url,
  })(TARGET);
  assert.deepEqual(await response.json(), { route: 'local-only' });
  assert.equal(local.hits, 1);
  assert.equal(unusedPool.hits, 0);
});

test('rejects an invalid enabled local proxy without contacting the pool or target', async (t) => {
  const target = await localProxy(t, (_req, res) => res.end('unexpected direct request'));
  const upstream = await localProxy(t, (_req, res) => res.end('unexpected pool request'));
  for (const enabled of [false, true]) {
    await assert.rejects(proxyFetch([upstream], {
      enabled,
      localProxyEnabled: true,
      localProxyUrl: 'not-a-proxy-url',
    })(target.url));
  }
  assert.equal(target.hits, 0);
  assert.equal(upstream.hits, 0);
});

test('bounds a stalled local-hop CONNECT and closes its socket without direct fallback', { timeout: 5000 }, async (t) => {
  const target = await localProxy(t, (_req, res) => res.end('unexpected direct request'));
  const upstream = await connectProxy(t);
  const local = await connectProxy(t, { stall: true });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('chain timeout did not settle or close its connection')), 2200);
  });
  t.after(() => clearTimeout(timer));
  await assert.rejects(Promise.race([
    proxyFetch([upstream], {
      localProxyEnabled: true,
      localProxyUrl: local.url,
      timeoutMs: 1000,
      maxRetries: 0,
    })(target.url),
    deadline,
  ]), { name: 'TimeoutError' });
  await Promise.race([local.disconnected, deadline]);
  assert.equal(local.connects.length, 1);
  assert.equal(local.sockets.size, 0);
  assert.equal(upstream.connects.length, 0);
  assert.equal(target.hits, 0);
});

test('rejects on deadline while the HTTPS proxy never answers CONNECT', { timeout: 5000 }, async (t) => {
  const sockets = new Set();
  let connectRequests = 0;
  let socketClosed;
  const disconnected = new Promise((resolve) => { socketClosed = resolve; });
  const server = http.createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); socketClosed(); });
  });
  server.on('connect', (_req, socket) => {
    connectRequests += 1;
    socket.resume();
    socket.once('end', () => socket.end());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  const entry = { id: randomUUID(), url: `http://127.0.0.1:${server.address().port}` };
  let deadline;
  const exceeded = new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error('proxy timeout did not settle the request')), 2000);
  });
  t.after(() => clearTimeout(deadline));
  await assert.rejects(Promise.race([
    proxyFetch([entry], { timeoutMs: 1000, maxRetries: 0 })('https://synthetic.invalid/proxy-test'),
    exceeded,
  ]), { name: 'TimeoutError' });
  assert.equal(connectRequests, 1);
  await Promise.race([disconnected, exceeded]);
  assert.equal(sockets.size, 0);
});

test('times out and closes the proxy when the response body stops arriving', { timeout: 5000 }, async (t) => {
  let socketClosed;
  const disconnected = new Promise((resolve) => { socketClosed = resolve; });
  const entry = await localProxy(t, (req, res) => {
    req.socket.once('close', socketClosed);
    res.writeHead(200, { 'content-length': '100' });
    res.write('partial');
  });
  let deadline;
  const exceeded = new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error('proxy response deadline exceeded')), 2000);
  });
  t.after(() => clearTimeout(deadline));
  await assert.rejects(Promise.race([
    proxyFetch([entry], { timeoutMs: 1000, maxRetries: 0 })(TARGET),
    exceeded,
  ]), { name: 'TimeoutError' });
  await Promise.race([disconnected, exceeded]);
  assert.equal(entry.hits, 1);
});

for (const [encoding, encode] of Object.entries({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync })) {
  for (const [format, contentType, text] of [
    ['JSON', 'application/json', '{"ok":true,"message":"代理响应"}'],
    ['HTML', 'text/html', '<!doctype html><html><body>Login</body></html>'],
  ]) {
    test(`decodes ${encoding} ${format} responses and removes encoded body headers`, async (t) => {
      const body = encode(text);
      const entry = await localProxy(t, (_req, res) => {
        res.writeHead(200, { 'content-type': contentType, 'content-encoding': encoding, 'content-length': body.length, 'x-upstream': 'preserved' });
        res.end(body);
      });
      const response = await proxyFetch([entry])(TARGET, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-encoding'), null);
      assert.equal(response.headers.get('content-length'), null);
      assert.equal(response.headers.get('content-type'), contentType);
      assert.equal(response.headers.get('x-upstream'), 'preserved');
      if (format === 'JSON') assert.deepEqual(await response.json(), JSON.parse(text));
      else assert.equal(await response.text(), text);
    });
  }
}

test('decodes stacked content encodings in reverse order', async (t) => {
  const text = '{"stacked":true}';
  const body = brotliCompressSync(gzipSync(text));
  const entry = await localProxy(t, (_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip, br' });
    res.end(body);
  });
  assert.deepEqual(await (await proxyFetch([entry])(TARGET)).json(), { stacked: true });
});

test('keeps an uncompressed response body and its length intact', async (t) => {
  const text = '{"plain":true}';
  const entry = await localProxy(t, (_req, res) => {
    res.writeHead(200, { 'content-length': Buffer.byteLength(text), 'content-type': 'application/json' });
    res.end(text);
  });
  const response = await proxyFetch([entry])(TARGET);
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(text)));
  assert.deepEqual(await response.json(), { plain: true });
});

test('does not decompress bodyless responses carrying representation metadata', async (t) => {
  const entry = await localProxy(t, (req, res) => {
    res.writeHead(req.method === 'HEAD' ? 200 : 204, { 'content-encoding': 'gzip' });
    res.end();
  });
  for (const method of ['HEAD', 'GET']) {
    const response = await proxyFetch([entry])(TARGET, { method });
    assert.equal(response.status, method === 'HEAD' ? 200 : 204);
    assert.equal(response.body, null);
    assert.equal(await response.text(), '');
  }
});

test('rejects corrupt compressed bytes with the decoder error instead of returning garbled text', async (t) => {
  const entry = await localProxy(t, (_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end('not compressed');
  });
  await assert.rejects(proxyFetch([entry])(TARGET), (error) => {
    assert.equal(error.code, 'Z_DATA_ERROR');
    assert.equal(error.cause.code, 'Z_DATA_ERROR');
    assert.equal(error.message, 'proxy response gzip decompression failed');
    return true;
  });
  assert.equal(entry.hits, 1);
});

for (const encoding of ['unsupported-codec', 'constructor']) {
  test(`rejects unsupported content encoding ${encoding} safely`, async (t) => {
    const entry = await localProxy(t, (_req, res) => {
      res.writeHead(200, { 'content-encoding': encoding });
      res.end('encoded bytes');
    });
    await assert.rejects(proxyFetch([entry])(TARGET), { code: 'PROXY_UNSUPPORTED_CONTENT_ENCODING', message: 'unsupported proxy response content encoding' });
  });
}

test('returns the only proxy HTTP 503 after the available nodes are exhausted', async (t) => {
  const entry = await localProxy(t, (_req, res) => {
    res.writeHead(503, { 'retry-after': '10' });
    res.end('upstream unavailable');
  });
  const response = await proxyFetch([entry])(TARGET);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '10');
  assert.equal(await response.text(), 'upstream unavailable');
  assert.equal(entry.hits, 1);
});

test('preserves the last HTTP response after multiple failed proxies', async (t) => {
  const first = await localProxy(t, (_req, res) => { res.writeHead(502); res.end('first failure'); });
  const second = await localProxy(t, (_req, res) => { res.writeHead(503); res.end('last failure'); });
  const response = await proxyFetch([first, second], { maxRetries: 5 })(TARGET);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'last failure');
  assert.equal(first.hits, 1);
  assert.equal(second.hits, 1);
});

test('preserves the original connection error when the only proxy fails', async (t) => {
  const entry = await localProxy(t, (req) => req.socket.destroy());
  await assert.rejects(proxyFetch([entry])(TARGET), { code: 'ECONNRESET' });
  assert.equal(entry.hits, 1);
});

test('rejects a response that disconnects before its declared body completes', async (t) => {
  const entry = await localProxy(t, (_req, res) => {
    res.writeHead(200, { 'content-length': '50' });
    res.write('incomplete');
    setImmediate(() => res.destroy());
  });
  await assert.rejects(proxyFetch([entry])(TARGET), { code: 'ECONNRESET' });
  assert.equal(entry.hits, 1);
});

test('preserves the last connection error after an earlier HTTP failure', async (t) => {
  const first = await localProxy(t, (_req, res) => { res.writeHead(503); res.end('first failure'); });
  const second = await localProxy(t, (req) => req.socket.destroy());
  await assert.rejects(proxyFetch([first, second], { maxRetries: 5 })(TARGET), { code: 'ECONNRESET' });
  assert.equal(first.hits, 1);
  assert.equal(second.hits, 1);
});

test('returns the last HTTP response after an earlier connection failure', async (t) => {
  const first = await localProxy(t, (req) => req.socket.destroy());
  const second = await localProxy(t, (_req, res) => { res.writeHead(503); res.end('last failure'); });
  const response = await proxyFetch([first, second], { maxRetries: 5 })(TARGET);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'last failure');
});

test('falls back from a failed node to a working proxy', async (t) => {
  const first = await localProxy(t, (req) => req.socket.destroy());
  const second = await localProxy(t, (_req, res) => res.end('{"recovered":true}'));
  const response = await proxyFetch([first, second])(TARGET);
  assert.deepEqual(await response.json(), { recovered: true });
  assert.equal(first.hits, 1);
  assert.equal(second.hits, 1);
});

test('does not add retries for a nonretryable POST HTTP 403', async (t) => {
  const first = await localProxy(t, (_req, res) => { res.writeHead(403); res.end('forbidden'); });
  const second = await localProxy(t, (_req, res) => res.end('{}'));
  const response = await proxyFetch([first, second])(TARGET, { method: 'POST', body: '{"test":true}' });
  assert.equal(response.status, 403);
  assert.equal(first.hits, 1);
  assert.equal(second.hits, 0);
});
