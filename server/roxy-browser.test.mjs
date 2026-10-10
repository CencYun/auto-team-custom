import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import {
  DEFAULT_ROXY_CONFIG, RoxyBrowserError, normalizeRoxyApiBase, normalizeRoxyConfig, publicRoxyConfig,
  createRoxyApiClient, validateRoxyCdpEndpoint, createRoxyCdpTransport, openRoxyBrowserSession,
  roxyProxyInfo, resolveRoxyAccountProfile,
} from './roxy-browser.mjs';

const config = {
  enabled: true, headless: false, useProxyPool: false, concurrency: 1,
  baseUrl: 'http://127.0.0.1:50000', apiKey: 'fixture-only-private-key',
  workspaceId: '149202', profiles: [{ childId: 'child_test', dirId: 'profile_test' }],
};
const endpoint = 'ws://127.0.0.1:50001/devtools/browser/fixture-test';
const json = (body, options) => new Response(JSON.stringify(body), options);
const codeIs = (code) => (error) => error instanceof RoxyBrowserError && error.code === code && !error.message.includes(config.apiKey);

test('Roxy config preserves an omitted secret, clears explicit empty secret and redacts public state', () => {
  assert.deepEqual(normalizeRoxyConfig({ workspaceId: 'new_workspace' }, config), { ...config, workspaceId: 'new_workspace' });
  assert.equal(normalizeRoxyConfig({ enabled: false, apiKey: '' }, config).apiKey, '');
  assert.throws(() => normalizeRoxyConfig({ apiKey: '' }, config), codeIs('roxy_api_key_missing'));
  assert.deepEqual(publicRoxyConfig(config), {
    enabled: true, headless: false, useProxyPool: false, concurrency: 1,
    baseUrl: config.baseUrl, apiKeySet: true, workspaceId: config.workspaceId, profiles: config.profiles,
  });
  assert.equal(JSON.stringify(publicRoxyConfig(config)).includes(config.apiKey), false);
  assert.deepEqual(normalizeRoxyConfig(), { ...DEFAULT_ROXY_CONFIG, profiles: [] });
});

test('Roxy concurrency is an integer from one to three and partial patches preserve bindings and secrets', () => {
  for (const concurrency of [0, 4, 1.5, '2', null, true]) {
    assert.throws(() => normalizeRoxyConfig({ concurrency }, config), codeIs('roxy_concurrency_invalid'));
  }
  for (const concurrency of [1, 2, 3]) {
    const normalized = normalizeRoxyConfig({ concurrency }, config);
    assert.equal(normalized.concurrency, concurrency);
    assert.equal(normalized.apiKey, config.apiKey);
    assert.deepEqual(normalized.profiles, config.profiles);
    assert.equal(publicRoxyConfig(normalized).concurrency, concurrency);
  }
  const { concurrency, ...legacy } = config;
  assert.equal(normalizeRoxyConfig(legacy).concurrency, 1);
});

test('Roxy rejects invalid API URLs and does not permit arbitrary network targets', () => {
  for (const url of ['https://127.0.0.1:50000', 'http://example.com:50000', 'http://user:pass@localhost:50000',
    'http://localhost:50000/private', 'http://localhost:50000/?key=secret', 'http://localhost:50000/#secret', 'invalid']) {
    assert.throws(() => normalizeRoxyApiBase(url), codeIs('roxy_api_base_invalid'));
  }
  for (const url of ['http://127.0.0.1:50000', 'http://localhost:50000', 'http://[::1]:50000']) {
    assert.equal(normalizeRoxyApiBase(url), url);
  }
});

test('Roxy rejects duplicate window/child mappings and malformed config', () => {
  for (const profiles of [
    [{ childId: 'a', dirId: 'same' }, { childId: 'b', dirId: 'same' }],
    [{ childId: 'same', dirId: 'a' }, { childId: 'same', dirId: 'b' }],
  ]) assert.throws(() => normalizeRoxyConfig({ profiles }, config), codeIs('roxy_profile_conflict'));
  for (const patch of [{ enabled: 'true' }, { headless: 'true' }, { useProxyPool: 'false' }, { profiles: {} }, { profiles: [null] }, { apiKey: 'line\nbreak' },
    { workspaceId: 'invalid/id' }, { profiles: [{ childId: 'child', dirId: '' }] }]) {
    assert.throws(() => normalizeRoxyConfig(patch, config), codeIs('roxy_config_invalid'));
  }
  assert.throws(() => normalizeRoxyConfig({ workspaceId: '' }, config), codeIs('roxy_workspace_missing'));
});

