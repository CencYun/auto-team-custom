import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import {
  DEFAULT_ROXY_CONFIG, RoxyBrowserError, normalizeRoxyApiBase, normalizeRoxyConfig, publicRoxyConfig,
  createRoxyApiClient, validateRoxyCdpEndpoint, createRoxyCdpTransport, openRoxyBrowserSession,
  roxyProxyInfo, resolveRoxyAccountProfile, resolveRoxyPoolProfile, deleteClosedRoxyProfile,
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

test('Roxy cleanup preference is opt-in, survives partial patches and accepts only booleans', () => {
  assert.equal(Object.hasOwn(normalizeRoxyConfig(config), 'deleteProfileAfterSuccess'), false);
  assert.equal(Object.hasOwn(publicRoxyConfig(config), 'deleteProfileAfterSuccess'), false);
  const enabled = normalizeRoxyConfig({ deleteProfileAfterSuccess: true }, config);
  assert.equal(enabled.deleteProfileAfterSuccess, true);
  assert.equal(publicRoxyConfig(enabled).deleteProfileAfterSuccess, true);
  assert.equal(normalizeRoxyConfig({ concurrency: 2 }, enabled).deleteProfileAfterSuccess, true);
  const disabled = normalizeRoxyConfig({ deleteProfileAfterSuccess: false }, enabled);
  assert.equal(disabled.deleteProfileAfterSuccess, false);
  assert.equal(publicRoxyConfig(disabled).deleteProfileAfterSuccess, false);
  for (const deleteProfileAfterSuccess of ['true', 'false', 0, 1, null, [], {}]) {
    assert.throws(() => normalizeRoxyConfig({ deleteProfileAfterSuccess }, config), codeIs('roxy_config_invalid'));
  }
});

test('Roxy failure cleanup is an independent opt-in and preserves success cleanup on partial patches', () => {
  assert.equal(Object.hasOwn(normalizeRoxyConfig(config), 'deleteProfileAfterFailure'), false);
  assert.equal(Object.hasOwn(publicRoxyConfig(config), 'deleteProfileAfterFailure'), false);
  const enabled = normalizeRoxyConfig({ deleteProfileAfterSuccess: true, deleteProfileAfterFailure: true }, config);
  assert.equal(publicRoxyConfig(enabled).deleteProfileAfterFailure, true);
  const patched = normalizeRoxyConfig({ concurrency: 2 }, enabled);
  assert.equal(patched.deleteProfileAfterFailure, true);
  assert.equal(patched.deleteProfileAfterSuccess, true);
  const disabled = normalizeRoxyConfig({ deleteProfileAfterFailure: false }, enabled);
  assert.equal(disabled.deleteProfileAfterFailure, false);
  assert.equal(publicRoxyConfig(disabled).deleteProfileAfterFailure, false);
  assert.equal(disabled.deleteProfileAfterSuccess, true);
  for (const deleteProfileAfterFailure of ['true', 'false', 0, 1, null, [], {}]) {
    assert.throws(() => normalizeRoxyConfig({ deleteProfileAfterFailure }, config), codeIs('roxy_config_invalid'));
  }
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
    [json({ code: 500, msg: `浏览器窗口数量已达到套餐上限 ${config.apiKey}` }), 'roxy_profile_capacity'],
    [json({ code: 500, msg: `Profile limit reached ${config.apiKey}` }), 'roxy_profile_capacity'],
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

test('Roxy soft deletion explicitly sends a single profile to Trash and redacts provider errors', async () => {
  const calls = [];
  const client = createRoxyApiClient(config, { fetchImpl: async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method, headers: options.headers, body: JSON.parse(options.body) });
    return json({ code: 0, msg: 'success' });
  } });
  await client.softDeleteProfile('149202', 'profile_test');
  assert.deepEqual(calls, [{ path: '/browser/delete', method: 'POST',
    headers: { token: config.apiKey, 'content-type': 'application/json' },
    body: { workspaceId: '149202', dirIds: ['profile_test'], isSoftDelete: true } }]);
  await assert.rejects(() => client.softDeleteProfile('149202', ['one', 'two']), codeIs('roxy_config_invalid'));
  assert.equal(calls.length, 1);
  for (const fetchImpl of [
    async () => json({ code: 500, msg: config.apiKey }),
    async () => json({ msg: config.apiKey }, { status: 403 }),
    async () => { throw new Error(config.apiKey); },
  ]) {
    const failing = createRoxyApiClient(config, { fetchImpl });
    await assert.rejects(() => failing.softDeleteProfile('149202', 'profile_test'), codeIs('roxy_profile_delete_failed'));
  }
});

