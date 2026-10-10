import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createProxyChainRelay, validateLocalProxyUrl } from './proxy-chain.mjs';

const BASIC = (value) => `Basic ${Buffer.from(value).toString('base64')}`;

async function managed(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('end', () => socket.end());
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  return { server, sockets, port: server.address().port };
}

function connectRemote(client, host, port, head = Buffer.alloc(0), ready = () => {}) {
  const remote = net.connect({ host: host === 'localhost' || host.endsWith('.invalid') ? '127.0.0.1' : host, port }, () => {
    ready();
    if (head.length) remote.write(head);
    client.pipe(remote);
    remote.pipe(client);
    client.resume();
  });
  remote.on('error', () => client.destroy());
  remote.on('close', () => client.destroy());
  client.once('close', () => remote.destroy());
}

async function httpProxy(t, options = {}) {
  const connects = [];
  const handler = (_req, res) => { res.writeHead(400); res.end(); };
  const fixture = await managed(t, options.tls ? https.createServer(options.tls, handler) : http.createServer(handler));
  fixture.server.on('connect', (req, socket, head) => {
    connects.push({ destination: req.url, authorization: req.headers['proxy-authorization'] });
    if (options.stall) { socket.resume(); return; }
    if (options.reject || (options.auth && req.headers['proxy-authorization'] !== BASIC(options.auth))) {
      socket.end(`HTTP/1.1 ${options.reject || 407} Rejected\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const target = new URL(`http://${req.url}`);
    connectRemote(socket, target.hostname.replace(/^\[|\]$/g, ''), Number(target.port || 80), head, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
  });
  return { ...fixture, connects, url: `${options.tls ? 'https' : 'http'}://${options.auth ? `${options.auth}@` : ''}127.0.0.1:${fixture.port}` };
}

async function socksProxy(t, options = {}) {
  const connects = [];
  const authentications = [];
  const server = net.createServer((socket) => {
    let stage = 'hello';
    let pending = Buffer.alloc(0);
    const data = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (true) {
        if (stage === 'hello') {
          if (pending.length < 2 || pending.length < 2 + pending[1]) return;
          assert.equal(pending[0], 5);
          pending = pending.subarray(2 + pending[1]);
          socket.write(Buffer.from([5, options.auth ? 2 : 0]));
          stage = options.auth ? 'auth' : 'connect';
        } else if (stage === 'auth') {
          if (pending.length < 2) return;
          const userLen = pending[1];
          if (pending.length < 3 + userLen) return;
          const passLen = pending[2 + userLen];
          if (pending.length < 3 + userLen + passLen) return;
          const credentials = `${pending.toString('utf8', 2, 2 + userLen)}:${pending.toString('utf8', 3 + userLen, 3 + userLen + passLen)}`;
          authentications.push(credentials);
          pending = pending.subarray(3 + userLen + passLen);
          socket.write(Buffer.from([1, credentials === options.auth ? 0 : 1]));
          if (credentials !== options.auth) { socket.end(); return; }
          stage = 'connect';
        } else {
          if (pending.length < 5) return;
          const addressType = pending[3];
          const length = addressType === 1 ? 4 : addressType === 3 ? pending[4] + 1 : 16;
          if (pending.length < 6 + length) return;
          assert.equal(pending[0], 5);
          assert.equal(pending[1], 1);
          assert.ok(addressType === 1 || addressType === 3);
          const host = addressType === 1 ? Array.from(pending.subarray(4, 8)).join('.') : pending.toString('utf8', 5, 4 + length);
          const port = pending.readUInt16BE(4 + length);
          connects.push({ host, port });
          const head = pending.subarray(6 + length);
          socket.off('data', data);
          socket.pause();
          if (options.stall) { socket.resume(); return; }
          if (options.reject) { socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
          connectRemote(socket, host, port, head, () => socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])));
          return;
        }
      }
    };
    socket.on('data', data);
  });
  const fixture = await managed(t, server);
  return { ...fixture, connects, authentications, url: `socks5h://${options.auth ? `${options.auth}@` : ''}127.0.0.1:${fixture.port}` };
}

