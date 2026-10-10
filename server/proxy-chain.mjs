import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SocksClient } from 'socks';

const LOCAL_PROTOCOLS = new Set(['http:', 'socks5:', 'socks5h:']);
const UPSTREAM_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks5:', 'socks5h:']);
const HOP_HEADERS = ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function bareHost(host) {
  return host.replace(/^\[|\]$/g, '');
}

function authority(host, port) {
  return `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
}

function proxyConfig(value, local = false) {
  const code = local ? 'PROXY_CHAIN_INVALID_LOCAL_PROXY' : 'PROXY_CHAIN_INVALID_UPSTREAM_PROXY';
  try {
    const url = new URL(String(value || '').trim());
    if (!(local ? LOCAL_PROTOCOLS : UPSTREAM_PROTOCOLS).has(url.protocol)
      || !url.hostname || (url.pathname && url.pathname !== '/') || url.search || url.hash) throw failure(code);
    let host = bareHost(url.hostname);
    if (local) {
      if (url.username || url.password) throw failure(code);
      if (host === 'localhost') host = '127.0.0.1';
      if (host !== '::1' && !(net.isIPv4(host) && host.startsWith('127.'))) throw failure(code);
      url.hostname = net.isIPv6(host) ? `[${host}]` : host;
    }
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (/[\r\n\0]/.test(username + password)) throw failure(code);
    const port = Number(url.port || (url.protocol.startsWith('socks') ? 1080 : url.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure(code);
    // Keep an explicit port: the browser configuration parser has different
    // defaults for HTTP proxies, so stripping :80 would change the route.
    const normalized = local ? `${url.protocol}//${authority(host, port)}` : url.href.replace(/\/$/, '');
    return { url: normalized, host, port, username, password, protocol: url.protocol };
  } catch {
    throw failure(code);
  }
}

export function validateLocalProxyUrl(value) {
  return proxyConfig(value, true).url;
}

export const normalizeLocalProxyUrl = validateLocalProxyUrl;

function waitForSocket(socket, event, code) {
  return new Promise((resolve, reject) => {
    const done = (error) => {
      socket.off(event, ready);
      socket.off('error', failed);
      socket.off('close', failed);
      error ? reject(failure(code)) : resolve(socket);
    };
    const ready = () => done();
    const failed = () => done(true);
    socket.once(event, ready);
    socket.once('error', failed);
    socket.once('close', failed);
  });
}

function httpConnect(socket, proxy, destination, stage) {
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', data);
      socket.off('error', failed);
      socket.off('close', failed);
    };
    const failed = () => {
      cleanup();
      reject(failure(`PROXY_CHAIN_${stage}_CONNECT_FAILED`));
    };
    const data = (chunk) => {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf('\r\n\r\n');
      if (end < 0 && response.length <= 32768) return;
      socket.pause();
      cleanup();
      const status = Number(response.toString('latin1', 0, end < 0 ? response.length : end).match(/^HTTP\/1\.[01] (\d{3})(?: |\r\n)/)?.[1]);
      if (end < 0 || end > 32768 || status < 200 || status >= 300 || !status) {
        reject(failure(`PROXY_CHAIN_${stage}_${status === 407 ? 'AUTH_REQUIRED' : 'REJECTED'}`));
        return;
      }
      const remaining = response.subarray(end + 4);
      if (remaining.length) socket.unshift(remaining);
      resolve(socket);
    };
    socket.on('data', data);
    socket.once('error', failed);
    socket.once('close', failed);
    const host = authority(destination.host, destination.port);
    const auth = proxy.username || proxy.password
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n` : '';
    socket.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n${auth}\r\n`);
    socket.resume();
  });
}

async function proxyConnect(socket, proxy, destination, stage, remainingMs) {
  if (!proxy.protocol.startsWith('socks')) return httpConnect(socket, proxy, destination, stage);
  try {
    // Pass hostnames to SOCKS5; DNS belongs to the proxy at this hop.
    const result = SocksClient.createConnection({
      command: 'connect', existing_socket: socket, timeout: remainingMs,
      proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username, password: proxy.password },
      destination,
    });
    socket.resume();
    return (await result).socket;
  } catch {
    throw failure(`PROXY_CHAIN_${stage}_SOCKS_FAILED`);
  }
}

function destinationFromConnect(value) {
  try {
    const url = new URL(`http://${value}`);
    if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return { host: bareHost(url.hostname), port: Number(url.port || 80) };
  } catch {
    throw failure('PROXY_CHAIN_INVALID_TARGET');
  }
}

function cleanHeaders(headers) {
  const cleaned = { ...headers };
  const nominated = String(headers.connection || '').toLowerCase().split(',').map((name) => name.trim());
  for (const name of [...HOP_HEADERS, ...nominated]) delete cleaned[name];
  return cleaned;
}

/**
 * A private HTTP proxy for one local-proxy -> upstream-proxy route. Both
 * CONNECT and plain HTTP use the same two hops. No branch connects directly
 * to the upstream or target. Keep this relay alive while its browser runs.
 */