test('Roxy deletes only a closed tool profile after complete inventory and confirms its absence across all pages', async () => {
  for (const windowRemark of ['auto-team:child:child_test', 'auto-team:pool:0', 'auto-team:pool:1', 'auto-team:pool:2']) {
    const calls = [];
    let rows = [{ dirId: 'user_one', windowRemark: '' }, { dirId: 'profile_test', windowRemark }, { dirId: 'user_two', windowRemark: '' }];
    const client = {
      listProfiles: async (workspaceId, { pageIndex, pageSize }) => {
        assert.equal(workspaceId, config.workspaceId);
        assert.equal(pageSize, 100);
        calls.push(['list', pageIndex]);
        return { total: rows.length, rows: rows.slice(pageIndex - 1, pageIndex) };
      },
      connectionInfo: async (dirId) => { calls.push(['connections', dirId]); return []; },
      softDeleteProfile: async (workspaceId, dirId) => {
        calls.push(['delete', workspaceId, dirId]);
        rows = rows.filter((entry) => entry.dirId !== dirId);
      },
    };
    assert.deepEqual(await deleteClosedRoxyProfile(config, 'profile_test', { client }), { deleted: true });
    assert.deepEqual(calls, [['list', 1], ['list', 2], ['list', 3], ['connections', 'profile_test'],
      ['delete', config.workspaceId, 'profile_test'], ['list', 1], ['list', 2]]);
    assert.deepEqual(config.profiles, [{ childId: 'child_test', dirId: 'profile_test' }], 'remote cleanup does not mutate local JSON bindings');
  }
});

test('Roxy deletion is idempotent for an already absent environment and refuses manual or open environments', async () => {
  const client = {
    listProfiles: async () => ({ total: 0, rows: [] }),
    connectionInfo: async () => { assert.fail('unowned or absent environments must not be probed'); },
    softDeleteProfile: async () => { assert.fail('unowned, absent or busy environments must not be deleted'); },
  };
  assert.deepEqual(await deleteClosedRoxyProfile(config, 'profile_test', { client }), { deleted: false, absent: true });
  for (const windowRemark of ['', 'personal work', 'auto-team:pool:3', 'auto-team:child:', 'prefix auto-team:pool:0']) {
    await assert.rejects(() => deleteClosedRoxyProfile(config, 'profile_test', { client: {
      ...client, listProfiles: async () => ({ total: 1, rows: [{ dirId: 'profile_test', windowRemark }] }),
    } }), codeIs('roxy_profile_conflict'));
  }
  await assert.rejects(() => deleteClosedRoxyProfile(config, 'profile_test', { client: {
    ...client,
    listProfiles: async () => ({ total: 1, rows: [{ dirId: 'profile_test', windowRemark: 'auto-team:pool:0' }] }),
    connectionInfo: async () => [{ dirId: 'profile_test' }],
  } }), codeIs('roxy_profile_busy'));
});

test('Roxy never deletes from incomplete inventory or reports deletion without confirming a complete final inventory', async () => {
  const owned = { dirId: 'profile_test', windowRemark: 'auto-team:pool:0' };
  for (const scenario of ['incomplete_before', 'list_error', 'connection_error', 'incomplete_after', 'still_present', 'delete_error', 'verify_error']) {
    let deleted = false;
    const client = {
      listProfiles: async () => {
        if (scenario === 'list_error' || (deleted && scenario === 'verify_error')) throw new Error(config.apiKey);
        const incomplete = scenario === 'incomplete_before' || (deleted && scenario === 'incomplete_after');
        return { total: incomplete ? 2 : 1, rows: [owned] };
      },
      connectionInfo: async () => {
        if (scenario === 'connection_error') throw new Error(config.apiKey);
        return [];
      },
      softDeleteProfile: async () => {
        deleted = true;
        if (scenario === 'delete_error') throw new Error(config.apiKey);
      },
    };
    await assert.rejects(() => deleteClosedRoxyProfile(config, 'profile_test', { client }),
      codeIs(scenario === 'incomplete_before' ? 'roxy_profile_list_incomplete' : 'roxy_profile_delete_failed'));
    assert.equal(deleted, !['incomplete_before', 'list_error', 'connection_error'].includes(scenario));
  }
});