async function makeTarget(t) {
  const requests = [];
  const fixture = await managed(t, http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
      res.end('two-hop-target');
    });
  }));
  return { ...fixture, requests };
}

async function relayFor(t, local, upstream, timeoutMs = 1000) {
  const relay = await createProxyChainRelay({ localProxyUrl: local.url, upstreamProxyUrl: upstream.url, timeoutMs });
  t.after(() => relay.close());
  return relay;
}

function authFor(url) {
  return BASIC(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`);
}

function requestHttp(relay, target, options = {}) {
  const url = new URL(relay.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: target, method: options.method || 'GET', headers: {
      'proxy-authorization': authFor(url), connection: 'close', ...options.headers,
    } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function connectClient(relay, destination, headers = {}) {
  const url = new URL(relay.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, method: 'CONNECT', path: destination,
      headers: { 'proxy-authorization': authFor(url), ...headers } });
    req.on('error', reject);
    req.on('connect', (res, socket, head) => {
      socket.on('error', () => {});
      resolve({ status: res.statusCode, socket, head });
    });
    req.end();
  });
}

test('normalizes loopback proxies and rejects remote/credentialed/path-bearing local URLs', () => {
  assert.equal(validateLocalProxyUrl('http://localhost:7897/'), 'http://127.0.0.1:7897');
  assert.equal(validateLocalProxyUrl('http://localhost:80/'), 'http://127.0.0.1:80');
  assert.equal(validateLocalProxyUrl('socks5h://[::1]:1080'), 'socks5h://[::1]:1080');
  assert.equal(validateLocalProxyUrl('socks5://127.0.0.2:1080'), 'socks5://127.0.0.2:1080');
  for (const url of ['http://example.org:7897', 'http://127.0.0.1.example.org:7897', 'http://0.0.0.0:7897', 'http://user:secret@127.0.0.1:7897', 'http://127.0.0.1:7897/path', 'http://127.0.0.1:7897?proxy=secret', 'http://127.0.0.1:7897#secret', 'https://127.0.0.1:7897', 'invalid']) {
    assert.throws(() => validateLocalProxyUrl(url), { code: 'PROXY_CHAIN_INVALID_LOCAL_PROXY', message: 'PROXY_CHAIN_INVALID_LOCAL_PROXY' });
  }
});

for (const localProtocol of ['http', 'socks5']) {
  for (const upstreamProtocol of ['http', 'socks5']) {
    test(`plain HTTP body travels through ${localProtocol} local and ${upstreamProtocol} upstream, without exposing proxy auth`, { timeout: 4000 }, async (t) => {
      const target = await makeTarget(t);
      const upstream = await (upstreamProtocol === 'http' ? httpProxy : socksProxy)(t, { auth: 'upstream-user:upstream-password' });
      const local = await (localProtocol === 'http' ? httpProxy : socksProxy)(t);
      // A hostname unresolvable locally proves the first proxy resolves the
      // upstream, and the upstream resolves the target independently.
      upstream.url = upstream.url.replace('127.0.0.1', 'upstream.invalid');
      const relay = await relayFor(t, local, upstream);
      assert.deepEqual(await requestHttp(relay, `http://target.invalid:${target.port}/path?a=1`, {
        method: 'POST', body: 'payload', headers: { authorization: 'Bearer target-only', 'x-normal': 'present', connection: 'x-private', 'x-private': 'remove-me' },
      }), { status: 200, body: 'two-hop-target' });
      assert.equal(local.connects.length, 1);
      assert.equal(upstream.connects.length, 1);
      assert.equal(target.requests.length, 1);
      assert.equal(target.requests[0].path, '/path?a=1');
      assert.equal(target.requests[0].body, 'payload');
      assert.equal(target.requests[0].headers.authorization, 'Bearer target-only');
      assert.equal(target.requests[0].headers['proxy-authorization'], undefined);
      assert.equal(target.requests[0].headers['x-private'], undefined);
      assert.equal(target.requests[0].headers['x-normal'], 'present');
      if (localProtocol === 'http') {
        assert.equal(local.connects[0].destination, `upstream.invalid:${upstream.port}`);
        assert.equal(local.connects[0].authorization, undefined);
      } else assert.deepEqual(local.connects[0], { host: 'upstream.invalid', port: upstream.port });
      if (upstreamProtocol === 'http') {
        assert.equal(upstream.connects[0].destination, `target.invalid:${target.port}`);
        assert.equal(upstream.connects[0].authorization, BASIC('upstream-user:upstream-password'));
      } else {
        assert.deepEqual(upstream.connects[0], { host: 'target.invalid', port: target.port });
        assert.deepEqual(upstream.authentications, ['upstream-user:upstream-password']);
      }
    });
  }
}