test('Roxy config defaults old installations to headed mode and preserves fixed proxy bindings', () => {
  const { headless, useProxyPool, ...legacyConfig } = config;
  assert.deepEqual(normalizeRoxyConfig(legacyConfig), config);
  const profiles = [{ childId: 'child_test', dirId: 'profile_test', proxyId: 'proxy_fixed' }];
  const selected = normalizeRoxyConfig({ headless: true, useProxyPool: true, profiles }, config);
  assert.equal(selected.headless, true);
  assert.equal(selected.useProxyPool, true);
  assert.deepEqual(publicRoxyConfig(selected).profiles, profiles);
  assert.deepEqual(normalizeRoxyConfig({ enabled: false }, selected).profiles, profiles);
  assert.throws(() => normalizeRoxyConfig({ profiles: [{ ...profiles[0], proxyId: 'invalid/id' }] }, config), codeIs('roxy_config_invalid'));
});

test('Roxy proxy conversion uses documented fields, credentials and supported protocols only', () => {
  assert.deepEqual(roxyProxyInfo({ url: 'http://127.0.0.1:7897' }), {
    proxyMethod: 'custom', proxyCategory: 'HTTP', ipType: 'IPV4',
    host: '127.0.0.1', port: '7897', proxyUserName: '', proxyPassword: '',
  });
  assert.deepEqual(roxyProxyInfo({ url: 'socks5h://user%40name:pass%3Aword@[::1]:1080' }), {
    proxyMethod: 'custom', proxyCategory: 'SOCKS5', ipType: 'IPV6',
    host: '::1', port: '1080', proxyUserName: 'user@name', proxyPassword: 'pass:word',
  });
  assert.equal(roxyProxyInfo({ url: 'https://proxy.example:8443' }).proxyCategory, 'HTTPS');
  assert.equal(roxyProxyInfo({ url: 'http://proxy.example:80' }).port, '80');
  for (const entry of [null, {}, { url: '' }, { url: 'http://localhost:7897', enabled: false }]) {
    assert.throws(() => roxyProxyInfo(entry), codeIs('roxy_proxy_missing'));
  }
  for (const url of ['socks4://localhost:1080', 'ftp://localhost:21', 'invalid', 'http://localhost:0',
    'http://localhost:7897/path', 'http://localhost:7897?token=secret', 'http://localhost:7897#secret',
    'http://user:%ZZ@localhost:7897', 'http://user:pass%0Aword@localhost:7897']) {
    assert.throws(() => roxyProxyInfo({ url }), codeIs('roxy_proxy_invalid'));
  }
});

test('Roxy CDP endpoints are local browser websocket paths only', () => {
  assert.equal(validateRoxyCdpEndpoint(endpoint), endpoint);
  for (const url of ['wss://localhost:50001/devtools/browser/test', 'ws://evil.test:50001/devtools/browser/test',
    'ws://localhost/devtools/browser/test', 'ws://user:secret@localhost:50001/devtools/browser/test',
    'ws://localhost:50001/devtools/page/test', `${endpoint}?secret=value`, `${endpoint}#secret`, 'invalid']) {
    assert.throws(() => validateRoxyCdpEndpoint(url), codeIs('roxy_cdp_invalid'));
  }
});