test('Roxy deletion respects an active local browser lease and prevents opening while cleanup is pending', async () => {
  const fake = fakeSession();
  const session = await openRoxyBrowserSession({ config, childId: 'child_test' }, fake);
  try {
    await assert.rejects(() => deleteClosedRoxyProfile(config, 'profile_test', { client: {
      listProfiles: async () => { assert.fail('active local sessions must not be inspected for deletion'); },
    } }), codeIs('roxy_profile_busy'));
  } finally { await session.close(); }

  let resolveDelete;
  let reachedDelete;
  let deleted = false;
  const deleting = new Promise((resolve) => { reachedDelete = resolve; });
  const pending = new Promise((resolve) => { resolveDelete = resolve; });
  const client = {
    listProfiles: async () => ({ total: deleted ? 0 : 1,
      rows: deleted ? [] : [{ dirId: 'profile_test', windowRemark: 'auto-team:pool:0' }] }),
    connectionInfo: async () => [],
    softDeleteProfile: async () => { reachedDelete(); await pending; deleted = true; },
  };
  const cleanup = deleteClosedRoxyProfile(config, 'profile_test', { client });
  await deleting;
  try {
    await assert.rejects(() => openRoxyBrowserSession({ config, childId: 'child_test' }, fakeSession()), codeIs('roxy_profile_busy'));
  } finally { resolveDelete(); }
  assert.deepEqual(await cleanup, { deleted: true });
  assert.deepEqual(await deleteClosedRoxyProfile(config, 'profile_test', { client }), { deleted: false, absent: true });
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
    childId: 'child_test', dirId: 'recovered_profile', source: 'recovered',
  });
  assert.deepEqual(pages, [1, 2, 1, 2], 'a deleted stored binding is repaired only after a complete remote search');
  assert.equal(created, 0);
});

test('Roxy validates every page before retaining a manual account binding without a tool marker', async () => {
  const pages = [];
  const profiles = [
    { dirId: 'unrelated', windowRemark: '' },
    { dirId: 'profile_test', windowRemark: 'manually selected environment' },
  ];
  const client = {
    listProfiles: async (_workspace, { pageIndex }) => {
      pages.push(pageIndex);
      return { total: profiles.length, rows: [profiles[pageIndex - 1]] };
    },
    createProfile: async () => { assert.fail('an existing manual binding must be retained'); },
  };
  const bound = { ...config, profiles: [{ ...config.profiles[0], proxyId: 'proxy_fixed' }] };
  assert.deepEqual(await resolveRoxyAccountProfile(bound, 'child_test', { client }), {
    ...bound.profiles[0], source: 'bound',
  });
  assert.deepEqual(pages, [1, 2]);
  await assert.rejects(() => resolveRoxyAccountProfile(bound, 'child_test', { client: {
    ...client,
    listProfiles: async () => ({ total: 2, rows: [profiles[1]] }),
  } }), codeIs('roxy_profile_list_incomplete'));
});

test('Roxy replaces deleted account bindings at the binding limit while preserving the fixed proxy', async () => {
  const full = { ...config, profiles: Array.from({ length: 1000 }, (_, index) => ({
    childId: `child_${index}`, dirId: `profile_${index}`, ...(index === 0 ? { proxyId: 'proxy_fixed' } : {}),
  })) };
  for (const recover of [true, false]) {
    let created = 0;
    const client = {
      listProfiles: async () => ({ total: recover ? 1 : 0, rows: recover
        ? [{ dirId: 'replacement', windowRemark: 'auto-team:child:child_0' }] : [] }),
      createProfile: async (_workspace, body) => {
        created += 1;
        assert.equal(body.windowRemark, 'auto-team:child:child_0');
        return { dirId: 'replacement' };
      },
    };
    assert.deepEqual(await resolveRoxyAccountProfile(full, 'child_0', { client }), {
      childId: 'child_0', dirId: 'replacement', proxyId: 'proxy_fixed', source: recover ? 'recovered' : 'created',
    });
    assert.equal(created, recover ? 0 : 1);
  }
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
  let time = 0;
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
  return { calls, client, connect, page, clock: () => time, wait: async (ms) => { time += ms; } };
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
  assert.deepEqual(fake.calls.slice(-4), ['page-close', 'disconnect', ['api-close', 'profile_test'], ['connections', 'profile_test']]);
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
  assert.deepEqual(fake.calls.slice(-4), ['page-close', 'disconnect', ['api-close', 'profile_test'], ['connections', 'profile_test']]);
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
    assert.deepEqual(fake.calls.slice(-2), [['api-close', 'profile_test'], ['connections', 'profile_test']]);
  }
  const failedCleanup = fakeSession({ cleanupFailure: new Error(config.apiKey) });
  const session = await openRoxyBrowserSession({ config, childId: 'child_test' }, failedCleanup);
  await assert.rejects(() => session.close(), codeIs('roxy_cleanup_failed'));
  const after = fakeSession();
  const retry = await openRoxyBrowserSession({ config, childId: 'child_test' }, after);
  await retry.close();
});