test('CONNECT accepts early bytes and preserves the two-hop path', { timeout: 4000 }, async (t) => {
  const target = await makeTarget(t);
  const upstream = await httpProxy(t, { auth: 'account:password' });
  const local = await httpProxy(t);
  const relay = await relayFor(t, local, upstream);
  const endpoint = new URL(relay.url);
  const socket = net.connect({ host: endpoint.hostname, port: endpoint.port });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  let output = '';
  socket.on('data', (chunk) => { output += chunk.toString(); });
  socket.write(`CONNECT target.invalid:${target.port} HTTP/1.1\r\nHost: target.invalid:${target.port}\r\nProxy-Authorization: ${authFor(endpoint)}\r\n\r\nGET /early HTTP/1.1\r\nHost: target.invalid\r\nConnection: close\r\n\r\n`);
  await once(socket, 'close');
  assert.match(output, /^HTTP\/1.1 200 Connection Established/);
  assert.match(output, /two-hop-target/);
  assert.equal(target.requests[0].path, '/early');
  assert.equal(local.connects.length, 1);
  assert.equal(upstream.connects.length, 1);
});

test('the private relay rejects requests without its own credentials before touching either proxy', { timeout: 4000 }, async (t) => {
  const upstream = await httpProxy(t);
  const local = await httpProxy(t);
  const relay = await relayFor(t, local, upstream);
  assert.equal((await requestHttp(relay, 'http://target.invalid/', { headers: { 'proxy-authorization': '' } })).status, 407);
  const connect = await connectClient(relay, 'target.invalid:443', { 'proxy-authorization': 'Basic wrong' });
  connect.socket.destroy();
  assert.equal(connect.status, 407);
  assert.equal(local.connects.length, 0);
  assert.equal(upstream.connects.length, 0);
});

for (const stalledStage of ['local', 'upstream']) {
  test(`deadline destroys sockets when the ${stalledStage} proxy stalls before CONNECT`, { timeout: 4000 }, async (t) => {
    const upstream = await httpProxy(t, { stall: stalledStage === 'upstream' });
    const local = await httpProxy(t, { stall: stalledStage === 'local' });
    const relay = await relayFor(t, local, upstream, 150);
    const result = await requestHttp(relay, 'http://target.invalid/');
    assert.equal(result.status, 502);
    assert.equal(result.body, 'PROXY_CHAIN_TIMEOUT');
    assert.equal(local.connects.length, 1);
    assert.equal(upstream.connects.length, stalledStage === 'upstream' ? 1 : 0);
    await relay.close();
    await Promise.all([...local.sockets, ...upstream.sockets].map((socket) => socket.destroyed ? null : once(socket, 'close')));
    assert.equal(local.sockets.size, 0);
    assert.equal(upstream.sockets.size, 0);
  });
}