test('Roxy native CDP transport forwards frames and closes only its websocket', async () => {
  let socket;
  class FixtureSocket extends EventTarget {
    constructor(url) { super(); this.url = url; this.frames = []; socket = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(message) { this.frames.push(message); }
    close() { this.closed = true; this.dispatchEvent(new Event('close')); }
  }
  const transport = await createRoxyCdpTransport(endpoint, { WebSocketImpl: FixtureSocket });
  assert.equal(socket.url, endpoint);
  assert.equal(socket.binaryType, 'arraybuffer');
  const messages = [];
  transport.onmessage = (message) => messages.push(message);
  transport.send('fixture-out');
  socket.dispatchEvent(new MessageEvent('message', { data: 'fixture-in' }));
  socket.dispatchEvent(new MessageEvent('message', { data: new TextEncoder().encode('binary-in').buffer }));
  assert.deepEqual(socket.frames, ['fixture-out']);
  assert.deepEqual(messages, ['fixture-in', 'binary-in']);
  let closed = false;
  transport.onclose = () => { closed = true; };
  transport.close();
  assert.equal(socket.closed, true);
  assert.equal(closed, true);
});

test('Roxy CDP handshake fails safely on errors and times out stalled sockets', async () => {
  class RejectedSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
    close() {}
  }
  await assert.rejects(() => createRoxyCdpTransport(endpoint, { WebSocketImpl: RejectedSocket }), codeIs('roxy_connect_failed'));
  let closed = false;
  class StalledSocket extends EventTarget { close() { closed = true; } }
  await assert.rejects(() => createRoxyCdpTransport(endpoint, { timeoutMs: 100, WebSocketImpl: StalledSocket }), codeIs('roxy_connect_failed'));
  assert.equal(closed, true);
});

test('Roxy native websocket does not follow an HTTP handshake redirect', async (t) => {
  let redirectedRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/devtools/browser/redirected') redirectedRequests += 1;
    res.writeHead(302, { Location: `ws://127.0.0.1:${server.address().port}/devtools/browser/redirected` });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = `ws://127.0.0.1:${server.address().port}/devtools/browser/fixture`;
  await assert.rejects(() => createRoxyCdpTransport(address, { timeoutMs: 1000 }), codeIs('roxy_connect_failed'));
  assert.equal(redirectedRequests, 0);
});

test('Roxy API follows documented endpoints, token header and bounded pagination', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options });
    const route = new URL(url).pathname;
    const data = route === '/browser/workspace' ? { total: 1, rows: [{ id: '149202', workspaceName: 'Fixture', apiKey: config.apiKey }] }
      : route === '/browser/list_v3' ? { total: 1, rows: [{ dirId: 'profile_test', windowSortNum: 1, windowName: 'Fixture', coreType: 'Chrome', coreVersion: '139', credentials: 'never-return' }] }
        : route === '/browser/connection_info' ? [{ dirId: 'profile_test', ws: endpoint }]
          : route === '/browser/open' ? { ws: endpoint, driver: 'never-return' } : undefined;
    return json({ code: 0, ...(data === undefined ? {} : { data }), msg: 'success' });
  };
  const client = createRoxyApiClient(config, { fetchImpl });
  assert.deepEqual(await client.health(), { ok: true });
  assert.deepEqual(await client.listWorkspaces({ pageIndex: 2, pageSize: 10 }), { total: 1, rows: [{ id: '149202', workspaceName: 'Fixture' }] });
  assert.deepEqual(await client.listProfiles('149202'), { total: 1, rows: [{ dirId: 'profile_test', windowSortNum: 1, windowName: 'Fixture', windowRemark: '', coreType: 'Chrome', coreVersion: '139' }] });
  assert.deepEqual(await client.connectionInfo('profile_test'), [{ dirId: 'profile_test' }]);
  assert.deepEqual(await client.open('149202', 'profile_test'), { ws: endpoint });
  await client.close('profile_test');
  assert.deepEqual(requests.map((request) => request.url.pathname), ['/health', '/browser/workspace', '/browser/list_v3', '/browser/connection_info', '/browser/open', '/browser/close']);
  assert.equal(requests[1].url.searchParams.get('page_index'), '2');
  assert.equal(requests[1].url.searchParams.get('page_size'), '10');
  assert.equal(requests[2].url.searchParams.get('workspaceId'), '149202');
  assert.equal(requests[3].url.searchParams.get('dirIds'), 'profile_test');
  assert.deepEqual(JSON.parse(requests[4].options.body), { workspaceId: '149202', dirId: 'profile_test', forceOpen: false, headless: false });
  assert.deepEqual(JSON.parse(requests[5].options.body), { dirId: 'profile_test' });
  for (const { options } of requests) {
    assert.equal(options.headers.token, config.apiKey);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
  }
  await assert.rejects(() => client.listWorkspaces({ pageSize: 101 }), codeIs('roxy_config_invalid'));
});