test('Roxy records an idle profile before failed startup but never claims an already-open profile', async () => {
  const failure = new RoxyBrowserError('roxy_api_timeout');
  const idle = fakeSession({ openFailure: failure });
  const acquired = [];
  await assert.rejects(() => openRoxyBrowserSession({ config, childId: 'child_test',
    onProfileAcquired: (dirId) => {
      acquired.push(dirId);
      assert.deepEqual(idle.calls, [['connections', 'profile_test']]);
    } }, idle), codeIs('roxy_api_timeout'));
  assert.deepEqual(acquired, ['profile_test']);
  const busy = fakeSession({ existing: [{ dirId: 'profile_test' }] });
  await assert.rejects(() => openRoxyBrowserSession({ config, childId: 'child_test',
    onProfileAcquired: () => assert.fail('An already-open profile belongs to another operation') }, busy), codeIs('roxy_profile_busy'));
  assert.equal(busy.calls.some((call) => Array.isArray(call) && ['api-close', 'open'].includes(call[0])), false);
});

test('Roxy startup waits for its websocket and page to become ready without opening another window', async () => {
  const fake = fakeSession();
  let attempts = 0;
  let discardedConnections = 0;
  const connect = async (options) => {
    attempts += 1;
    assert.equal(options.browserWSEndpoint, endpoint);
    if (attempts === 1) throw new Error('fixture: browser websocket not ready');
    if (attempts === 2) return {
      newPage: async () => { throw new Error('fixture: browser target not ready'); },
      disconnect: async () => { discardedConnections += 1; },
    };
    return fake.connect(options);
  };
  const session = await openRoxyBrowserSession({ config, childId: 'child_test' }, { ...fake, connect });
  assert.equal(session.page, fake.page);
  assert.equal(attempts, 3);
  assert.equal(discardedConnections, 1);
  assert.equal(fake.calls.filter((call) => call[0] === 'open').length, 1);
  assert.equal(fake.calls.some((call) => call[0] === 'api-close'), false);
  await session.close();
});

test('Roxy short websocket retries do not impose a five-second timeout on later OAuth navigation commands', async () => {
  const fake = fakeSession();
  const optionsSeen = [];
  const client = { ...fake.client, open: async (...args) => {
    await fake.wait(12000);
    return fake.client.open(...args);
  } };
  const session = await openRoxyBrowserSession({ config, childId: 'child_test', timeoutMs: 120000 }, {
    ...fake, client, connect: async (options) => {
      optionsSeen.push(options);
      if (optionsSeen.length === 1) throw new Error('fixture websocket still starting');
      return fake.connect(options);
    },
  });
  assert.deepEqual(optionsSeen.map(({ transportTimeout }) => transportTimeout), [5000, 5000]);
  assert.deepEqual(optionsSeen.map(({ protocolTimeout }) => protocolTimeout), [108000, 107500]);
  assert.ok(optionsSeen.at(-1).protocolTimeout > 60000, 'Page.navigate must retain the remaining OAuth budget');
  await session.close();

  const bounded = fakeSession();
  const longer = await openRoxyBrowserSession({ config, childId: 'child_test', timeoutMs: 999999 }, bounded);
  assert.equal(bounded.calls.find((call) => call[0] === 'connect')[1].protocolTimeout, 180000);
  await longer.close();
});

test('Roxy close shares one pending cleanup and holds the lease until its window has exited', async () => {
  const fake = fakeSession();
  let waiting;
  let reachedWait;
  const cleanupWaiting = new Promise((resolve) => { reachedWait = resolve; });
  let closing = false;
  let stillOpen = true;
  const client = { ...fake.client,
    close: async (dirId) => { closing = true; return fake.client.close(dirId); },
    connectionInfo: async () => closing && stillOpen ? [{ dirId: 'profile_test' }] : [],
  };
  const session = await openRoxyBrowserSession({ config, childId: 'child_test' }, {
    ...fake, client, wait: async () => { reachedWait(); await new Promise((resolve) => { waiting = resolve; }); },
  });
  const first = session.close();
  const second = session.close();
  assert.equal(first, second);
  await cleanupWaiting;
  const occupied = fakeSession();
  await assert.rejects(() => openRoxyBrowserSession({ config, childId: 'child_test' }, occupied), codeIs('roxy_profile_busy'));
  assert.deepEqual(occupied.calls, []);
  stillOpen = false;
  waiting();
  await Promise.all([first, second]);
  assert.equal(fake.calls.filter((call) => call[0] === 'api-close').length, 1);
  const next = await openRoxyBrowserSession({ config, childId: 'child_test' }, fakeSession());
  await next.close();
});

