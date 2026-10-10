import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openRoxyBrowserSession } from './roxy-browser.mjs';

const serverScript = fileURLToPath(new URL('./index.mjs', import.meta.url));
const roxyModule = new URL('./roxy-browser.mjs', import.meta.url).href;
const proxyChainModule = new URL('./proxy-chain.mjs', import.meta.url).href;
const puppeteerModule = import.meta.resolve('puppeteer-core');
const dataKey = 'isolated-roxy-state-encryption-key';
const secret = 'private-roxy-fixture-api-key';
const children = [
  { id: 'child_alpha', email: 'alpha@example.test', password: 'private-alpha-password' },
  { id: 'child_beta', email: 'beta@example.test', password: 'private-beta-password' },
];

function oauthToken(child, workspaceId = `personal-${child.id}`, plan = 'free') {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ sub: child.id, exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: workspaceId, chatgpt_plan_type: plan },
    'https://api.openai.com/profile': { email: child.email },
  })).toString('base64url');
  return { access_token: `${header}.${claims}.private-fixture-signature`,
    refresh_token: `private-fixture-rt-${child.id}`, expires_in: 3600 };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t, { apiFailure = null, browserFlow = false, teamFlow = false, occupiedProfile = false, sentinelChallenge = false,
  priorFields = {}, browserVerification = false, passwordFailure = null, proxyFlow = false, holdBrowser = false,
  accountId = 'child_alpha', createFailure = null, chainFlow = false, concurrentAccounts = null, failBrowserFor = [], cleanupFailureFor = [], connectFailureFor = [], holdQuotaFor = [], holdOpenFor = [], timeoutBeforeSessionFor = [] } = {}) {
  const workspaceId = 'target_team_workspace';
  const allChildren = concurrentAccounts || children;
  const account = allChildren.find((child) => child.id === accountId);
  let protocolState = '';
  const mothers = teamFlow ? [{ id: 'fixture_mother', email: 'owner@example.test', accountId: workspaceId,
    accessToken: oauthToken({ id: 'owner', email: 'owner@example.test' }, workspaceId, 'team').access_token }] : [];
  const requests = [];
  const profiles = [{ dirId: 'roxy_profile_a', windowName: 'Fixture profile', windowSortNum: 1 }];
  let releaseBrowser;
  const heldBrowsers = new Map();
  const heldQuotas = new Map();
  const heldOpens = new Map();
  const openedProfiles = new Set();
  const removedMembers = new Set();
  let browserPeak = 0;
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (proxyFlow && ['/api/oauth/oauth2/token', '/oauth/token'].includes(url.pathname)) url.pathname = '/fixture/token';
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: req.method,
      token: req.headers.token, proxyAuth: req.headers['proxy-authorization'], body: Buffer.concat(chunks).toString() });
    if (url.pathname === '/fixture/browser-held') {
      await new Promise((resolve) => {
        releaseBrowser = resolve;
        heldBrowsers.set(url.searchParams.get('email') || account.email, resolve);
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (url.pathname === '/backend-api/wham/usage' && holdQuotaFor.length) {
      const payload = String(req.headers.authorization || '').split('.')[1];
      const subject = payload ? JSON.parse(Buffer.from(payload, 'base64url')).sub : '';
      if (holdQuotaFor.includes(subject)) await new Promise((resolve) => heldQuotas.set(subject, resolve));
    }
    if (url.pathname === '/browser/open') {
      const dirId = JSON.parse(Buffer.concat(chunks).toString()).dirId;
      openedProfiles.add(dirId);
      browserPeak = Math.max(browserPeak, openedProfiles.size);
      if (holdOpenFor.includes(dirId)) await new Promise((resolve) => heldOpens.set(dirId, resolve));
    }
    if (url.pathname === '/browser/close') {
      const dirId = JSON.parse(Buffer.concat(chunks).toString()).dirId;
      if (!cleanupFailureFor.includes(dirId)) openedProfiles.delete(dirId);
      else {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: -1, msg: 'fixture close failed' }));
      }
    }
    if (req.method === 'DELETE' && url.pathname.startsWith(`/backend-api/accounts/${workspaceId}/users/`)) {
      removedMembers.add(decodeURIComponent(url.pathname.split('/').pop()));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    }
    if (url.pathname === '/browser/create') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (createFailure) return res.end(JSON.stringify(createFailure));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const created = { dirId: `created_profile_${profiles.length}`, windowName: body.windowName, windowRemark: body.windowRemark };
      profiles.push(created);
      return res.end(JSON.stringify({ code: 0, data: { dirId: created.dirId } }));
    }
    if (browserFlow && url.pathname === '/oauth/authorize') {
      protocolState = url.searchParams.get('state');
      res.writeHead(302, { location: 'https://auth.openai.com/log-in' });
      return res.end();
    }
    if (browserFlow && ['/log-in', '/workspace', '/fixture/sentinel', '/api/accounts/authorize/continue',
      '/api/accounts/password/verify', '/sign-in-with-chatgpt/codex/consent', '/api/accounts/workspace/select'].includes(url.pathname)) {
      if (url.pathname === '/api/accounts/password/verify' && passwordFailure) {
        res.writeHead(passwordFailure.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: passwordFailure.code || 'fixture_verification_required',
          message: `private-upstream-error ${secret} ${account.password} private-fixture-rt-child_alpha` } }));
      }
      const payload = url.pathname === '/fixture/sentinel' ? { token: 'fixture-sentinel-token',
        ...(sentinelChallenge ? { turnstile: { dx: 'fixture-required-verification' } } : {}) }
        : url.pathname === '/api/accounts/authorize/continue' ? { continue_url: 'https://auth.openai.com/log-in/password' }
          : url.pathname === '/api/accounts/password/verify' ? { continue_url: 'https://auth.openai.com/workspace' }
            : url.pathname === '/api/accounts/workspace/select' ? { continue_url: `http://localhost:1455/auth/callback?code=fixture-automatic-code&state=${protocolState}` }
              : {};
      const workspaceCookie = Buffer.from(JSON.stringify({ workspaces: [
        { id: workspaceId, kind: 'team' }, { id: `personal-${account.id}`, kind: 'personal' },
      ] })).toString('base64url');
      res.writeHead(200, { 'content-type': 'application/json', ...(url.pathname === '/sign-in-with-chatgpt/codex/consent'
        ? { 'set-cookie': `oai-client-auth-session=${workspaceCookie}.signature; Path=/; Secure; HttpOnly` } : {}) });
      return res.end(JSON.stringify(payload));
    }
    res.writeHead(apiFailure?.status || 200, { 'content-type': 'application/json' });
    if (apiFailure) return res.end(JSON.stringify({ code: apiFailure.code ?? -1,
      msg: `private-upstream-error ${secret} http://private-user:private-password@remote.example.test`, data: null }));
    const recognized = ['/health', '/browser/workspace', '/browser/list_v3', '/browser/connection_info',
      '/browser/open', '/browser/close', '/browser/mdf', '/fixture/browser-options', '/fixture/browser-launch', '/fixture/browser-connect', '/fixture/token', '/fixture/chain-create', '/fixture/chain-close',
      `/backend-api/accounts/${workspaceId}/users`, '/backend-api/wham/usage'].includes(url.pathname);
    const data = url.pathname === '/health' ? { running: true }
      : url.pathname === '/browser/workspace' ? { total: 1, rows: [{ id: 'roxy_workspace_a', workspaceName: 'Fixture team' }] }
        : url.pathname === '/browser/list_v3' ? { total: profiles.length, rows: profiles }
          : url.pathname === '/browser/connection_info' ? (occupiedProfile ? [{ dirId: 'roxy_profile_a' }] : [...openedProfiles].map((dirId) => ({ dirId })))
            : url.pathname === '/browser/open' ? { ws: `ws://127.0.0.1:${serverPort}/devtools/browser/fixture` }
              : url.pathname === '/fixture/token' ? oauthToken(concurrentAccounts
                ? allChildren.find((child) => new URLSearchParams(Buffer.concat(chunks).toString()).get('code') === `fixture-automatic-code-${child.email}`) || account : account,
                teamFlow ? workspaceId : undefined, teamFlow ? 'team' : 'free')
                : url.pathname === `/backend-api/accounts/${workspaceId}/users` ? { total: 1 + (concurrentAccounts || [account]).filter((child) => !removedMembers.has(child.id)).length, items: [
                  { id: 'owner', email: 'owner@example.test', role: 'account-owner', seat_type: 'default' },
                  ...(concurrentAccounts || [account]).filter((child) => !removedMembers.has(child.id)).map((child) => ({ id: child.id, email: child.email, role: 'standard-user', seat_type: 'default' })),
                ] }
                  : url.pathname === '/backend-api/wham/usage' ? { rate_limit: {
                    primary_window: { used_percent: 25, limit_window_seconds: 18000 },
                    secondary_window: { used_percent: 10, limit_window_seconds: 604800 },
                  } }
          : null;
    // OAuth and usage mocks return their normal domain shape; the Local API
    // always retains its documented code/data envelope.
    if (url.pathname === '/fixture/token' || url.pathname.startsWith('/backend-api/')) return res.end(JSON.stringify(data));
    res.end(JSON.stringify({ code: recognized ? 0 : -1, msg: recognized ? 'ok' : 'unexpected fixture endpoint', data }));
  });
  const roxyPort = await listen(upstream);
  const serverPort = roxyPort;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'roxy-integration-'));
  const port = await unusedPort();
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1, settings: { autoRefill: false, integrations: {
      mailbox: { enabled: false, serviceType: 'manual', endpoint: 'http://mailbox.example.test', apiKey: 'private-mailbox-key' },
      sub2apis: [{ id: 'fixture-sub2api', name: 'Fixture Sub2API', enabled: false,
        baseUrl: 'http://sub2api.example.test', apiKey: 'private-sub2api-key', groupId: 7 }],
    } }, children: allChildren.map((child) => child.id === account.id || concurrentAccounts
      ? { ...child, ...(teamFlow ? { team: workspaceId } : {}), ...priorFields }
      : child), mothers, history: [],
  }));
  // Only the fixture API may receive network calls. A mistaken automatic
  // login cannot launch Chromium or reach an official authentication service.
  const preload = `
    ${browserFlow ? `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === './openai-browser-login.mjs') return { url: 'fixture:roxy-browser-flow', shortCircuit: true };
      if (specifier === './roxy-browser.mjs') return { url: 'fixture:roxy-session', shortCircuit: true };
      if (${chainFlow} && specifier === './proxy-chain.mjs') return { url: 'fixture:proxy-chain', shortCircuit: true };
      return nextResolve(specifier, context);
    }, load(url, context, nextLoad) {
      if (url === 'fixture:proxy-chain') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
        export * from ${JSON.stringify(proxyChainModule)};
        export async function createProxyChainRelay(options) {
          await fetch(${JSON.stringify(`http://127.0.0.1:${roxyPort}/fixture/chain-create`)}, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options),
          });
          return { url: ${JSON.stringify(`http://fixture-chain:private-relay@127.0.0.1:${roxyPort}`)},
            close: async () => { await fetch(${JSON.stringify(`http://127.0.0.1:${roxyPort}/fixture/chain-close`)}, { method: 'POST' }); },
          };
        }
      `)} };
      if (url === 'fixture:roxy-session') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
        export * from ${JSON.stringify(roxyModule)};
        import { openRoxyBrowserSession as actualOpen } from ${JSON.stringify(roxyModule)};
        export function openRoxyBrowserSession(options) {
          return actualOpen(options, { connect: async () => {
            if (${JSON.stringify(connectFailureFor)}.includes(options.childId)) throw new Error('fixture connection failed');
            return {
            newPage: async () => ({ close: async () => {} }), disconnect: async () => {},
          }; } });
        }
      `)} };
      if (url === 'fixture:roxy-browser-flow') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
        export async function completeBrowserOAuth(options) {
          if (typeof options.acquireSession !== 'function') throw Object.assign(new Error('fixture Chrome disabled'), { code: 'fixture_chrome_disabled', status: 409 });
          await fetch(${JSON.stringify(`http://127.0.0.1:${roxyPort}/fixture/browser-options`)}, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
              email: options.email, workspaceId: options.workspaceId, workspaceMode: options.workspaceMode,
              stateMatches: new URL(options.authUrl).searchParams.get('state') === options.expectedState,
            }),
          });
          options.onProgress('roxy_start', 'fixture');
          const acquiring = options.acquireSession({ timeoutMs: 1000 });
          if (${JSON.stringify(timeoutBeforeSessionFor)}.includes(options.email)) {
            void acquiring.catch(() => {});
            throw Object.assign(new Error('fixture timeout while opening'), { code: 'browser_oauth_timeout', status: 408, browserRequired: true });
          }
          const session = await acquiring;
          try {
            if (${holdBrowser}) await fetch(${JSON.stringify(`http://127.0.0.1:${roxyPort}/fixture/browser-held`)} + '?email=' + encodeURIComponent(options.email));
            if (${browserVerification} || ${JSON.stringify(failBrowserFor)}.includes(options.email)) throw Object.assign(new Error('fixture official verification required'), {
              code: 'browser_verification_required', status: 403, browserRequired: true, needsInput: true,
            });
            const callback = new URL(options.redirectUri);
            callback.searchParams.set('state', options.expectedState);
            callback.searchParams.set('code', ${concurrentAccounts !== null} ? 'fixture-automatic-code-' + options.email : 'fixture-automatic-code');
            return { callbackUrl: callback.toString() };
          } finally { await session.close({ keepOpen: session.keepOpenOnFailure === true && ${JSON.stringify(failBrowserFor)}.includes(options.email) }); }
        }
      `)} };
      return nextLoad(url, context);
    } });
    ` : ''}
    ${proxyFlow ? `
    import http from 'node:http';
    import https from 'node:https';
    import { syncBuiltinESMExports } from 'node:module';
    // Exercise the actual proxy transport, but never tunnel TLS or connect to
    // an official host: the loopback fixture is the only HTTP proxy endpoint.
    https.request = (input, options, callback) => {
      const url = new URL(input);
      if (!['auth.openai.com', 'sentinel.openai.com'].includes(url.hostname) || !options?.agent) {
        throw new Error('isolated_roxy_https_network_disabled');
      }
      return http.request('http://isolated-auth.invalid' + url.pathname + url.search, options, callback);
    };
    syncBuiltinESMExports();
    ` : ''}
    import puppeteer from ${JSON.stringify(puppeteerModule)};
    puppeteer.launch = async () => {
      await fetch(${JSON.stringify(`http://127.0.0.1:${roxyPort}/fixture/browser-launch`)}, { method: 'POST' });
      throw new Error('isolated_roxy_browser_disabled');
    };
    puppeteer.connect = async () => {
      await fetch(${JSON.stringify(`http://127.0.0.1:${roxyPort}/fixture/browser-connect`)}, { method: 'POST' });
      throw new Error('isolated_roxy_browser_disabled');
    };
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (${browserFlow} && url.hostname === 'auth.openai.com') {
        const pathname = ['/api/oauth/oauth2/token', '/oauth/token'].includes(url.pathname) ? '/fixture/token' : url.pathname;
        return nativeFetch(${JSON.stringify(`http://127.0.0.1:${roxyPort}`)} + pathname + url.search, options);
      }
      if (${browserFlow} && url.hostname === 'sentinel.openai.com') return nativeFetch(${JSON.stringify(`http://127.0.0.1:${roxyPort}/fixture/sentinel`)}, options);
      if (url.hostname !== '127.0.0.1' || Number(url.port) !== ${roxyPort}) throw new Error('isolated_roxy_external_network_disabled');
      return nativeFetch(input, options);
    };
  `;
  const app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), TEAM_ROTATION_DATA_DIR: dataDir,
      TEAM_ROTATION_DATA_KEY: dataKey, TEAM_ROTATION_API_TOKEN: '', TEAM_ROTATION_LOGIN_PASSWORD: 'isolated-roxy-password',
      CHATGPT_BASE_URL: `http://127.0.0.1:${roxyPort}`,
      DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk; });
  app.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    releaseBrowser?.();
    for (const release of heldBrowsers.values()) release();
    for (const release of heldQuotas.values()) release();
    for (const release of heldOpens.values()) release();
    if (app.exitCode === null && app.signalCode === null) {
      const stopped = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await stopped;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(dataDir), path.resolve(tmpdir()));
    assert.match(path.basename(dataDir), /^roxy-integration-/);
    await rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`fixture server exited: ${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the isolated application to listen. */ }
    await delay(25);
  }
  assert.equal(ready, true, output);
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'isolated-roxy-password' }), signal: AbortSignal.timeout(5000) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const config = { enabled: true, baseUrl: `http://127.0.0.1:${roxyPort}`, apiKey: secret,
    workspaceId: 'roxy_workspace_a', profiles: [{ childId: 'child_alpha', dirId: 'roxy_profile_a' }] };
  async function request(route, { method = 'GET', body, authenticated = true } = {}) {
    const response = await fetch(`${baseUrl}${route}`, { method,
      headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, data: await response.json() };
  }
  async function patch(roxy, extra = {}) { return request('/api/integrations', { method: 'PATCH', body: { ...extra, roxy } }); }
  async function saved() {
    const raw = await readFile(path.join(dataDir, 'state.json'), 'utf8');
    const envelope = JSON.parse(raw);
    if (!envelope.encrypted) return { raw, envelope, state: envelope };
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(dataKey).digest(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString());
    return { raw, envelope, state };
  }
  async function waitJob(id) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await request(`/api/children/auto-json/${id}`);
      assert.equal(status.status, 200);
      if (status.data.job.status === 'complete') return status.data.job;
      await delay(20);
    }
    throw new Error('isolated Roxy automatic JSON task did not finish');
  }
  async function runJob(body) {
    const started = await request('/api/children/auto-json', { method: 'POST', body });
    assert.equal(started.status, 202, JSON.stringify(started.data));
    return waitJob(started.data.job.id);
  }
  async function addProxies({ enabled = true } = {}) {
    const added = await request('/api/proxy/entries', { method: 'POST', body: { values: ['alpha', 'beta', 'gamma'].map(
      (name) => `http://fixture-proxy-${name}:private-proxy-password@127.0.0.1:${roxyPort}`) } });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    assert.equal(added.data.added.length, 3);
    const updated = await request('/api/proxy', { method: 'PATCH', body: { enabled, strategy: 'round_robin', maxRetries: 2 } });
    assert.equal(updated.status, 200);
    return added.data.added;
  }
  async function waitBrowser() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (releaseBrowser) return;
      await delay(20);
    }
    throw new Error('isolated Roxy browser did not reach the held authorization stage');
  }
  return { request, patch, config, saved, requests, runJob, waitJob, addProxies, waitBrowser,
    heldBrowsers, heldQuotas, heldOpens, openedProfiles, browserPeak: () => browserPeak,
    releaseAccount: (email) => { heldBrowsers.get(email)?.(); heldBrowsers.delete(email); },
    releaseBrowser: () => releaseBrowser?.(), workspaceId, output: () => output };
}