test('Roxy safe errors do not forward provider secrets or unsanitized provider text', async () => {
  for (const [response, code] of [
    [json({ msg: config.apiKey }, { status: 401 }), 'roxy_api_auth_failed'],
    [json({ msg: config.apiKey }, { status: 403 }), 'roxy_api_auth_failed'],
    [json({ msg: config.apiKey }, { status: 429 }), 'roxy_api_rate_limited'],
    [json({ msg: config.apiKey }, { status: 500 }), 'roxy_api_failed'],
    [json({ code: 500, msg: `订阅已过期 ${config.apiKey}` }), 'roxy_entitlement_unavailable'],
    [json({ code: 500, msg: config.apiKey }), 'roxy_api_failed'],
    [json({ code: '0', msg: config.apiKey }), 'roxy_response_invalid'],
    [new Response('not-json'), 'roxy_response_invalid'],
    [new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } }), 'roxy_response_invalid'],
  ]) {
    const client = createRoxyApiClient(config, { fetchImpl: async () => response });
    await assert.rejects(() => client.health(), codeIs(code));
  }
  const client = createRoxyApiClient(config, { fetchImpl: async () => { throw new Error(config.apiKey); } });
  await assert.rejects(() => client.health(), codeIs('roxy_api_unavailable'));
});