export async function createProxyChainRelay({ localProxyUrl, upstreamProxyUrl, timeoutMs = 15000 } = {}) {
  const local = proxyConfig(localProxyUrl, true);
  const upstream = proxyConfig(upstreamProxyUrl);
  const deadlineMs = Math.min(120000, Math.max(100, Number(timeoutMs) || 15000));
  const sockets = new Set();
  const operations = new Set();
  let closing = false;
  let closePromise;
  const credentials = `chain:${randomBytes(24).toString('hex')}`;
  const expectedAuth = Buffer.from(`Basic ${Buffer.from(credentials).toString('base64')}`);
  const authenticated = (req) => {
    const supplied = Buffer.from(String(req.headers['proxy-authorization'] || ''));
    return supplied.length === expectedAuth.length && timingSafeEqual(supplied, expectedAuth);
  };
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    if (closing) socket.destroy();
    return socket;
  };

  async function openTunnel(destination, client) {
    if (closing || client.destroyed) throw failure('PROXY_CHAIN_CLOSED');
    const owned = new Set();
    let cancelled = false;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = (code = 'PROXY_CHAIN_CLOSED') => {
      cancelled = true;
      rejectAbort(failure(code));
      for (const socket of owned) socket.destroy();
    };
    const own = (socket) => {
      if (cancelled || closing) { socket.destroy(); throw failure('PROXY_CHAIN_CLOSED'); }
      owned.add(socket);
      return track(socket);
    };
    const started = Date.now();
    const remainingMs = () => Math.max(1, deadlineMs - (Date.now() - started));
    const clientClosed = () => abort('PROXY_CHAIN_CLIENT_CLOSED');
    client.once('close', clientClosed);
    operations.add(abort);
    const timer = setTimeout(() => abort('PROXY_CHAIN_TIMEOUT'), deadlineMs);
    timer.unref();
    try {
      const work = (async () => {
        let socket = own(net.connect({ host: local.host, port: local.port }));
        await waitForSocket(socket, 'connect', 'PROXY_CHAIN_LOCAL_CONNECT_FAILED');
        socket = await proxyConnect(socket, local, { host: upstream.host, port: upstream.port }, 'LOCAL', remainingMs());
        if (cancelled || closing) throw failure('PROXY_CHAIN_CLOSED');
        if (upstream.protocol === 'https:') {
          socket = own(tls.connect({ socket, servername: net.isIP(upstream.host) ? undefined : upstream.host, rejectUnauthorized: true }));
          await waitForSocket(socket, 'secureConnect', 'PROXY_CHAIN_UPSTREAM_TLS_FAILED');
        }
        socket = await proxyConnect(socket, upstream, destination, 'UPSTREAM', remainingMs());
        if (cancelled || closing) throw failure('PROXY_CHAIN_CLOSED');
        return socket;
      })();
      return await Promise.race([work, aborted]);
    } catch (error) {
      for (const socket of owned) socket.destroy();
      throw failure(/^PROXY_CHAIN_[A-Z_]+$/.test(error?.code || '') ? error.code : 'PROXY_CHAIN_CONNECT_FAILED');
    } finally {
      clearTimeout(timer);
      client.off('close', clientClosed);
      operations.delete(abort);
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!authenticated(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="auto-team-chain"', connection: 'close' });
      res.end('PROXY_CHAIN_AUTH_REQUIRED');
      return;
    }
    let remote;
    let agent;
    let request;
    try {
      const target = new URL(req.url);
      if (target.protocol !== 'http:' || target.username || target.password) throw failure('PROXY_CHAIN_INVALID_TARGET');
      remote = await openTunnel({ host: bareHost(target.hostname), port: Number(target.port || 80) }, req.socket);
      if (req.destroyed || res.destroyed) { remote.destroy(); return; }
      agent = new http.Agent({ keepAlive: false });
      // The only Agent connection is our established tunnel. It must never
      // resolve or open the destination itself.
      agent.createConnection = () => remote;
      const headers = { ...cleanHeaders(req.headers), host: target.host, connection: 'close' };
      request = http.request({ hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers, agent }, (response) => {
        res.writeHead(response.statusCode, { ...cleanHeaders(response.headers), connection: 'close' });
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      request.on('error', () => {
        if (!res.headersSent) { res.writeHead(502, { connection: 'close' }); res.end('PROXY_CHAIN_REQUEST_FAILED'); }
        else res.destroy();
        remote.destroy();
        agent.destroy();
      });
      request.setTimeout(deadlineMs, () => request.destroy(failure('PROXY_CHAIN_TIMEOUT')));
      req.once('aborted', () => request.destroy());
      res.once('close', () => { request.destroy(); remote.destroy(); agent.destroy(); });
      req.pipe(request);
      remote.resume();
    } catch (error) {
      remote?.destroy();
      agent?.destroy();
      if (!res.destroyed) {
        res.writeHead(502, { connection: 'close' });
        res.end(/^PROXY_CHAIN_[A-Z_]+$/.test(error?.code || '') ? error.code : 'PROXY_CHAIN_REQUEST_FAILED');
      }
    }
  });
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', async (req, client, head) => {
    if (!authenticated(req)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="auto-team-chain"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    client.pause();
    try {
      const remote = await openTunnel(destinationFromConnect(req.url), client);
      if (client.destroyed) { remote.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.once('close', () => remote.destroy());
      remote.once('close', () => client.destroy());
      client.pipe(remote);
      remote.pipe(client);
      client.resume();
      remote.resume();
    } catch (error) {
      if (!client.destroyed) {
        const body = /^PROXY_CHAIN_[A-Z_]+$/.test(error?.code || '') ? error.code : 'PROXY_CHAIN_CONNECT_FAILED';
        client.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      }
    }
  });
  server.headersTimeout = deadlineMs;
  server.requestTimeout = deadlineMs;
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(failure('PROXY_CHAIN_LISTEN_FAILED')));
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const port = server.address().port;
  return {
    url: `http://${credentials}@127.0.0.1:${port}`,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const abort of operations) abort();
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise((resolve) => server.close(resolve));
      return closePromise;
    },
  };
}