function assertNoSecrets(value) {
  assert.doesNotMatch(JSON.stringify(value), /private-roxy|private-upstream|private-user|private-password|private-proxy|private-mailbox|private-sub2api|private-alpha-password|private-fixture-(?:rt|signature)|private-(?:old|callback)-(?:verifier|code)/);
}

const parallelChildren = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((name) => ({
  id: `child_${name}`, email: `${name}@example.test`, password: `private-${name}-password`,
}));
async function waitForFixture(condition, description) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail(description);
}
async function configureParallel(app, accounts, concurrency) {
  const result = await app.patch({ ...app.config, concurrency,
    profiles: accounts.map((child) => ({ childId: child.id, dirId: `profile_${child.id}` })) });
  assert.equal(result.status, 200, JSON.stringify(result.data));
}
async function startTeamJob(app, accounts) {
  const result = await app.request('/api/children/auto-json', { method: 'POST', body: {
    scope: 'team', motherId: 'fixture_mother', ids: accounts.map((child) => child.id),
  } });
  assert.equal(result.status, 202, JSON.stringify(result.data));
  return result.data.job;
}

test('Roxy concurrency partial API saves persist without changing secrets, profiles or protocol concurrency', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/state')).data.settings.integrations.roxy.concurrency, 1);
  assert.equal((await app.patch(app.config)).status, 200);
  const before = (await app.saved()).state;
  const result = await app.patch({ concurrency: 3 });
  assert.equal(result.status, 200);
  assert.equal(result.data.settings.integrations.roxy.concurrency, 3);
  const saved = (await app.saved()).state;
  assert.deepEqual(saved.settings.integrations.roxy, { ...before.settings.integrations.roxy, concurrency: 3 });
  assert.equal(saved.settings.concurrency, before.settings.concurrency);
  for (const value of [0, 4, 1.5, '2', null]) {
    const invalid = await app.patch({ concurrency: value });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.code, 'roxy_concurrency_invalid');
    assert.deepEqual((await app.saved()).state.settings, saved.settings);
  }
});