test('Roxy reports acknowledged closes that never release the window instead of reporting cleanup success', async () => {
  const fake = fakeSession();
  let closing = false;
  const session = await openRoxyBrowserSession({ config, childId: 'child_test' }, { ...fake, client: {
    ...fake.client,
    close: async () => { closing = true; },
    connectionInfo: async () => closing ? [{ dirId: 'profile_test' }] : [],
  } });
  await assert.rejects(session.close(), codeIs('roxy_cleanup_failed'));
  assert.equal(fake.clock(), 10000);
  await assert.rejects(session.close(), codeIs('roxy_cleanup_failed'));
  const busy = fakeSession({ existing: [{ dirId: 'profile_test' }] });
  await assert.rejects(() => openRoxyBrowserSession({ config, childId: 'child_test' }, busy), codeIs('roxy_profile_busy'));
  assert.equal(busy.calls.some((call) => call[0] === 'api-close'), false);
});

test('Roxy pooled configuration validates three independent slots and preserves mappings across mode switches', () => {
  const pooled = normalizeRoxyConfig({ profileMode: 'pooled', poolProfiles: [{ slot: 0, dirId: 'pool_a' }] }, config);
  assert.equal(pooled.poolSize, 3);
  assert.deepEqual(publicRoxyConfig(pooled).poolProfiles, [{ slot: 0, dirId: 'pool_a' }]);
  const dedicated = normalizeRoxyConfig({ profileMode: 'dedicated' }, pooled);
  assert.deepEqual(dedicated.poolProfiles, pooled.poolProfiles);
  assert.equal(dedicated.profileMode, 'dedicated');
  const smaller = normalizeRoxyConfig({ poolSize: 1, poolProfiles: [{ slot: 0, dirId: 'pool_a' }, { slot: 2, dirId: 'pool_c' }] }, pooled);
  assert.equal(smaller.poolSize, 1);
  assert.equal(smaller.poolProfiles.length, 2, 'shrinking the active pool preserves idle slot mappings');
  for (const patch of [
    { profileMode: 'shared' }, { poolSize: 4 }, { poolSize: 0 }, { poolSize: '3' },
    { profileMode: null }, { poolSize: null }, { poolProfiles: null },
    { poolProfiles: [{ slot: 3, dirId: 'invalid' }] }, { poolProfiles: [{ slot: 0, dirId: 'bad/id' }] },
  ]) assert.throws(() => normalizeRoxyConfig(patch, config), codeIs('roxy_config_invalid'));
  for (const poolProfiles of [
    [{ slot: 0, dirId: 'a' }, { slot: 0, dirId: 'b' }],
    [{ slot: 0, dirId: 'a' }, { slot: 1, dirId: 'a' }],
  ]) assert.throws(() => normalizeRoxyConfig({ poolProfiles }, config), codeIs('roxy_profile_conflict'));
});

test('Roxy pool recovers deleted bindings and reuses only idle tool profiles without exceeding three slots', async () => {
  const profiles = [
    { dirId: 'user_profile', windowRemark: 'personal work' },
    { dirId: 'occupied', windowRemark: 'auto-team:child:occupied_child' },
    { dirId: 'slot_other', windowRemark: 'auto-team:child:reserved_child' },
    { dirId: 'tool_old', windowRemark: 'auto-team:child:previous_child' },
  ];
  const pooled = { ...config, profileMode: 'pooled', poolSize: 3, poolProfiles: [
    { slot: 0, dirId: 'deleted_profile' }, { slot: 1, dirId: 'slot_other' },
  ] };
  const listedPages = [];
  const checked = [];
  let created = 0;
  const client = {
    listProfiles: async (_workspace, { pageIndex }) => {
      listedPages.push(pageIndex);
      return { total: profiles.length, rows: profiles.slice((pageIndex - 1) * 2, pageIndex * 2) };
    },
    connectionInfo: async (dirId) => { checked.push(dirId); return dirId === 'occupied' ? [{ dirId }] : []; },
    createProfile: async () => { created += 1; return { dirId: 'created' }; },
  };
  assert.deepEqual(await resolveRoxyPoolProfile(pooled, 0, { client }), { slot: 0, dirId: 'tool_old', source: 'reused' });
  assert.deepEqual(listedPages, [1, 2]);
  assert.deepEqual(checked, ['occupied', 'tool_old']);
  assert.equal(created, 0);
  await assert.rejects(() => resolveRoxyPoolProfile(pooled, 3, { client }), codeIs('roxy_config_invalid'));
});