for (const rejectedStage of ['local', 'upstream']) {
  test(`${rejectedStage} rejection fails closed without leaking credentials or reaching target`, { timeout: 4000 }, async (t) => {
    const target = await makeTarget(t);
    const upstream = await httpProxy(t, { reject: rejectedStage === 'upstream' ? 407 : 0, auth: 'do-not-print:upstream-secret' });
    const local = await httpProxy(t, { reject: rejectedStage === 'local' ? 403 : 0 });
    const relay = await relayFor(t, local, upstream);
    const result = await requestHttp(relay, `http://127.0.0.1:${target.port}/`);
    assert.deepEqual(result, { status: 502, body: `PROXY_CHAIN_${rejectedStage.toUpperCase()}_${rejectedStage === 'upstream' ? 'AUTH_REQUIRED' : 'REJECTED'}` });
    assert.equal(target.requests.length, 0);
    assert.equal(upstream.connects.length, rejectedStage === 'upstream' ? 1 : 0);
  });
}

test('close cancels unfinished handshakes, closes tunnels and is idempotent', { timeout: 4000 }, async (t) => {
  const upstream = await httpProxy(t, { stall: true });
  const local = await httpProxy(t);
  const relay = await relayFor(t, local, upstream, 30000);
  const arrived = once(upstream.server, 'connect');
  const request = requestHttp(relay, 'http://target.invalid/').catch((error) => ({ error: error.code }));
  await arrived;
  await Promise.all([relay.close(), relay.close()]);
  assert.ok((await request).error);
  const endpoint = new URL(relay.url);
  const probe = net.connect({ host: endpoint.hostname, port: endpoint.port });
  const [error] = await once(probe, 'error');
  assert.equal(error.code, 'ECONNREFUSED');
});

test('close tears down an established idle CONNECT tunnel', { timeout: 4000 }, async (t) => {
  const target = await managed(t, net.createServer((socket) => socket.resume()));
  const upstream = await socksProxy(t);
  const local = await httpProxy(t);
  const relay = await relayFor(t, local, upstream);
  const connected = await connectClient(relay, `127.0.0.1:${target.port}`);
  assert.equal(connected.status, 200);
  const closed = once(connected.socket, 'close');
  await relay.close();
  await closed;
});

test('HTTPS upstream is reached through the first hop and verifies its certificate', {
  timeout: 10000,
  skip: typeof tls.setDefaultCACertificates !== 'function' ? 'Node does not support isolated default CA updates' : false,
}, async (t) => {
  const { privateKey: key } = generateKeyPairSync('rsa', {
    modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  // Generate fixture credentials in memory only. No trust or certificate
  // changes are made outside this test process.
  const cert = execFileSync('openssl', ['req', '-new', '-x509', '-key', '/dev/stdin', '-subj', '/CN=localhost', '-days', '1'], { input: key, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const target = await makeTarget(t);
  const upstream = await httpProxy(t, { auth: 'tls-user:tls-password', tls: { key, cert } });
  upstream.url = upstream.url.replace('127.0.0.1', 'localhost');
  const local = await httpProxy(t);
  const relay = await relayFor(t, local, upstream);
  const targetUrl = `http://target.invalid:${target.port}/secure-proxy`;
  assert.deepEqual(await requestHttp(relay, targetUrl), { status: 502, body: 'PROXY_CHAIN_UPSTREAM_TLS_FAILED' });
  assert.equal(upstream.connects.length, 0);
  assert.equal(target.requests.length, 0);
  const previousCAs = tls.getCACertificates();
  tls.setDefaultCACertificates([...previousCAs, cert]);
  t.after(() => tls.setDefaultCACertificates(previousCAs));
  assert.deepEqual(await requestHttp(relay, targetUrl), { status: 200, body: 'two-hop-target' });
  assert.equal(local.connects.length, 2);
  assert.equal(upstream.connects.length, 1);
  assert.equal(upstream.connects[0].authorization, BASIC('tls-user:tls-password'));
});