for (const concurrency of [1, 3]) {
  test(`same-Team batch starts ${concurrency} Roxy windows and fills each slot after the preceding account finishes`, { timeout: 20000 }, async (t) => {
    const accounts = parallelChildren.slice(0, 4);
    const app = await fixture(t, { browserFlow: true, teamFlow: true, holdBrowser: true, concurrentAccounts: accounts });
    await configureParallel(app, accounts, concurrency);
    const job = await startTeamJob(app, accounts);
    assert.equal(job.concurrency, concurrency);
    await waitForFixture(() => app.heldBrowsers.size === concurrency, 'expected simultaneous same-Team browser authorizations');
    assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, concurrency);
    assert.equal((await app.patch({ concurrency: concurrency === 1 ? 3 : 1 })).status, 409);
    app.releaseAccount(accounts[0].email);
    await waitForFixture(() => app.requests.filter((request) => request.path === '/browser/open').length === concurrency + 1,
      'the next account should start when one complete account frees its worker');
    const opens = app.requests.filter((request) => request.path === '/browser/open');
    const quota = app.requests.find((request) => request.path === '/backend-api/wham/usage');
    assert.ok(quota && app.requests.indexOf(quota) < app.requests.indexOf(opens[concurrency]), 'the account worker includes token saving and quota, not only browser closure');
    for (const child of accounts.slice(1)) {
      await waitForFixture(() => app.heldBrowsers.has(child.email), `queued browser should start for ${child.id}`);
      app.releaseAccount(child.email);
    }
    const finished = await app.waitJob(job.id);
    assert.equal(finished.succeeded, 4, JSON.stringify(finished));
    assert.equal(app.browserPeak(), concurrency);
    assert.equal(app.openedProfiles.size, 0);
    assertNoSecrets(finished);
  });
}

test('independent automatic jobs and a direct Team login share the global three-browser limit', { timeout: 20000 }, async (t) => {
  const accounts = parallelChildren;
  const app = await fixture(t, { browserFlow: true, teamFlow: true, holdBrowser: true, concurrentAccounts: accounts });
  await configureParallel(app, accounts, 3);
  const first = await startTeamJob(app, accounts.slice(0, 3));
  await waitForFixture(() => app.heldBrowsers.size === 3, 'first job should occupy three browser slots');
  const second = await startTeamJob(app, [accounts[3]]);
  const manual = app.request(`/api/children/${accounts[4].id}/team-auth`, { method: 'POST', body: { motherId: 'fixture_mother' } });
  await waitForFixture(() => app.requests.filter((request) => request.path.endsWith('/users')).length >= 4, 'second job should pass membership checks without the browser slot');
  assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 3);
  for (const child of accounts) {
    await waitForFixture(() => app.heldBrowsers.has(child.email), 'all submitted browser operations should eventually run');
    app.releaseAccount(child.email);
  }
  assert.equal((await app.waitJob(first.id)).succeeded, 3);
  assert.equal((await app.waitJob(second.id)).succeeded, 1);
  assert.equal((await manual).status, 200);
  assert.equal(app.browserPeak(), 3);
});

test('a failed account closes its owned batch window and the next account completes', { timeout: 20000 }, async (t) => {
  const accounts = parallelChildren.slice(0, 2);
  const app = await fixture(t, { browserFlow: true, teamFlow: true, concurrentAccounts: accounts, failBrowserFor: [accounts[0].email] });
  await configureParallel(app, accounts, 1);
  const job = await app.waitJob((await startTeamJob(app, accounts)).id);
  assert.equal(job.succeeded, 1, JSON.stringify(job));
  assert.equal(job.needsAttention, 1);
  assert.equal(app.browserPeak(), 1);
  assert.equal(app.openedProfiles.size, 0);
});

for (const during of ['authorization', 'connection']) test(`failed window cleanup during ${during} blocks later opens until the exact owned window is confirmed closed`, { timeout: 20000 }, async (t) => {
  const accounts = parallelChildren.slice(0, 2);
  const cleanupFailureFor = [`profile_${accounts[0].id}`];
  const app = await fixture(t, { browserFlow: true, teamFlow: true, concurrentAccounts: accounts, cleanupFailureFor,
    connectFailureFor: during === 'connection' ? [accounts[0].id] : [] });
  await configureParallel(app, accounts, 1);
  const job = await app.waitJob((await startTeamJob(app, accounts)).id);
  assert.equal(job.results.find((result) => result.id === accounts[1].id).code, 'roxy_cleanup_failed');
  assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 1);
  cleanupFailureFor.length = 0;
  app.openedProfiles.clear(); // User closed the failed owned window in the fixture Local API.
  const retried = await app.waitJob((await startTeamJob(app, [accounts[1]])).id);
  assert.equal(retried.succeeded, 1, JSON.stringify(retried));
});

test('removing a member while quota is pending does not resurrect its active membership', { timeout: 20000 }, async (t) => {
  const accounts = parallelChildren.slice(0, 2);
  const app = await fixture(t, { browserFlow: true, teamFlow: true, concurrentAccounts: accounts, holdQuotaFor: [accounts[0].id] });
  await configureParallel(app, accounts, 3);
  const job = await startTeamJob(app, accounts);
  await waitForFixture(() => app.heldQuotas.has(accounts[0].id), 'first account should reach the held quota request');
  const removed = await app.request(`/api/children/${accounts[0].id}/kick`, { method: 'POST', body: {} });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  app.heldQuotas.get(accounts[0].id)();
  const finished = await app.waitJob(job.id);
  assert.equal(finished.results.find((result) => result.id === accounts[0].id).code, 'team_membership_changed');
  const child = (await app.saved()).state.children.find((item) => item.id === accounts[0].id);
  assert.equal(child.team, null);
  assert.equal(child.workspaceHistory.filter((entry) => entry.status === 'active').length, 0);
  assert.equal(child.workspaceHistory.at(-1).status, 'kicked');
});

test('OAuth timeout during a pending browser open retains its concurrency slot until late cleanup finishes', { timeout: 20000 }, async (t) => {
  const accounts = parallelChildren.slice(0, 2);
  const dirId = `profile_${accounts[0].id}`;
  const app = await fixture(t, { browserFlow: true, teamFlow: true, concurrentAccounts: accounts,
    holdOpenFor: [dirId], timeoutBeforeSessionFor: [accounts[0].email] });
  await configureParallel(app, accounts, 1);
  const job = await startTeamJob(app, accounts);
  await waitForFixture(() => app.heldOpens.has(dirId), 'first owned window should be pending startup after OAuth timed out');
  assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 1);
  assert.equal((await app.request(`/api/children/auto-json/${job.id}`)).data.job.status, 'running');
  app.heldOpens.get(dirId)();
  const finished = await app.waitJob(job.id);
  assert.equal(finished.succeeded, 1, JSON.stringify(finished));
  assert.equal(finished.results.find((result) => result.id === accounts[0].id).code, 'browser_oauth_timeout');
  assert.equal(app.browserPeak(), 1);
  assert.equal(app.openedProfiles.size, 0);
});

test('removing a member while its Team OAuth is running cannot recreate membership or save its token', { timeout: 20000 }, async (t) => {
  const accounts = parallelChildren.slice(0, 2);
  const app = await fixture(t, { browserFlow: true, teamFlow: true, holdBrowser: true, concurrentAccounts: accounts });
  await configureParallel(app, accounts, 3);
  const job = await startTeamJob(app, accounts);
  await waitForFixture(() => app.heldBrowsers.size === 2, 'both member logins should be running');
  const removed = await app.request(`/api/children/${accounts[0].id}/kick`, { method: 'POST', body: {} });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  accounts.forEach((child) => app.releaseAccount(child.email));
  const finished = await app.waitJob(job.id);
  assert.equal(finished.results.find((result) => result.id === accounts[0].id).code, 'team_membership_changed');
  assert.equal(finished.succeeded, 1);
  const child = (await app.saved()).state.children.find((item) => item.id === accounts[0].id);
  assert.equal(child.team, null);
  assert.equal(child.workspaceHistory.filter((entry) => entry.status === 'active').length, 0);
  assert.equal(child.workspaceHistory.at(-1).status, 'kicked');
  assert.equal(child.workspaceTokens?.[app.workspaceId], undefined);
});

test('Roxy config defaults are public and API routes require dashboard authentication', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  const current = await app.request('/api/state');
  assert.equal(current.status, 200);
  const config = current.data.settings.integrations.roxy;
  assert.equal(config.enabled, false);
  assert.equal(config.apiKeySet, false);
  assert.equal(config.baseUrl, 'http://127.0.0.1:50000');
  assert.equal(config.headless, false);
  assert.equal(config.useProxyPool, false);
  assert.deepEqual(config.profiles, []);
  assert.equal(Object.hasOwn(config, 'apiKey'), false);
  for (const route of ['/api/integrations', '/api/integrations/roxy/check']) {
    const response = await app.request(route, { method: route.endsWith('/check') ? 'POST' : 'PATCH',
      authenticated: false, body: { roxy: app.config } });
    assert.equal(response.status, 401);
    assertNoSecrets(response.data);
  }
  assert.deepEqual(app.requests, []);
});

test('local first-hop proxy settings persist and invalid patches leave every previous field unchanged', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  const initial = (await app.request('/api/state')).data.settings.proxy;
  assert.equal(initial.localProxyEnabled, false);
  assert.equal(initial.localProxyUrl, 'http://127.0.0.1:7897');
  const configured = await app.request('/api/proxy', { method: 'PATCH', body: {
    enabled: true, localProxyEnabled: true, localProxyUrl: 'socks5h://localhost:7897',
  } });
  assert.equal(configured.status, 200);
  assert.equal(configured.data.proxy.localProxyEnabled, true);
  assert.equal(configured.data.proxy.localProxyUrl, 'socks5h://127.0.0.1:7897');
  const before = (await app.saved()).state.settings.proxy;
  for (const localProxyUrl of ['http://remote.example.test:7897', 'http://user:secret@127.0.0.1:7897',
    'http://127.0.0.1:7897/private', 'http://127.0.0.1:7897?secret=yes', 'http://127.0.0.1:7897#fragment',
    'https://127.0.0.1:7897', 'socks4://127.0.0.1:7897', '', null]) {
    const invalid = await app.request('/api/proxy', { method: 'PATCH', body: { enabled: false, maxRetries: 0, localProxyUrl } });
    assert.equal(invalid.status, 400, String(localProxyUrl));
    assert.equal(invalid.data.code, 'local_proxy_url_invalid');
    assert.deepEqual((await app.saved()).state.settings.proxy, before);
  }
  const invalidSwitch = await app.request('/api/proxy', { method: 'PATCH', body: { enabled: false, localProxyEnabled: 'true' } });
  assert.equal(invalidSwitch.status, 400);
  assert.deepEqual((await app.saved()).state.settings.proxy, before);
  assert.deepEqual(app.requests, []);
});