test('Roxy pool binds or recovers exact slot markers and never takes over a user window', async () => {
  const pooled = { ...config, profileMode: 'pooled', poolSize: 3, poolProfiles: [{ slot: 0, dirId: 'pool_a' }] };
  const client = {
    listProfiles: async () => ({ total: 1, rows: [{ dirId: 'pool_a', windowRemark: 'auto-team:pool:0' }] }),
    connectionInfo: async () => [],
    createProfile: async () => { assert.fail('existing pool profile must be recovered'); },
  };
  assert.deepEqual(await resolveRoxyPoolProfile(pooled, 0, { client }), { slot: 0, dirId: 'pool_a', source: 'bound' });
  assert.deepEqual(await resolveRoxyPoolProfile({ ...pooled, poolProfiles: [] }, 0, { client }), { slot: 0, dirId: 'pool_a', source: 'recovered' });
  await assert.rejects(() => resolveRoxyPoolProfile(pooled, 0, { client: {
    ...client, connectionInfo: async () => [{ dirId: 'pool_a' }],
  } }), codeIs('roxy_profile_busy'));
  await assert.rejects(() => resolveRoxyPoolProfile(pooled, 0, { client: {
    ...client, listProfiles: async () => ({ total: 1, rows: [{ dirId: 'pool_a', windowRemark: 'unrelated user environment' }] }),
  } }), codeIs('roxy_profile_conflict'));
  await assert.rejects(() => resolveRoxyPoolProfile({ ...pooled, poolProfiles: [] }, 0, { client: {
    ...client, listProfiles: async () => ({ total: 1, rows: [] }),
  } }), codeIs('roxy_profile_list_incomplete'));
});

test('Roxy pool creates only a missing slot with a stable marker and rejects duplicate directory responses', async () => {
  const pooled = { ...config, profileMode: 'pooled', poolSize: 3, poolProfiles: [{ slot: 0, dirId: 'reserved' }] };
  const client = {
    listProfiles: async () => ({ total: 1, rows: [{ dirId: 'reserved', windowRemark: 'auto-team:pool:0' }] }),
    createProfile: async (workspace, body) => {
      assert.equal(workspace, config.workspaceId);
      assert.deepEqual(body, { windowName: 'AutoTeam 授权环境 2', windowRemark: 'auto-team:pool:1' });
      return { dirId: 'new_slot' };
    },
  };
  assert.deepEqual(await resolveRoxyPoolProfile(pooled, 1, { client }), { slot: 1, dirId: 'new_slot', source: 'created' });
  await assert.rejects(() => resolveRoxyPoolProfile(pooled, 1, { client: {
    ...client, createProfile: async () => ({ dirId: 'reserved' }),
  } }), codeIs('roxy_profile_conflict'));
});

test('Roxy pool reuses idle orphaned pool markers while preserving other slot reservations', async () => {
  const pooled = { ...config, profileMode: 'pooled', poolSize: 3, poolProfiles: [
    { slot: 0, dirId: 'deleted' }, { slot: 1, dirId: 'reserved' },
  ] };
  const checked = [];
  const rows = [
    { dirId: 'user_profile', windowRemark: 'personal work' },
    { dirId: 'reserved', windowRemark: 'auto-team:pool:1' },
    { dirId: 'orphaned', windowRemark: 'auto-team:pool:2' },
  ];
  const client = {
    listProfiles: async () => ({ total: rows.length, rows }),
    connectionInfo: async (dirId) => { checked.push(dirId); return []; },
    createProfile: async () => { assert.fail('reuse the idle tool environment before creating'); },
  };
  assert.deepEqual(await resolveRoxyPoolProfile(pooled, 0, { client }), { slot: 0, dirId: 'orphaned', source: 'reused' });
  assert.deepEqual(checked, ['orphaned'], 'user environments and reserved tool environments are not probed or reused');
});

test('Roxy pool ignores an old slot marker after its environment was reserved by another slot', async () => {
  const pooled = { ...config, profileMode: 'pooled', poolSize: 3, poolProfiles: [
    { slot: 0, dirId: 'migrated' }, { slot: 1, dirId: 'reserved' },
  ] };
  const rows = [
    { dirId: 'migrated', windowRemark: 'auto-team:pool:2' },
    { dirId: 'reserved', windowRemark: 'auto-team:pool:1' },
  ];
  const client = {
    listProfiles: async () => ({ total: rows.length, rows }),
    connectionInfo: async () => { assert.fail('reserved environments must not be probed'); },
    createProfile: async (_workspace, body) => {
      assert.equal(body.windowRemark, 'auto-team:pool:2');
      return { dirId: 'new_slot' };
    },
  };
  assert.deepEqual(await resolveRoxyPoolProfile(pooled, 2, { client }), { slot: 2, dirId: 'new_slot', source: 'created' });
});