test('Roxy profile creation uses the official body and returns only its validated directory ID', async () => {
  let request;
  const client = createRoxyApiClient(config, { fetchImpl: async (url, options) => {
    request = { path: new URL(url).pathname, ...options };
    return json({ code: 0, data: { dirId: 'new_profile', ignored: 'private-response-field' } });
  } });
  assert.deepEqual(await client.createProfile('149202', { windowName: 'AutoTeam fixture', windowRemark: 'auto-team:child:child_test' }), { dirId: 'new_profile' });
  assert.equal(request.path, '/browser/create');
  assert.equal(request.method, 'POST');
  assert.deepEqual(JSON.parse(request.body), { workspaceId: '149202', windowName: 'AutoTeam fixture',
    windowRemark: 'auto-team:child:child_test', os: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux', coreType: 'Chrome' });
  const invalid = createRoxyApiClient(config, { fetchImpl: async () => json({ code: 0, data: {} }) });
  await assert.rejects(() => invalid.createProfile('149202', { windowName: 'fixture', windowRemark: 'fixture' }), codeIs('roxy_response_invalid'));
});

test('Roxy automatic profile recovery matches a stable account marker across all pages and never reuses a name alone', async () => {
  const unbound = { ...config, profiles: [] };
  const pages = [];
  let created = 0;
  const client = {
    async listProfiles(_workspace, { pageIndex }) {
      pages.push(pageIndex);
      return { total: 2, rows: [pageIndex === 1
        ? { dirId: 'old_profile', windowName: 'AutoTeam child_test', windowRemark: '' }
        : { dirId: 'recovered_profile', windowName: 'Renamed', windowRemark: 'auto-team:child:child_test' }] };
    },
    async createProfile() { created += 1; return { dirId: 'unexpected' }; },
  };
  assert.deepEqual(await resolveRoxyAccountProfile(unbound, 'child_test', { client }), {
    childId: 'child_test', dirId: 'recovered_profile', source: 'recovered',
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(created, 0);
  assert.deepEqual(await resolveRoxyAccountProfile(config, 'child_test', { client }), {
    ...config.profiles[0], source: 'bound',
  });
  assert.deepEqual(pages, [1, 2], 'a stored binding is reused without searching or creating');
});

test('Roxy creates isolated account profiles and refuses ambiguous, incomplete or conflicting recovery', async () => {
  const unbound = { ...config, profiles: [] };
  const bodies = [];
  const client = {
    async listProfiles() { return { total: 1, rows: [{ dirId: 'old_profile', windowName: 'AutoTeam fixture@example.test', windowRemark: '' }] }; },
    async createProfile(_workspace, body) { bodies.push(body); return { dirId: `new_profile_${bodies.length}` }; },
  };
  const first = await resolveRoxyAccountProfile(unbound, 'child_alpha', { client, email: 'fixture@example.test' });
  const second = await resolveRoxyAccountProfile(unbound, 'child_beta', { client, email: 'fixture@example.test' });
  assert.notEqual(first.dirId, second.dirId);
  assert.deepEqual(bodies.map((body) => body.windowRemark), ['auto-team:child:child_alpha', 'auto-team:child:child_beta']);
  assert.equal(bodies[0].windowName, 'AutoTeam fixture@example.test');
  for (const [rows, total, code] of [
    [[{ dirId: 'one', windowRemark: 'auto-team:child:child_test' }, { dirId: 'two', windowRemark: 'auto-team:child:child_test' }], 2, 'roxy_profile_ambiguous'],
    [[], 1, 'roxy_profile_list_incomplete'],
    [[{ dirId: 'one' }], 2, 'roxy_profile_list_incomplete'],
  ]) {
    const before = bodies.length;
    await assert.rejects(() => resolveRoxyAccountProfile(unbound, 'child_test', { client: {
      ...client, listProfiles: async () => ({ total, rows }),
    } }), codeIs(code));
    assert.equal(bodies.length, before);
  }
  await assert.rejects(() => resolveRoxyAccountProfile({ ...config, profiles: [{ childId: 'other', dirId: 'owned' }] }, 'child_test', {
    client: { ...client, listProfiles: async () => ({ total: 1, rows: [{ dirId: 'owned', windowRemark: 'auto-team:child:child_test' }] }) },
  }), codeIs('roxy_profile_conflict'));
  await assert.rejects(() => resolveRoxyAccountProfile({ ...config, profiles: Array.from({ length: 1000 }, (_, index) => ({
    childId: `child_${index}`, dirId: `profile_${index}`,
  })) }, 'child_test', { client }), codeIs('roxy_profile_limit'));
});

test('Roxy API updates only the documented profile proxy fields before opening in the requested mode', async () => {
  const requests = [];
  const client = createRoxyApiClient(config, { fetchImpl: async (url, options) => {
    requests.push({ path: new URL(url).pathname, ...options, body: JSON.parse(options.body) });
    return json({ code: 0, data: { ws: endpoint } });
  } });
  const proxy = { id: 'proxy_fixed', url: 'http://fixture:secret@127.0.0.1:7897' };
  await client.updateProxy('149202', 'profile_test', proxy);
  await client.open('149202', 'profile_test', { headless: true });
  assert.deepEqual(requests.map(({ path, method, body }) => ({ path, method, body })), [
    { path: '/browser/mdf', method: 'POST', body: {
      workspaceId: '149202', dirId: 'profile_test', proxyInfo: roxyProxyInfo(proxy),
    } },
    { path: '/browser/open', method: 'POST', body: {
      workspaceId: '149202', dirId: 'profile_test', forceOpen: false, headless: true,
    } },
  ]);
  assert.equal(requests[0].body.fingerInfo, undefined);
  await assert.rejects(() => client.open('149202', 'profile_test', { headless: 'true' }), codeIs('roxy_config_invalid'));
});

test('Roxy handles aborted requests, oversized response streams and malformed profile lists safely', async () => {
  const timedOut = createRoxyApiClient(config, { timeoutMs: 100, fetchImpl: async (_url, { signal }) => {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error(config.apiKey)), { once: true }));
  } });
  await assert.rejects(() => timedOut.health(), codeIs('roxy_api_timeout'));
  const oversized = createRoxyApiClient(config, { fetchImpl: async () => new Response(' '.repeat(1024 * 1024 + 1)) });
  await assert.rejects(() => oversized.health(), codeIs('roxy_response_invalid'));
  for (const data of [{ total: 1, rows: [{ dirId: 'invalid/id' }] }, { total: -1, rows: [] }, { total: 1, rows: null }]) {
    const malformed = createRoxyApiClient(config, { fetchImpl: async () => json({ code: 0, data }) });
    await assert.rejects(() => malformed.listProfiles('149202'), codeIs('roxy_response_invalid'));
  }
});

function fakeSession({ existing = [], openFailure, proxyFailure, connectFailure, ws = endpoint, cleanupFailure } = {}) {
  const calls = [];
  const page = { async close() { calls.push('page-close'); } };
  const client = {
    async connectionInfo(dirId) { calls.push(['connections', dirId]); return existing; },
    async updateProxy(workspaceId, dirId, entry) { calls.push(['proxy', workspaceId, dirId, entry]); if (proxyFailure) throw proxyFailure; },
    async open(workspaceId, dirId, options) { calls.push(['open', workspaceId, dirId, options]); if (openFailure) throw openFailure; return { ws }; },
    async close(dirId) { calls.push(['api-close', dirId]); if (cleanupFailure) throw cleanupFailure; },
  };
  const connect = async (options) => {
    calls.push(['connect', options]);
    if (connectFailure) throw connectFailure;
    return { async newPage() { calls.push('new-page'); return page; }, async disconnect() { calls.push('disconnect'); },
      async close() { assert.fail('An attached browser must never receive browser.close()'); } };
  };
  return { calls, client, connect, page };
}

test('Roxy opens a mapped normal profile, creates one page and closes only the owned window', async () => {
  const fake = fakeSession();
  const session = await openRoxyBrowserSession({ config, childId: 'child_test' }, fake);
  assert.equal(session.page, fake.page);
  assert.equal(session.keepOpenOnFailure, true);
  assert.deepEqual(fake.calls.slice(0, 2), [['connections', 'profile_test'], ['open', '149202', 'profile_test', { headless: false }]]);
  assert.equal(fake.calls[2][1].browserWSEndpoint, endpoint);
  assert.equal(fake.calls[2][1].defaultViewport, null);
  await session.close();
  await session.close();
  assert.deepEqual(fake.calls.slice(-3), ['page-close', 'disconnect', ['api-close', 'profile_test']]);
});

test('Roxy headed failure can leave the page open for inspection and releases the automation lease', async () => {
  const fake = fakeSession();
  const session = await openRoxyBrowserSession({ config, childId: 'child_test' }, fake);
  const beforeClose = fake.calls.length;
  await session.close({ keepOpen: true });
  await session.close();
  assert.deepEqual(fake.calls.slice(beforeClose), ['disconnect']);
  assert.equal(fake.calls.includes('page-close'), false);
  assert.equal(fake.calls.some((call) => Array.isArray(call) && call[0] === 'api-close'), false);

  // The local lease is released, but the actual window still blocks another
  // authorization via Roxy's connection list until the user closes it.
  const stillOpen = fakeSession({ existing: [{ dirId: 'profile_test' }] });
  await assert.rejects(() => openRoxyBrowserSession({ config, childId: 'child_test' }, stillOpen), codeIs('roxy_profile_busy'));
  assert.deepEqual(stillOpen.calls, [['connections', 'profile_test']]);
  const manuallyClosed = fakeSession();
  const next = await openRoxyBrowserSession({ config, childId: 'child_test' }, manuallyClosed);
  await next.close();
});

test('Roxy headless sessions always clean up even when asked to keep the failed window open', async () => {
  const fake = fakeSession();
  const session = await openRoxyBrowserSession({ config: { ...config, headless: true }, childId: 'child_test' }, fake);
  assert.equal(session.keepOpenOnFailure, false);
  await session.close({ keepOpen: true });
  assert.deepEqual(fake.calls.slice(-3), ['page-close', 'disconnect', ['api-close', 'profile_test']]);
});

test('Roxy pins the selected proxy before headless launch and fails closed when it cannot be applied', async () => {
  const proxyEntry = { id: 'proxy_fixed', url: 'http://127.0.0.1:7897' };
  const proxyConfig = { ...config, headless: true, useProxyPool: true,
    profiles: [{ childId: 'child_test', dirId: 'profile_test', proxyId: proxyEntry.id }] };
  const fake = fakeSession();
  const session = await openRoxyBrowserSession({ config: proxyConfig, childId: 'child_test', proxyEntry }, fake);
  assert.deepEqual(fake.calls.slice(0, 3), [
    ['connections', 'profile_test'], ['proxy', '149202', 'profile_test', proxyEntry],
    ['open', '149202', 'profile_test', { headless: true }],
  ]);
  await session.close();
  for (const [entry, code] of [[undefined, 'roxy_proxy_missing'],
    [{ ...proxyEntry, id: 'wrong_proxy' }, 'roxy_proxy_missing'],
    [{ ...proxyEntry, url: 'socks4://127.0.0.1:1080' }, 'roxy_proxy_invalid']]) {
    const rejected = fakeSession();
    await assert.rejects(() => openRoxyBrowserSession({ config: proxyConfig, childId: 'child_test', proxyEntry: entry }, rejected), codeIs(code));
    assert.deepEqual(rejected.calls, []);
  }
  const failedUpdate = fakeSession({ proxyFailure: new RoxyBrowserError('roxy_api_failed') });
  await assert.rejects(() => openRoxyBrowserSession({ config: proxyConfig, childId: 'child_test', proxyEntry }, failedUpdate), codeIs('roxy_api_failed'));
  assert.deepEqual(failedUpdate.calls, [['connections', 'profile_test'], ['proxy', '149202', 'profile_test', proxyEntry]]);
  const retry = fakeSession();
  const retried = await openRoxyBrowserSession({ config: proxyConfig, childId: 'child_test', proxyEntry }, retry);
  await retried.close();
});

test('Roxy does not change the proxy of a window already used by the user', async () => {
  const fake = fakeSession({ existing: [{ dirId: 'profile_test' }] });
  await assert.rejects(() => openRoxyBrowserSession({
    config: { ...config, useProxyPool: true }, childId: 'child_test', proxyEntry: { url: 'http://127.0.0.1:7897' },
  }, fake), codeIs('roxy_profile_busy'));
  assert.deepEqual(fake.calls, [['connections', 'profile_test']]);
});

test('Roxy refuses already-open and unbound profiles without touching any browser', async () => {
  const busy = fakeSession({ existing: [{ dirId: 'profile_test' }] });
  await assert.rejects(() => openRoxyBrowserSession({ config, childId: 'child_test' }, busy), codeIs('roxy_profile_busy'));
  assert.deepEqual(busy.calls, [['connections', 'profile_test']]);
  const missing = fakeSession();
  await assert.rejects(() => openRoxyBrowserSession({ config, childId: 'unknown' }, missing), codeIs('roxy_profile_missing'));
  assert.deepEqual(missing.calls, []);
  await assert.rejects(() => openRoxyBrowserSession({ config: { ...config, enabled: false }, childId: 'child_test' }, missing), codeIs('roxy_disabled'));
});

test('Roxy locks profiles across simultaneous accounts/tasks and releases the lock on close', async () => {
  const fake = fakeSession();
  const first = await openRoxyBrowserSession({ config, childId: 'child_test' }, fake);
  const simultaneous = fakeSession();
  await assert.rejects(() => openRoxyBrowserSession({ config, childId: 'child_test' }, simultaneous), codeIs('roxy_profile_busy'));
  assert.deepEqual(simultaneous.calls, []);
  await first.close();
  const second = await openRoxyBrowserSession({ config, childId: 'child_test' }, simultaneous);
  await second.close();
});

test('Roxy failure cleanup is bounded to owned windows and preserves safe error codes', async () => {
  const failure = new RoxyBrowserError('roxy_api_timeout');
  const notOpened = fakeSession({ openFailure: failure });
  await assert.rejects(() => openRoxyBrowserSession({ config, childId: 'child_test' }, notOpened), codeIs('roxy_api_timeout'));
  assert.equal(notOpened.calls.some((call) => Array.isArray(call) && call[0] === 'api-close'), false);
  for (const [options, code] of [[{ connectFailure: new Error(config.apiKey) }, 'roxy_connect_failed'], [{ ws: 'ws://evil.test:50001/devtools/browser/test' }, 'roxy_cdp_invalid']]) {
    const fake = fakeSession(options);
    await assert.rejects(() => openRoxyBrowserSession({ config, childId: 'child_test' }, fake), codeIs(code));
    assert.deepEqual(fake.calls.at(-1), ['api-close', 'profile_test']);
  }
  const failedCleanup = fakeSession({ cleanupFailure: new Error(config.apiKey) });
  const session = await openRoxyBrowserSession({ config, childId: 'child_test' }, failedCleanup);
  await assert.rejects(() => session.close(), codeIs('roxy_cleanup_failed'));
  const after = fakeSession();
  const retry = await openRoxyBrowserSession({ config, childId: 'child_test' }, after);
  await retry.close();
});