test('Roxy retains an account-specific chained relay with a headed failed window and closes it only after that window closes', async () => {
  const config = { enabled: true, apiKey: 'fixture-key', workspaceId: 'fixture_workspace', headless: false,
    useProxyPool: true, profiles: [{ childId: 'chain_child', dirId: 'chain_profile', proxyId: 'upstream_fixed' }] };
  const proxyEntry = { id: 'upstream_fixed', url: 'http://upstream-user:private-upstream-password@upstream.example.test:3000' };
  let opened = false;
  const relays = [];
  const updates = [];
  const api = {
    async connectionInfo() { return opened ? [{ dirId: 'chain_profile' }] : []; },
    async updateProxy(_workspace, _dirId, entry) { updates.push(entry); },
    async open() { opened = true; return { ws: 'ws://127.0.0.1:50001/devtools/browser/fixture' }; },
    async close() { opened = false; },
  };
  const dependencies = { client: api, connect: async () => ({
    newPage: async () => ({ close: async () => {} }), disconnect: async () => {},
  }), createRelay: async (options) => {
    assert.deepEqual(options, { localProxyUrl: 'http://127.0.0.1:7897', upstreamProxyUrl: proxyEntry.url, timeoutMs: 30000 });
    const relay = { url: `http://chain:private-relay-${relays.length}@127.0.0.1:${51000 + relays.length}`,
      closed: false, async close() { this.closed = true; } };
    relays.push(relay);
    return relay;
  } };
  const input = { config, childId: 'chain_child', proxyEntry, localProxyUrl: 'http://127.0.0.1:7897' };
  const session = await openRoxyBrowserSession(input, dependencies);
  assert.equal(updates[0].id, 'upstream_fixed');
  assert.equal(updates[0].url, relays[0].url);
  assert.equal(config.profiles[0].proxyId, 'upstream_fixed');
  await session.close({ keepOpen: true });
  assert.equal(relays[0].closed, false);
  await assert.rejects(() => openRoxyBrowserSession(input, dependencies), { code: 'roxy_profile_busy' });
  assert.equal(relays.length, 1);
  assert.equal(relays[0].closed, false);
  opened = false;
  const retry = await openRoxyBrowserSession(input, dependencies);
  assert.equal(relays[0].closed, true);
  assert.equal(relays.length, 2);
  assert.equal(relays[1].closed, false);
  await retry.close();
  assert.equal(relays[1].closed, true);
});

test('Roxy chain setup failure does not fall back to a direct proxy and a failed launch cleans up only its own relay', async () => {
  const config = { enabled: true, apiKey: 'fixture-key', workspaceId: 'fixture_workspace',
    useProxyPool: true, profiles: [{ childId: 'chain_failure_child', dirId: 'chain_failure_profile', proxyId: 'upstream_fixed' }] };
  const input = { config, childId: 'chain_failure_child', localProxyUrl: 'http://127.0.0.1:7897',
    proxyEntry: { id: 'upstream_fixed', url: 'http://upstream.example.test:3000' } };
  let updates = 0;
  let closed = 0;
  const api = { connectionInfo: async () => [], updateProxy: async () => { updates += 1; throw new Error('private-update-error'); } };
  await assert.rejects(() => openRoxyBrowserSession(input, { client: api, createRelay: async () => { throw new Error('private-create-error'); } }),
    (error) => error.code === 'roxy_proxy_chain_failed' && !error.message.includes('private'));
  assert.equal(updates, 0);
  await assert.rejects(() => openRoxyBrowserSession(input, { client: api, createRelay: async () => ({
    url: 'http://chain:private-relay@127.0.0.1:51000', close: async () => { closed += 1; },
  }) }), { code: 'roxy_api_failed' });
  assert.equal(updates, 1);
  assert.equal(closed, 1);
});

test('Roxy key is encrypted at rest, redacted publicly, and preserved when omitted on later saves', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  const patched = await app.patch(app.config);
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  assertNoSecrets(patched.data);
  const config = patched.data.settings.integrations.roxy;
  assert.deepEqual(config, { enabled: true, baseUrl: app.config.baseUrl, apiKeySet: true,
    workspaceId: app.config.workspaceId, headless: false, useProxyPool: false, concurrency: 1, profiles: app.config.profiles });
  const first = await app.saved();
  assert.equal(first.envelope.encrypted, true);
  assertNoSecrets(first.raw);
  assert.equal(first.state.settings.integrations.roxy.apiKey, secret);
  const omitted = await app.patch({ enabled: false, workspaceId: 'roxy_workspace_b' });
  assert.equal(omitted.status, 200);
  assert.equal(omitted.data.settings.integrations.roxy.apiKeySet, true);
  assert.equal((await app.saved()).state.settings.integrations.roxy.apiKey, secret);
  const clear = await app.patch({ apiKey: '' });
  assert.equal(clear.status, 200);
  assert.equal(clear.data.settings.integrations.roxy.apiKeySet, false);
  assert.equal((await app.saved()).state.settings.integrations.roxy.apiKey, '');
  assert.deepEqual(app.requests, []);
});

test('Roxy rejects non-loopback API origins and unsafe URL forms without network calls', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  assert.equal((await app.patch(app.config)).status, 200);
  for (const baseUrl of [
    'http://remote.example.test:50000', 'https://127.0.0.1:50000', 'file:///etc/passwd',
    'http://127.0.0.1:50000/api', 'http://user:password@127.0.0.1:50000',
    'http://127.0.0.1:50000?token=secret', 'http://127.0.0.1:50000#fragment',
  ]) {
    const result = await app.patch({ baseUrl });
    assert.equal(result.status, 400, baseUrl);
    assert.equal(result.data.code, 'roxy_api_base_invalid');
    assertNoSecrets(result.data);
  }
  assert.equal((await app.saved()).state.settings.integrations.roxy.baseUrl, app.config.baseUrl);
  assert.deepEqual(app.requests, []);
});

test('Roxy profile mappings reject duplicate accounts, shared windows, and unknown child records', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  assert.equal((await app.patch(app.config)).status, 200);
  for (const profiles of [
    [{ childId: 'child_alpha', dirId: 'roxy_profile_a' }, { childId: 'child_alpha', dirId: 'roxy_profile_b' }],
    [{ childId: 'child_alpha', dirId: 'roxy_profile_a' }, { childId: 'child_beta', dirId: 'roxy_profile_a' }],
    [{ childId: 'child_missing', dirId: 'roxy_profile_a' }],
  ]) {
    const result = await app.patch({ profiles });
    assert.equal(result.status, 400, JSON.stringify(result.data));
    assert.match(result.data.code, /^roxy_/);
    assertNoSecrets(result.data);
  }
  assert.deepEqual((await app.saved()).state.settings.integrations.roxy.profiles, app.config.profiles);
  assert.deepEqual(app.requests, []);
});

test('Roxy launch mode and pool bindings persist while automatic assignment stays stable across saves', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  const proxies = await app.addProxies();
  const configured = await app.patch({ ...app.config, headless: true, useProxyPool: true, profiles: [
    ...app.config.profiles, { childId: 'child_beta', dirId: 'roxy_profile_b' },
  ] });
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
  const roxy = configured.data.settings.integrations.roxy;
  assert.equal(roxy.headless, true);
  assert.equal(roxy.useProxyPool, true);
  assert.deepEqual(roxy.profiles.map((profile) => profile.proxyId), proxies.slice(0, 2).map((proxy) => proxy.id));
  const resaved = await app.patch({ headless: false });
  assert.equal(resaved.status, 200);
  assert.equal(resaved.data.settings.integrations.roxy.headless, false);
  assert.deepEqual(resaved.data.settings.integrations.roxy.profiles, roxy.profiles);
  assert.deepEqual((await app.saved()).state.settings.integrations.roxy.profiles, roxy.profiles);
  assertNoSecrets(configured.data);
  assert.deepEqual(app.requests, []);
});

test('Roxy pool configuration rejects disabled pools and unknown explicit proxies atomically', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  await app.addProxies({ enabled: false });
  assert.equal((await app.patch(app.config)).status, 200);
  const original = (await app.saved()).state.settings.integrations;
  const disabled = await app.patch({ useProxyPool: true, headless: true });
  assert.equal(disabled.status, 400, JSON.stringify(disabled.data));
  assert.equal(disabled.data.code, 'roxy_proxy_pool_disabled');
  assert.deepEqual((await app.saved()).state.settings.integrations, original);
  assert.equal((await app.request('/api/proxy', { method: 'PATCH', body: { enabled: true } })).status, 200);
  const missing = await app.patch({ useProxyPool: true, profiles: [
    { ...app.config.profiles[0], proxyId: 'missing_proxy' },
  ] }, { mailbox: { enabled: true } });
  assert.equal(missing.status, 400, JSON.stringify(missing.data));
  assert.equal(missing.data.code, 'roxy_proxy_missing');
  assert.deepEqual((await app.saved()).state.settings.integrations, original);
  assertNoSecrets(disabled.data);
  assertNoSecrets(missing.data);
  assert.deepEqual(app.requests, []);
});

test('bulk proxy deletion requires authenticated nonempty IDs and rejects unknown IDs without partial deletion', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  const proxies = await app.addProxies();
  const original = (await app.saved()).state.settings.proxy;
  const anonymous = await app.request('/api/proxy/entries', { method: 'DELETE', authenticated: false, body: { ids: [proxies[0].id] } });
  assert.equal(anonymous.status, 401);
  for (const ids of [undefined, [], 'all', null, [null], [123], ['']]) {
    const invalid = await app.request('/api/proxy/entries', { method: 'DELETE', body: { ids } });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.data));
    assert.equal(invalid.data.code || invalid.data.message, 'proxy_ids_required');
    assert.deepEqual((await app.saved()).state.settings.proxy, original);
  }
  const missing = await app.request('/api/proxy/entries', { method: 'DELETE', body: { ids: [proxies[0].id, 'missing_proxy'] } });
  assert.equal(missing.status, 404, JSON.stringify(missing.data));
  assert.equal(missing.data.code || missing.data.message, 'proxy_not_found');
  assert.deepEqual((await app.saved()).state.settings.proxy, original);
  assertNoSecrets(missing.data);
  assert.deepEqual(app.requests, []);
});