test('Roxy pool reclaims idle inactive slots after shrinking while preserving active slot reservations', async () => {
  const rows = [
    { dirId: 'slot_one', windowRemark: 'auto-team:pool:1' },
    { dirId: 'slot_two', windowRemark: 'auto-team:pool:2' },
  ];
  for (const [poolSize, busy, expected, checkedIds] of [
    [1, '', 'slot_one', ['slot_one']],
    [1, 'slot_one', 'slot_two', ['slot_one', 'slot_two']],
    [2, '', 'slot_two', ['slot_two']],
  ]) {
    const pooled = { ...config, profileMode: 'pooled', poolSize, poolProfiles: [
      { slot: 0, dirId: 'deleted' }, { slot: 1, dirId: 'slot_one' }, { slot: 2, dirId: 'slot_two' },
    ] };
    const checked = [];
    const client = {
      listProfiles: async () => ({ total: rows.length, rows }),
      connectionInfo: async (dirId) => { checked.push(dirId); return dirId === busy ? [{ dirId }] : []; },
      createProfile: async () => { assert.fail('inactive idle tool environments must be reused after shrinking'); },
    };
    assert.deepEqual(await resolveRoxyPoolProfile(pooled, 0, { client }), { slot: 0, dirId: expected, source: 'reused' });
    assert.deepEqual(checked, checkedIds);
    assert.equal(pooled.poolProfiles.length, 3, 'resolution leaves persistence of replacement mappings to its caller');
  }
});

test('Roxy pool does not create beyond its size when existing tool environments are busy', async () => {
  for (const poolSize of [1, 2, 3]) {
    const pooled = { ...config, profileMode: 'pooled', poolSize, poolProfiles: [{ slot: 0, dirId: 'deleted' }] };
    const rows = Array.from({ length: poolSize }, (_, index) => ({
      dirId: `busy_${index}`, windowRemark: index === 2 ? 'auto-team:pool:2' : `auto-team:child:old_${index}`,
    }));
    const checked = [];
    const client = {
      listProfiles: async () => ({ total: rows.length, rows }),
      connectionInfo: async (dirId) => { checked.push(dirId); return [{ dirId }]; },
      createProfile: async () => { assert.fail('busy environments still consume the configured pool capacity'); },
    };
    await assert.rejects(() => resolveRoxyPoolProfile(pooled, 0, { client }), codeIs('roxy_profile_busy'));
    assert.deepEqual(checked, rows.map(({ dirId }) => dirId));
  }
});

test('Roxy pool can fill remaining capacity while another tool environment is busy', async () => {
  const pooled = { ...config, profileMode: 'pooled', poolSize: 2, poolProfiles: [] };
  const rows = [
    { dirId: 'user_profile', windowRemark: 'personal work' },
    { dirId: 'busy', windowRemark: 'auto-team:child:old' },
  ];
  const client = {
    listProfiles: async () => ({ total: rows.length, rows }),
    connectionInfo: async (dirId) => { assert.equal(dirId, 'busy'); return [{ dirId }]; },
    createProfile: async () => ({ dirId: 'new_slot' }),
  };
  assert.deepEqual(await resolveRoxyPoolProfile(pooled, 0, { client }), { slot: 0, dirId: 'new_slot', source: 'created' });
});

test('Roxy pooled accounts use fresh browser contexts and always release their window even after failure', async () => {
  const pooled = { ...config, profileMode: 'pooled', poolSize: 3, poolProfiles: [{ slot: 0, dirId: 'pool_a' }], profiles: [] };
  let createdContexts = 0;
  let closedContexts = 0;
  const contextIds = [];
  for (const childId of ['account_a', 'account_b']) {
    const fake = fakeSession();
    const session = await openRoxyBrowserSession({ config: pooled, childId, profile: { dirId: 'pool_a' } }, {
      ...fake, connect: async () => ({
        createBrowserContext: async () => {
          const id = ++createdContexts;
          return { newPage: async () => ({ contextId: id }), close: async () => { closedContexts += 1; } };
        },
        newPage: async () => { assert.fail('pooled login must not use the persistent profile context'); },
        disconnect: async () => {},
      }),
    });
    assert.equal(session.keepOpenOnFailure, false);
    contextIds.push(session.page.contextId);
    await session.close({ keepOpen: true });
    assert.equal(fake.calls.filter((call) => call[0] === 'api-close' && call[1] === 'pool_a').length, 1);
  }
  assert.deepEqual(contextIds, [1, 2]);
  assert.equal(closedContexts, 2);
  await assert.rejects(() => openRoxyBrowserSession({ config: pooled, childId: 'a', profile: { dirId: 'unrelated' } }, fakeSession()), codeIs('roxy_profile_missing'));
});

function fakePooledSession() {
  const fake = fakeSession();
  const authenticated = [];
  const page = { authenticate: async (credentials) => { authenticated.push(credentials); } };
  const context = { newPage: async () => page, close: async () => { fake.calls.push('context-close'); } };
  return { ...fake, page, authenticated, connect: async (options) => ({
    ...await fake.connect(options), createBrowserContext: async () => context,
  }) };
}

const pooledProxyConfig = { ...config, profileMode: 'pooled', useProxyPool: true,
  poolSize: 3, poolProfiles: [{ slot: 0, dirId: 'pool_a' }], profiles: [] };

test('Roxy isolated HTTP proxy login authenticates before returning its page and decodes proxy credentials', async () => {
  for (const url of ['http://fixture%40user:p%3Ass@proxy.example.test:8080', 'https://fixture%40user:p%3Ass@proxy.example.test:8080']) {
    const fake = fakePooledSession();
    const session = await openRoxyBrowserSession({ config: pooledProxyConfig, childId: 'a',
      profile: { dirId: 'pool_a', proxyId: 'proxy_a' }, proxyEntry: { id: 'proxy_a', url },
    }, fake);
    assert.equal(session.page, fake.page);
    assert.deepEqual(fake.authenticated, [{ username: 'fixture@user', password: 'p:ss' }]);
    assert.equal(Object.keys(session).some((key) => /credential|proxy|password/i.test(key)), false);
    await session.close();
  }
});

test('Roxy isolated chained proxy login uses relay credentials instead of the upstream account credentials', async () => {
  const fake = fakePooledSession();
  let relayClosed = false;
  const relayUrl = 'http://chain:relay%3Asecret@127.0.0.1:51000';
  const session = await openRoxyBrowserSession({ config: pooledProxyConfig, childId: 'a',
    profile: { dirId: 'pool_a', proxyId: 'proxy_a' }, localProxyUrl: 'http://127.0.0.1:7897',
    proxyEntry: { id: 'proxy_a', url: 'socks5h://upstream-user:upstream-secret@upstream.example.test:1080' },
  }, { ...fake, createRelay: async () => ({ url: relayUrl, close: async () => { relayClosed = true; } }) });
  assert.deepEqual(fake.authenticated, [{ username: 'chain', password: 'relay:secret' }]);
  assert.equal(fake.calls.find((call) => call[0] === 'proxy')[3].url, relayUrl);
  await session.close();
  assert.equal(relayClosed, true);
});

test('Roxy does not send SOCKS credentials as HTTP authentication or authenticate a credential-free proxy', async () => {
  for (const url of ['http://proxy.example.test:8080', 'socks5h://socks-user:socks-secret@proxy.example.test:1080']) {
    const fake = fakePooledSession();
    const session = await openRoxyBrowserSession({ config: pooledProxyConfig, childId: 'a',
      profile: { dirId: 'pool_a' }, proxyEntry: { url },
    }, fake);
    assert.deepEqual(fake.authenticated, []);
    await session.close();
  }
});

test('Roxy proxy-auth initialization failure is redacted and releases only the owned context, window and relay', async () => {
  const fake = fakePooledSession();
  fake.page.authenticate = async () => { throw new Error('fixture-proxy-password-must-never-escape'); };
  let relayClosed = false;
  await assert.rejects(() => openRoxyBrowserSession({ config: pooledProxyConfig, childId: 'a',
    profile: { dirId: 'pool_a' }, localProxyUrl: 'http://127.0.0.1:7897',
    proxyEntry: { url: 'socks5h://upstream-user:upstream-secret@upstream.example.test:1080' },
  }, { ...fake, createRelay: async () => ({ url: 'http://chain:fixture-proxy-password-must-never-escape@127.0.0.1:51000',
    close: async () => { relayClosed = true; } }) }), (error) => codeIs('roxy_proxy_auth_failed')(error)
      && !error.message.includes('fixture-proxy-password-must-never-escape'));
  assert.equal(fake.calls.filter((call) => call === 'context-close').length, 1);
  assert.equal(fake.calls.filter((call) => call[0] === 'api-close' && call[1] === 'pool_a').length, 1);
  assert.equal(relayClosed, true);
});