test('bulk proxy deletion removes only selected entries and clears their Roxy bindings without reassigning others', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true });
  const proxies = await app.addProxies();
  assert.equal((await app.patch({ ...app.config, useProxyPool: true, profiles: [
    { ...app.config.profiles[0], proxyId: proxies[0].id },
    { childId: 'child_beta', dirId: 'roxy_profile_b', proxyId: proxies[1].id },
  ] })).status, 200);
  const removed = await app.request('/api/proxy/entries', { method: 'DELETE', body: { ids: [proxies[0].id, proxies[2].id] } });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.deepEqual(removed.data.proxy.entries.map((proxy) => proxy.id), [proxies[1].id]);
  const saved = (await app.saved()).state;
  assert.equal(saved.settings.proxy.enabled, true);
  assert.deepEqual(saved.settings.integrations.roxy.profiles.map((profile) => profile.proxyId), ['', proxies[1].id]);
  const last = await app.request('/api/proxy/entries', { method: 'DELETE', body: { ids: [proxies[1].id] } });
  assert.equal(last.status, 200, JSON.stringify(last.data));
  const empty = (await app.saved()).state.settings;
  assert.equal(empty.proxy.enabled, false);
  assert.equal(empty.integrations.roxy.useProxyPool, true);
  assert.deepEqual(empty.integrations.roxy.profiles.map((profile) => profile.proxyId), ['', '']);
  assertNoSecrets(removed.data);
  assertNoSecrets(last.data);
  const job = await app.runJob({ ids: ['child_alpha'] });
  assert.equal(job.succeeded, 0);
  assert.equal(job.results[0].code, 'roxy_proxy_pool_disabled');
  const disabledRoxy = await app.patch({ enabled: false });
  assert.equal(disabledRoxy.status, 200, JSON.stringify(disabledRoxy.data));
  assert.equal(disabledRoxy.data.settings.integrations.roxy.enabled, false);
  assert.equal(disabledRoxy.data.settings.integrations.roxy.useProxyPool, true);
  assert.equal((await app.saved()).state.settings.integrations.roxy.enabled, false);
  assert.deepEqual(app.requests, []);
});

test('single proxy deletion also clears the account binding so it cannot reference a removed entry', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  const proxies = await app.addProxies();
  assert.equal((await app.patch({ ...app.config, useProxyPool: true, profiles: [
    { ...app.config.profiles[0], proxyId: proxies[0].id },
  ] })).status, 200);
  const removed = await app.request(`/api/proxy/entries/${proxies[0].id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal((await app.saved()).state.settings.integrations.roxy.profiles[0].proxyId, '');
  assert.deepEqual(removed.data.proxy.entries.map((proxy) => proxy.id), proxies.slice(1).map((proxy) => proxy.id));
  assertNoSecrets(removed.data);
});

test('active Roxy authorization pins its proxy and rejects deletion or profile changes until it completes', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true, proxyFlow: true, holdBrowser: true });
  const proxies = await app.addProxies();
  assert.equal((await app.patch({ ...app.config, headless: true, useProxyPool: true,
    profiles: [{ ...app.config.profiles[0], proxyId: proxies[1].id }] })).status, 200);
  const started = await app.request('/api/children/auto-json', { method: 'POST', body: { ids: ['child_alpha'] } });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  await app.waitBrowser();
  const before = (await app.saved()).state.settings;
  for (const [route, body] of [
    ['/api/proxy/entries', { ids: [proxies[0].id, proxies[1].id] }],
    [`/api/proxy/entries/${proxies[1].id}`, undefined],
  ]) {
    const rejected = await app.request(route, { method: 'DELETE', body });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
    assert.equal(rejected.data.code || rejected.data.message, 'proxy_in_use');
  }
  const changed = await app.patch({ headless: false });
  assert.equal(changed.status, 409, JSON.stringify(changed.data));
  assert.equal(changed.data.code, 'roxy_profile_busy');
  assert.deepEqual((await app.saved()).state.settings, before);
  app.releaseBrowser();
  const job = await app.waitJob(started.data.job.id);
  assert.equal(job.succeeded, 1, JSON.stringify(job));
  const launch = app.requests.find((request) => request.path === '/browser/open');
  assert.deepEqual(JSON.parse(launch.body), { workspaceId: app.config.workspaceId,
    dirId: 'roxy_profile_a', forceOpen: false, headless: true });
  const proxyUpdate = app.requests.find((request) => request.path === '/browser/mdf');
  assert.ok(proxyUpdate, 'the bound proxy must be installed in the Roxy profile before opening');
  assert.ok(app.requests.indexOf(proxyUpdate) < app.requests.indexOf(launch));
  assert.deepEqual(JSON.parse(proxyUpdate.body), { workspaceId: app.config.workspaceId, dirId: 'roxy_profile_a', proxyInfo: {
    proxyMethod: 'custom', proxyCategory: 'HTTP', ipType: 'IPV4', host: '127.0.0.1',
    port: String(proxies[1].port), proxyUserName: 'fixture-proxy-beta', proxyPassword: 'private-proxy-password',
  } });
  const proxied = app.requests.filter((request) => request.proxyAuth);
  assert.ok(proxied.some((request) => request.path === '/fixture/token'), 'OAuth exchange must use the assigned browser proxy');
  const expectedAuth = `Basic ${Buffer.from('fixture-proxy-beta:private-proxy-password').toString('base64')}`;
  assert.ok(proxied.every((request) => request.proxyAuth === expectedAuth), 'round-robin must not move requests away from the account-bound proxy');
  const deleted = await app.request('/api/proxy/entries', { method: 'DELETE', body: { ids: [proxies[1].id] } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assertNoSecrets(job);
  assertNoSecrets(app.output());
});

test('an invalid Roxy config does not partially mutate mailbox or Sub2API settings in the same patch', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  assert.equal((await app.patch(app.config)).status, 200);
  const before = (await app.saved()).state.settings.integrations;
  const invalid = await app.patch({ enabled: true, apiKey: '' }, {
    mailbox: { enabled: true, serviceType: 'fixture-changed', endpoint: 'http://changed.example.test', apiKey: 'private-changed-key' },
    sub2api: { name: 'Changed Sub2API', groupId: 99 },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, 'roxy_api_key_missing');
  assert.deepEqual((await app.saved()).state.settings.integrations, before);
  const state = (await app.request('/api/state')).data;
  assert.equal(state.settings.integrations.mailbox.enabled, before.mailbox.enabled);
  assert.equal(state.settings.integrations.sub2apis[0].name, before.sub2apis[0].name);
  assertNoSecrets(invalid.data);
});

test('Roxy check uses the official token header and bounded workspace/profile pagination without saving the draft', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  assert.equal((await app.patch({ ...app.config, enabled: false })).status, 200);
  const before = (await app.saved()).state.settings.integrations.roxy;
  const draftKey = 'private-roxy-draft-key';
  const result = await app.request('/api/integrations/roxy/check', { method: 'POST', body: {
    roxy: { baseUrl: app.config.baseUrl, apiKey: draftKey, workspaceId: app.config.workspaceId },
  } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.ok, true);
  assert.ok(result.data.workspaces.some((row) => row.id === 'roxy_workspace_a'));
  assert.ok(result.data.profiles.some((row) => row.dirId === 'roxy_profile_a'));
  assert.deepEqual(app.requests.map((request) => request.path), ['/health', '/browser/workspace', '/browser/list_v3']);
  for (const request of app.requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.token, draftKey);
    assert.equal(request.body, '');
    assert.equal(Object.hasOwn(request.query, 'token'), false);
    if (request.path !== '/health') {
      assert.equal(request.query.page_index, '1');
      assert.ok(Number(request.query.page_size) >= 1 && Number(request.query.page_size) <= 100);
    }
  }
  assert.equal(app.requests[2].query.workspaceId, app.config.workspaceId);
  assert.deepEqual((await app.saved()).state.settings.integrations.roxy, before);
  assertNoSecrets(result.data);
  assertNoSecrets(app.output());
});

test('Roxy check may use the saved secret, but malformed drafts never call the local API', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  assert.equal((await app.patch(app.config)).status, 200);
  const result = await app.request('/api/integrations/roxy/check', { method: 'POST', body: { roxy: { workspaceId: app.config.workspaceId } } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(app.requests.every((request) => request.token === secret));
  const count = app.requests.length;
  const invalid = await app.request('/api/integrations/roxy/check', { method: 'POST', body: { roxy: { baseUrl: 'http://remote.example.test:50000' } } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, 'roxy_api_base_invalid');
  assert.equal(app.requests.length, count);
  assertNoSecrets(result.data);
  assertNoSecrets(invalid.data);
});

test('Roxy connection checks can list teams before an enabled draft has selected its workspace', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  const result = await app.request('/api/integrations/roxy/check', { method: 'POST', body: {
    roxy: { enabled: true, baseUrl: app.config.baseUrl, apiKey: secret, workspaceId: '' },
  } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.ok, true);
  assert.deepEqual(result.data.workspaces, [{ id: 'roxy_workspace_a', name: 'Fixture team' }]);
  assert.deepEqual(result.data.profiles, []);
  assert.deepEqual(app.requests.map((request) => request.path), ['/health', '/browser/workspace']);
  assert.equal((await app.request('/api/state')).data.settings.integrations.roxy.enabled, false);
  assertNoSecrets(result.data);
});

test('Roxy routes reject null and array config bodies without persisting or accessing its API', { timeout: 20000 }, async (t) => {
  const app = await fixture(t);
  assert.equal((await app.patch(app.config)).status, 200);
  const original = (await app.saved()).state.settings.integrations;
  for (const roxy of [null, []]) {
    for (const [route, method] of [['/api/integrations', 'PATCH'], ['/api/integrations/roxy/check', 'POST']]) {
      const result = await app.request(route, { method, body: { roxy } });
      assert.equal(result.status, 400, JSON.stringify(result.data));
      assert.equal(result.data.code, 'roxy_config_invalid');
      assertNoSecrets(result.data);
    }
  }
  assert.deepEqual((await app.saved()).state.settings.integrations, original);
  assert.deepEqual(app.requests, []);
});

for (const [status, code] of [[401, 'roxy_api_auth_failed'], [403, 'roxy_api_auth_failed'], [429, 'roxy_api_rate_limited'], [500, 'roxy_api_failed']]) {
  test(`Roxy check maps upstream HTTP ${status} to a safe error without exposing raw response text`, { timeout: 20000 }, async (t) => {
    const app = await fixture(t, { apiFailure: { status } });
    const result = await app.request('/api/integrations/roxy/check', { method: 'POST', body: { roxy: { ...app.config, enabled: false } } });
    assert.ok(result.status >= 400, JSON.stringify(result.data));
    assert.equal(result.data.code, code);
    assertNoSecrets(result.data);
    assertNoSecrets(app.output());
    assert.equal(app.requests.length, 1);
    assert.equal((await app.request('/api/state')).data.settings.integrations.roxy.apiKeySet, false);
  });
}

test('Roxy check does not expose the vendor error message from an HTTP 200 application-level failure', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { apiFailure: { status: 200, code: -1 } });
  const result = await app.request('/api/integrations/roxy/check', { method: 'POST', body: { roxy: { ...app.config, enabled: false } } });
  assert.equal(result.status, 502);
  assert.equal(result.data.code, 'roxy_api_failed');
  assertNoSecrets(result.data);
  assertNoSecrets(app.output());
  assert.equal(app.requests.length, 1);
});

test('automatic Free JSON uses the bound Roxy profile and exchanges the original callback without launching Chrome', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true });
  assert.equal((await app.patch(app.config)).status, 200);
  const job = await app.runJob({ ids: ['child_alpha'] });
  assert.equal(job.succeeded, 1, JSON.stringify(job));
  const browserOptions = JSON.parse(app.requests.find((request) => request.path === '/fixture/browser-options').body);
  assert.deepEqual(browserOptions, { email: children[0].email, workspaceId: '', workspaceMode: 'free', stateMatches: true });
  const opened = app.requests.filter((request) => request.path === '/browser/open');
  assert.equal(opened.length, 1);
  assert.deepEqual(JSON.parse(opened[0].body), { workspaceId: 'roxy_workspace_a', dirId: 'roxy_profile_a', forceOpen: false, headless: false });
  assert.equal(app.requests.filter((request) => request.path === '/browser/close').length, 1);
  assert.equal((await app.saved()).state.children[0].refreshToken, 'private-fixture-rt-child_alpha');
  assertNoSecrets(job);
});

test('automatic Team JSON selects the target workspace through Roxy and saves only verified Team credentials and quota', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true, teamFlow: true });
  assert.equal((await app.patch(app.config)).status, 200);
  const job = await app.runJob({ ids: ['child_alpha'], scope: 'team', motherId: 'fixture_mother' });
  assert.equal(job.succeeded, 1, JSON.stringify(job));
  assert.equal(job.results[0].authScope, 'team');
  assert.equal(job.results[0].quotaChecked, true);
  assert.equal(job.results[0].quota5h, 75);
  assert.equal(job.results[0].quota7d, 90);
  const browserOptions = JSON.parse(app.requests.find((request) => request.path === '/fixture/browser-options').body);
  assert.deepEqual(browserOptions, { email: children[0].email, workspaceId: app.workspaceId, workspaceMode: 'team', stateMatches: true });
  const saved = (await app.saved()).state.children[0];
  assert.equal(saved.workspaceTokens[app.workspaceId].refreshToken, 'private-fixture-rt-child_alpha');
  assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 1);
  assert.equal(app.requests.filter((request) => request.path === '/browser/close').length, 1);
  assertNoSecrets(job);
});

test('an unmapped account creates its own Roxy profile without using the previous account window', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true, accountId: 'child_beta' });
  assert.equal((await app.patch(app.config)).status, 200);
  const job = await app.runJob({ ids: ['child_beta'] });
  assert.equal(job.succeeded, 1, JSON.stringify(job));
  const created = app.requests.filter((request) => request.path === '/browser/create');
  assert.equal(created.length, 1);
  assert.equal(JSON.parse(created[0].body).windowRemark, 'auto-team:child:child_beta');
  assert.deepEqual((await app.saved()).state.settings.integrations.roxy.profiles, [
    ...app.config.profiles, { childId: 'child_beta', dirId: 'created_profile_1' },
  ]);
  assert.equal(JSON.parse(app.requests.find((request) => request.path === '/browser/open').body).dirId, 'created_profile_1');
  const repeated = await app.runJob({ ids: ['child_beta'] });
  assert.equal(repeated.succeeded, 1, JSON.stringify(repeated));
  assert.equal(app.requests.filter((request) => request.path === '/browser/create').length, 1);
  assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 1);
  assertNoSecrets(job);
});

test('a failed browser login retains its automatically created profile for the next attempt', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true, browserVerification: true });
  assert.equal((await app.patch({ ...app.config, profiles: [] })).status, 200);
  const initial = await app.runJob({ ids: ['child_alpha'] });
  assert.equal(initial.results[0].code, 'browser_verification_required');
  const savedProfiles = (await app.saved()).state.settings.integrations.roxy.profiles;
  assert.deepEqual(savedProfiles, [{ childId: 'child_alpha', dirId: 'created_profile_1' }]);
  const retried = await app.runJob({ ids: ['child_alpha'] });
  assert.equal(retried.results[0].code, 'browser_verification_required');
  assert.deepEqual((await app.saved()).state.settings.integrations.roxy.profiles, savedProfiles);
  assert.equal(app.requests.filter((request) => request.path === '/browser/create').length, 1);
  assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 1);
  assertNoSecrets(retried);
});

test('an automatic Team login provisions and persists one profile before fixing its proxy and exchanging tokens', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true, proxyFlow: true, teamFlow: true });
  const proxies = await app.addProxies();
  assert.equal((await app.patch({ ...app.config, useProxyPool: true, profiles: [] })).status, 200);
  const job = await app.runJob({ ids: ['child_alpha'], scope: 'team', motherId: 'fixture_mother' });
  assert.equal(job.succeeded, 1, JSON.stringify(job));
  assert.equal(job.results[0].quotaChecked, true);
  const profiles = (await app.saved()).state.settings.integrations.roxy.profiles;
  assert.deepEqual(profiles, [{ childId: 'child_alpha', dirId: 'created_profile_1', proxyId: proxies[0].id }]);
  const routes = app.requests.map((request) => request.path);
  assert.equal(routes.filter((route) => route === '/browser/create').length, 1);
  assert.ok(routes.indexOf('/browser/create') < routes.indexOf('/browser/mdf'));
  assert.ok(routes.indexOf('/browser/mdf') < routes.indexOf('/browser/open'));
  const expected = `Basic ${Buffer.from('fixture-proxy-alpha:private-proxy-password').toString('base64')}`;
  assert.ok(app.requests.some((request) => request.path === '/fixture/token' && request.proxyAuth === expected));
  assertNoSecrets(job);
});

test('automatic Team authorization passes the same first hop and fixed upstream to Roxy and backend relay consumers', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true, proxyFlow: true, teamFlow: true, chainFlow: true });
  const proxies = await app.addProxies();
  assert.equal((await app.request('/api/proxy', { method: 'PATCH', body: {
    localProxyEnabled: true, localProxyUrl: 'http://127.0.0.1:7897',
  } })).status, 200);
  assert.equal((await app.patch({ ...app.config, useProxyPool: true, profiles: [
    { ...app.config.profiles[0], proxyId: proxies[0].id },
  ] })).status, 200);
  const job = await app.runJob({ ids: ['child_alpha'], scope: 'team', motherId: 'fixture_mother' });
  assert.equal(job.succeeded, 1, JSON.stringify(job));
  const calls = app.requests.filter((request) => request.path === '/fixture/chain-create').map((request) => JSON.parse(request.body));
  assert.ok(calls.length >= 2, 'browser launch and backend token exchange each request a chained relay');
  assert.ok(calls.every((call) => call.localProxyUrl === 'http://127.0.0.1:7897'));
  const browserUpdate = app.requests.find((request) => request.path === '/browser/mdf');
  const browserProxy = JSON.parse(browserUpdate.body).proxyInfo;
  assert.equal(browserProxy.host, '127.0.0.1');
  assert.equal(browserProxy.proxyUserName, 'fixture-chain');
  const token = app.requests.find((request) => request.path === '/fixture/token');
  const relayFor = (request) => JSON.parse(app.requests.slice(0, app.requests.indexOf(request)).findLast((item) => item.path === '/fixture/chain-create').body);
  assert.equal(relayFor(browserUpdate).upstreamProxyUrl, relayFor(token).upstreamProxyUrl);
  assert.ok(relayFor(token).upstreamProxyUrl.includes('fixture-proxy-alpha:'));
  assert.equal(token.proxyAuth, `Basic ${Buffer.from('fixture-chain:private-relay').toString('base64')}`);
  assert.equal((await app.saved()).state.settings.integrations.roxy.profiles[0].proxyId, proxies[0].id);
  assert.equal(app.requests.filter((request) => request.path === '/fixture/chain-close').length, calls.length);
  assertNoSecrets(job);
});

test('concurrent Free and Team tasks for one account persist only one independent Roxy profile', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true, teamFlow: true });
  assert.equal((await app.patch({ ...app.config, profiles: [] })).status, 200);
  const started = await Promise.all([
    app.request('/api/children/auto-json', { method: 'POST', body: { ids: ['child_alpha'] } }),
    app.request('/api/children/auto-json', { method: 'POST', body: { ids: ['child_alpha'], scope: 'team', motherId: 'fixture_mother' } }),
  ]);
  for (const item of started) assert.equal(item.status, 202, JSON.stringify(item.data));
  const jobs = await Promise.all(started.map((item) => app.waitJob(item.data.job.id)));
  for (const job of jobs) assert.equal(job.succeeded, 1, JSON.stringify(job));
  assert.equal(app.requests.filter((request) => request.path === '/browser/create').length, 1);
  assert.deepEqual((await app.saved()).state.settings.integrations.roxy.profiles, [{ childId: 'child_alpha', dirId: 'created_profile_1' }]);
  assertNoSecrets(jobs);
});

test('profile creation permission errors are reported safely without opening or falsely binding a window', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true, createFailure: { code: -1, msg: `订阅权限已过期 ${secret}` } });
  assert.equal((await app.patch({ ...app.config, profiles: [] })).status, 200);
  const job = await app.runJob({ ids: ['child_alpha'] });
  assert.equal(job.results[0].code, 'roxy_entitlement_unavailable');
  assert.equal(job.succeeded, 0);
  assert.deepEqual((await app.saved()).state.settings.integrations.roxy.profiles, []);
  assert.ok(!app.requests.some((request) => ['/browser/open', '/fixture/token'].includes(request.path)));
  assertNoSecrets(job);
});

test('missing credentials or a disabled proxy pool cannot consume a new Roxy environment', { timeout: 20000 }, async (t) => {
  for (const missingCredentials of [true, false]) {
    const app = await fixture(t, { browserFlow: true, priorFields: missingCredentials ? { password: '' } : {} });
    if (!missingCredentials) await app.addProxies();
    assert.equal((await app.patch({ ...app.config, useProxyPool: !missingCredentials, profiles: [] })).status, 200);
    if (!missingCredentials) assert.equal((await app.request('/api/proxy', { method: 'PATCH', body: { enabled: false } })).status, 200);
    const job = await app.runJob({ ids: ['child_alpha'] });
    assert.equal(job.succeeded, 0);
    assert.equal(job.results[0].code, missingCredentials ? 'credentials_required' : 'roxy_proxy_pool_disabled');
    assert.ok(!app.requests.some((request) => request.path.startsWith('/browser/')));
    assert.deepEqual((await app.saved()).state.settings.integrations.roxy.profiles, []);
    assertNoSecrets(job);
  }
});

for (const mode of ['token', 'refresh', 'callback']) {
  test(`an unmapped account with a usable ${mode} completes without creating a Roxy profile`, { timeout: 20000 }, async (t) => {
    const token = oauthToken(children[0]);
    const priorFields = mode === 'callback' ? { authSession: {
      state: 'private-old-state', codeVerifier: 'private-old-verifier',
      callbackReceivedAt: new Date().toISOString(),
      callbackUrl: 'http://localhost:1455/auth/callback?code=private-callback-code&state=private-old-state',
    } } : { accessToken: mode === 'token' ? token.access_token : '', refreshToken: token.refresh_token };
    const app = await fixture(t, { browserFlow: true, priorFields });
    assert.equal((await app.patch({ ...app.config, profiles: [] })).status, 200);
    const job = await app.runJob({ ids: ['child_alpha'] });
    assert.equal(job.succeeded, 1, JSON.stringify(job));
    assert.ok(!app.requests.some((request) => request.path.startsWith('/browser/')));
    assert.deepEqual((await app.saved()).state.settings.integrations.roxy.profiles, []);
    assertNoSecrets(job);
  });
}

test('an occupied Roxy profile stops the task without closing or force-opening the user window', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true, occupiedProfile: true });
  assert.equal((await app.patch(app.config)).status, 200);
  const job = await app.runJob({ ids: ['child_alpha'] });
  assert.equal(job.succeeded, 0);
  assert.equal(job.needsAttention, 1);
  assert.equal(job.results[0].code, 'roxy_profile_busy');
  assert.ok(!app.requests.some((request) => ['/browser/open', '/browser/close', '/fixture/token'].includes(request.path)));
  assertNoSecrets(job);
});

test('disabled Roxy uses the existing protocol workflow without launching Chrome or opening a Roxy window', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true });
  assert.equal((await app.patch({ ...app.config, enabled: false })).status, 200);
  const job = await app.runJob({ ids: ['child_alpha'] });
  assert.equal(job.succeeded, 1, JSON.stringify(job));
  assert.ok(app.requests.some((request) => request.path === '/api/accounts/authorize/continue'));
  assert.ok(app.requests.some((request) => request.path === '/api/accounts/password/verify'));
  assert.ok(app.requests.some((request) => request.path === '/api/accounts/workspace/select'));
  assert.ok(!app.requests.some((request) => request.path.startsWith('/browser/') || request.path === '/fixture/browser-options'));
  assert.ok(!app.requests.some((request) => ['/fixture/browser-launch', '/fixture/browser-connect'].includes(request.path)),
    'protocol mode must not even attempt Puppeteer for OAuth or Sentinel');
  assert.equal((await app.saved()).state.children[0].refreshToken, 'private-fixture-rt-child_alpha');
  assertNoSecrets(job);
});

test('an unconfigured installation uses protocol login without any browser OAuth session', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true });
  const job = await app.runJob({ ids: ['child_alpha'] });
  assert.equal(job.succeeded, 1, JSON.stringify(job));
  assert.ok(app.requests.some((request) => request.path === '/api/accounts/password/verify'));
  assert.ok(!app.requests.some((request) => request.path.startsWith('/browser/') || request.path === '/fixture/browser-options'));
  assert.ok(!app.requests.some((request) => ['/fixture/browser-launch', '/fixture/browser-connect'].includes(request.path)),
    'an unconfigured installation must not even attempt Puppeteer');
  assertNoSecrets(job);
});

test('protocol-only mode stops on a required Sentinel browser verification without attempting Puppeteer', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true, sentinelChallenge: true });
  assert.equal((await app.patch({ ...app.config, enabled: false })).status, 200);
  const job = await app.runJob({ ids: ['child_alpha'] });
  assert.equal(job.succeeded, 0);
  assert.equal(job.needsAttention, 1);
  assert.equal(job.results[0].code, 'browser_verification_required');
  assert.equal(job.results[0].httpStatus, 200, 'Sentinel can return HTTP 200 with a required browser challenge; do not label the local pause as an upstream HTTP 403');
  assert.ok(app.requests.some((request) => request.path === '/fixture/sentinel'));
  assert.ok(!app.requests.some((request) => ['/fixture/browser-launch', '/fixture/browser-connect', '/fixture/browser-options',
    '/api/accounts/authorize/continue', '/api/accounts/password/verify', '/fixture/token'].includes(request.path)));
  assertNoSecrets(job);
});

function priorVerification(scope, { code = 'browser_verification_required', backend = 'protocol' } = {}) {
  if (scope === 'team') return { teamLoginBackends: { target_team_workspace: backend }, teamLoginStates: {
    target_team_workspace: { status: 'browser_verification_required', code, browserRequired: true, needsInput: true },
  } };
  return { status: 'login_pending', loginStatus: 'verification_required', loginErrorCode: code,
    loginBrowserRequired: true, ...(backend ? { loginBackend: backend } : {}) };
}

function jobSelection(scope) {
  return { ids: ['child_alpha'], ...(scope === 'team' ? { scope: 'team', motherId: 'fixture_mother' } : {}) };
}

for (const scope of ['free', 'team']) {
  test(`changing a ${scope} Roxy network configuration allows one new attempt but preserves a repeated verification pause`, { timeout: 20000 }, async (t) => {
    const app = await fixture(t, { browserFlow: true, proxyFlow: true, teamFlow: scope === 'team', browserVerification: true });
    assert.equal((await app.patch(app.config)).status, 200);
    const initial = await app.runJob(jobSelection(scope));
    assert.equal(initial.succeeded, 0);
    assert.equal(initial.needsAttention, 1);
    assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 1);
    await app.addProxies();
    assert.equal((await app.patch({ useProxyPool: true, headless: true })).status, 200);
    const retried = await app.runJob(jobSelection(scope));
    assert.equal(retried.succeeded, 0);
    assert.equal(retried.needsAttention, 1);
    assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 2,
      'a changed network setting may retry the account once through its newly bound proxy');
    const repeated = await app.runJob(jobSelection(scope));
    assert.equal(repeated.succeeded, 0);
    assert.equal(repeated.needsAttention, 1);
    assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 2,
      'a second click with the same settings must preserve the verification pause');
    assert.ok(!app.requests.some((request) => request.path === '/fixture/token'));
    assertNoSecrets(initial);
    assertNoSecrets(retried);
    assertNoSecrets(repeated);
  });

  test(`enabling Roxy lets a prior ${scope} protocol verification pause try the newly selected browser backend`, { timeout: 20000 }, async (t) => {
    const app = await fixture(t, { browserFlow: true, teamFlow: scope === 'team', priorFields: priorVerification(scope) });
    assert.equal((await app.patch(app.config)).status, 200);
    const job = await app.runJob(jobSelection(scope));
    assert.equal(job.succeeded, 1, JSON.stringify(job));
    assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 1);
    const account = (await app.saved()).state.children[0];
    assert.equal(scope === 'team' ? account.teamLoginBackends[app.workspaceId] : account.loginBackend, 'roxy');
    assertNoSecrets(job);
  });

  test(`a ${scope} official verification challenge in Roxy stays paused on the next batch click`, { timeout: 20000 }, async (t) => {
    const app = await fixture(t, { browserFlow: true, teamFlow: scope === 'team',
      priorFields: priorVerification(scope), browserVerification: true });
    assert.equal((await app.patch(app.config)).status, 200);
    const initial = await app.runJob(jobSelection(scope));
    assert.equal(initial.succeeded, 0);
    assert.equal(initial.needsAttention, 1);
    assert.equal(initial.results[0].code, 'browser_verification_required');
    const attempted = app.requests.filter((request) => request.path === '/fixture/browser-options').length;
    assert.equal(attempted, 1);
    assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 1);
    const repeated = await app.runJob(jobSelection(scope));
    assert.equal(repeated.succeeded, 0);
    assert.equal(repeated.needsAttention, 1);
    assert.equal(app.requests.filter((request) => request.path === '/fixture/browser-options').length, attempted,
      'the same backend challenge must not trigger another OAuth browser run');
    assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 1);
    assert.ok(!app.requests.some((request) => request.path === '/fixture/token'));
    assertNoSecrets(initial);
    assertNoSecrets(repeated);
  });

  for (const code of ['phone_verification_required', 'email_otp_required']) {
    test(`enabling Roxy leaves the existing ${scope} ${code} requirement paused`, { timeout: 20000 }, async (t) => {
      const prior = priorVerification(scope, { code });
      if (scope === 'free') {
        prior.loginStatus = code === 'phone_verification_required' ? code : 'waiting_code';
        prior.status = code === 'phone_verification_required' ? code : 'login_pending';
      } else {
        prior.teamLoginStates.target_team_workspace.status = code === 'phone_verification_required' ? code : 'waiting_code';
      }
      const app = await fixture(t, { browserFlow: true, teamFlow: scope === 'team', priorFields: prior });
      assert.equal((await app.patch(app.config)).status, 200);
      const job = await app.runJob(jobSelection(scope));
      assert.equal(job.succeeded, 0);
      assert.equal(job.needsAttention, 1);
      assert.ok(!app.requests.some((request) => ['/fixture/browser-options', '/browser/open', '/fixture/token'].includes(request.path)));
      const account = (await app.saved()).state.children[0];
      assert.equal(scope === 'team' ? account.teamLoginBackends[app.workspaceId] : account.loginBackend, 'protocol');
      assertNoSecrets(job);
    });
  }
}

test('a legacy Free browser verification without backend metadata may try Roxy once', { timeout: 20000 }, async (t) => {
  const app = await fixture(t, { browserFlow: true, priorFields: priorVerification('free', { code: '', backend: '' }) });
  assert.equal((await app.patch(app.config)).status, 200);
  const job = await app.runJob(jobSelection('free'));
  assert.equal(job.succeeded, 1, JSON.stringify(job));
  assert.equal(app.requests.filter((request) => request.path === '/browser/open').length, 1);
  assert.equal((await app.saved()).state.children[0].loginBackend, 'roxy');
  assertNoSecrets(job);
});

function priorBrowserSession(scope, { backend = 'roxy', code = 'browser_verification_required', phase = 'roxy_start' } = {}) {
  const prior = priorVerification(scope, { code, backend });
  const session = { state: 'private-old-state', codeVerifier: 'private-old-verifier', phase,
    source: 'sub2api', currentUrl: 'https://auth.openai.com/log-in/password' };
  if (scope === 'team') prior.teamAuthSessions = { target_team_workspace: session };
  else prior.authSession = session;
  return prior;
}

function assertProtocolOnlyRequests(requests) {
  assert.ok(!requests.some((request) => request.path.startsWith('/browser/') || [
    '/fixture/browser-options', '/fixture/browser-launch', '/fixture/browser-connect',
  ].includes(request.path)), 'protocol retry must not touch any browser');
}

for (const scope of ['free', 'team']) {
  for (const [label, backend, code, phase] of [
    ['Roxy', 'roxy', 'browser_verification_required', 'roxy_start'],
    ['legacy browser session', '', '', 'browser_start'],
    ['legacy browser error', '', 'browser_oauth_verification_required', 'initializing'],
  ]) {
    test(`disabling Roxy allows a prior ${scope} ${label} failure to start a fresh protocol login`, { timeout: 20000 }, async (t) => {
      const app = await fixture(t, { browserFlow: true, teamFlow: scope === 'team',
        priorFields: priorBrowserSession(scope, { backend, code, phase }) });
      assert.equal((await app.patch({ ...app.config, enabled: false })).status, 200);
      const job = await app.runJob(jobSelection(scope));
      assert.equal(job.succeeded, 1, JSON.stringify(job));
      assert.equal(job.results[0].authScope, scope);
      assert.equal(app.requests.filter((request) => request.path === '/oauth/authorize').length, 1,
        'a browser session must not resume as a partial protocol password session');
      assert.equal(app.requests.find((request) => request.path === '/oauth/authorize').query.state, 'private-old-state',
        'switching the backend must preserve the original OAuth authorization state');
      assert.equal(app.requests.filter((request) => request.path === '/api/accounts/authorize/continue').length, 1);
      assert.equal(app.requests.filter((request) => request.path === '/api/accounts/password/verify').length, 1);
      const exchanged = new URLSearchParams(app.requests.find((request) => request.path === '/fixture/token').body);
      assert.ok(exchanged.get('code_verifier'));
      assert.equal(exchanged.get('code_verifier'), 'private-old-verifier');
      assertProtocolOnlyRequests(app.requests);
      const account = (await app.saved()).state.children[0];
      assert.equal(scope === 'team' ? account.teamLoginBackends[app.workspaceId] : account.loginBackend, 'protocol');
      if (scope === 'team') {
        assert.equal(account.workspaceTokens[app.workspaceId].refreshToken, 'private-fixture-rt-child_alpha');
        assert.equal(job.results[0].quotaChecked, true);
        assert.equal(job.results[0].quota5h, 75);
        assert.equal(job.results[0].quota7d, 90);
      } else assert.equal(account.refreshToken, 'private-fixture-rt-child_alpha');
      assertNoSecrets(job);
      assertNoSecrets(app.output());
    });
  }

  test(`a ${scope} legacy verification without backend evidence stays paused in protocol mode`, { timeout: 20000 }, async (t) => {
    const prior = priorBrowserSession(scope, { backend: '', code: '', phase: 'initializing' });
    const app = await fixture(t, { browserFlow: true, teamFlow: scope === 'team', priorFields: prior });
    assert.equal((await app.patch({ ...app.config, enabled: false })).status, 200);
    const job = await app.runJob(jobSelection(scope));
    assert.equal(job.succeeded, 0);
    assert.equal(job.needsAttention, 1);
    assert.ok(!app.requests.some((request) => ['/oauth/authorize', '/api/accounts/authorize/continue',
      '/api/accounts/password/verify', '/fixture/token'].includes(request.path)));
    assertProtocolOnlyRequests(app.requests);
    const account = (await app.saved()).state.children[0];
    const session = scope === 'team' ? account.teamAuthSessions[app.workspaceId] : account.authSession;
    assert.deepEqual(session, scope === 'team' ? prior.teamAuthSessions.target_team_workspace : prior.authSession);
    assertNoSecrets(job);
  });

  test(`a saved ${scope} callback is exchanged before resetting browser login progress for protocol mode`, { timeout: 20000 }, async (t) => {
    const prior = priorBrowserSession(scope);
    const session = scope === 'team' ? prior.teamAuthSessions.target_team_workspace : prior.authSession;
    session.callbackReceivedAt = new Date().toISOString();
    session.callbackUrl = 'http://localhost:1455/auth/callback?code=private-callback-code&state=private-old-state';
    const app = await fixture(t, { browserFlow: true, teamFlow: scope === 'team', priorFields: prior });
    assert.equal((await app.patch({ ...app.config, enabled: false })).status, 200);
    const job = await app.runJob(jobSelection(scope));
    assert.equal(job.succeeded, 1, JSON.stringify(job));
    const exchanges = app.requests.filter((request) => request.path === '/fixture/token');
    assert.equal(exchanges.length, 1);
    const exchanged = new URLSearchParams(exchanges[0].body);
    assert.equal(exchanged.get('code'), 'private-callback-code');
    assert.equal(exchanged.get('code_verifier'), 'private-old-verifier');
    assert.ok(!app.requests.some((request) => ['/oauth/authorize', '/api/accounts/authorize/continue',
      '/api/accounts/password/verify'].includes(request.path)));
    assertProtocolOnlyRequests(app.requests);
    assertNoSecrets(job);
    assertNoSecrets(app.output());
  });

  test(`a ${scope} protocol HTTP 403 exposes only safe stage/status and stays paused on the next automatic click`, { timeout: 20000 }, async (t) => {
    const app = await fixture(t, { browserFlow: true, teamFlow: scope === 'team',
      priorFields: priorBrowserSession(scope), passwordFailure: { status: 403 } });
    assert.equal((await app.patch({ ...app.config, enabled: false })).status, 200);
    const initial = await app.runJob(jobSelection(scope));
    assert.equal(initial.succeeded, 0);
    assert.equal(initial.needsAttention, 1);
    assert.equal(initial.results[0].code, 'protocol_verification_required');
    assert.equal(initial.results[0].phase, `${scope}_auth`);
    assert.equal(initial.results[0].loginStage, 'protocol_password');
    assert.equal(initial.results[0].httpStatus, 403);
    assert.ok(initial.logs.some((entry) => entry.stage === `${scope}_auth` && entry.status === 'needs_attention' && entry.httpStatus === 403));
    const savedAccount = (await app.saved()).state.children[0];
    const savedFailure = scope === 'team' ? savedAccount.teamLoginStates[app.workspaceId] : {
      stage: savedAccount.loginFailureStage, httpStatus: savedAccount.loginHttpStatus, code: savedAccount.loginErrorCode,
    };
    assert.equal(savedFailure.stage, 'protocol_password');
    assert.equal(savedFailure.httpStatus, 403);
    assert.equal(savedFailure.code, 'protocol_verification_required');
    assert.equal(app.requests.filter((request) => request.path === '/api/accounts/password/verify').length, 1);
    const initialLoginCalls = app.requests.filter((request) => request.path.startsWith('/oauth/')
      || request.path.startsWith('/api/accounts/') || request.path === '/fixture/sentinel').length;
    const repeated = await app.runJob(jobSelection(scope));
    assert.equal(repeated.succeeded, 0);
    assert.equal(repeated.needsAttention, 1);
    assert.equal(repeated.results[0].code, 'protocol_verification_required');
    assert.equal(repeated.results[0].phase, `${scope}_auth`);
    assert.equal(repeated.results[0].loginStage, 'protocol_password');
    assert.equal(repeated.results[0].httpStatus, 403);
    assert.equal(app.requests.filter((request) => request.path.startsWith('/oauth/')
      || request.path.startsWith('/api/accounts/') || request.path === '/fixture/sentinel').length, initialLoginCalls,
    'the same protocol verification must not submit another login request');
    assert.ok(!app.requests.some((request) => request.path === '/fixture/token'));
    assertProtocolOnlyRequests(app.requests);
    assertNoSecrets(initial);
    assertNoSecrets(repeated);
    assertNoSecrets(app.output());
  });

  for (const code of ['phone_verification_required', 'email_otp_required', 'totp_invalid', 'password_invalid']) {
    test(`switching ${scope} Roxy to protocol preserves a ${code} pause`, { timeout: 20000 }, async (t) => {
      const prior = priorBrowserSession(scope, { code });
      if (scope === 'free') prior.loginStatus = code === 'phone_verification_required' ? code
        : code === 'password_invalid' ? 'login_required' : 'waiting_code';
      else prior.teamLoginStates.target_team_workspace.status = code === 'phone_verification_required' ? code
        : code === 'password_invalid' ? 'login_required' : 'waiting_code';
      const app = await fixture(t, { browserFlow: true, teamFlow: scope === 'team', priorFields: prior });
      assert.equal((await app.patch({ ...app.config, enabled: false })).status, 200);
      const job = await app.runJob(jobSelection(scope));
      assert.equal(job.succeeded, 0);
      assert.equal(job.needsAttention, 1);
      assert.equal(job.results[0].code, code);
      assert.ok(!app.requests.some((request) => ['/oauth/authorize', '/api/accounts/authorize/continue',
        '/api/accounts/password/verify', '/fixture/token'].includes(request.path)));
      assertProtocolOnlyRequests(app.requests);
      const account = (await app.saved()).state.children[0];
      assert.equal(scope === 'team' ? account.teamLoginBackends[app.workspaceId] : account.loginBackend, 'roxy');
      assertNoSecrets(job);
    });
  }
}
