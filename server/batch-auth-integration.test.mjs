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

const serverScript = fileURLToPath(new URL('./index.mjs', import.meta.url));

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

async function startApp(t, children, { refreshResponses = {}, concurrencyBarrier = 0, enableCallback = false, mothers = [], quickJsonAuthSessions = {}, consentShell = false, sub2apiExchangeResponses = null, sub2apiExchangeFailures = {}, sub2apiAuthResponse = null } = {}) {
  const requests = [];
  const grants = [];
  const sub2apiRequests = [];
  const sub2apiExchangeRequests = [];
  let active = 0;
  let maxActive = 0;
  let waiting = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/api/v1/')) {
      sub2apiRequests.push({ method: req.method, pathname });
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const exchange = pathname === '/api/v1/admin/openai/exchange-code';
      if (exchange) sub2apiExchangeRequests.push(body);
      const failure = exchange ? sub2apiExchangeFailures[body.code] : null;
      const payload = exchange ? sub2apiExchangeResponses?.[body.code]
        : pathname === '/api/v1/admin/openai/generate-auth-url' ? sub2apiAuthResponse : null;
      res.writeHead(failure?.status || (payload ? 200 : 503), { 'content-type': 'application/json' });
      res.end(JSON.stringify(failure?.payload || (payload ? { data: payload } : { message: 'unexpected_isolated_sub2api_request' })));
      return;
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const refreshToken = form.get('refresh_token') || form.get('code');
    requests.push(refreshToken);
    grants.push({ type: form.get('grant_type'), verifier: form.get('code_verifier') });
    active += 1;
    maxActive = Math.max(maxActive, active);
    const finish = () => {
      active -= 1;
      const payload = refreshResponses[refreshToken];
      res.writeHead(payload ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload || { error: 'invalid_grant' }));
    };
    if (concurrencyBarrier && requests.length <= concurrencyBarrier) {
      waiting.push(finish);
      if (waiting.length === concurrencyBarrier) {
        const batch = waiting;
        waiting = [];
        batch.forEach((complete) => complete());
      }
    } else finish();
  });
  const upstreamPort = await listen(upstream);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'batch-auth-integration-'));
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1,
    settings: {
      concurrency: 2, autoRefill: false,
      ...(sub2apiExchangeResponses || sub2apiAuthResponse || Object.keys(sub2apiExchangeFailures).length ? { integrations: { sub2apis: [{
        id: 'fixture-sub2api-provider', name: 'Isolated Sub2API', baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'fixture-sub2api-key', groupId: 11, enabled: true,
      }] } } : {}),
    },
    mothers,
    children,
    quickJsonAuthSessions,
    history: [],
  }));
  const port = await unusedPort();
  const callbackPort = enableCallback ? await unusedPort() : null;
  let output = '';
  const preload = `
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (${JSON.stringify(consentShell)} && url.hostname === 'auth.openai.com') {
        if (url.pathname === '/oauth/authorize') return new Response('', { status: 302, headers: { location: 'https://auth.openai.com/workspace' } });
        if (['/workspace', '/sign-in-with-chatgpt/codex/consent'].includes(url.pathname)) return new Response('<!doctype html><div id="app">Official consent page shell</div>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url.hostname === 'auth.openai.com' && ['/api/oauth/oauth2/token', '/oauth/token'].includes(url.pathname)) {
        return nativeFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/token`)}, options);
      }
      if (url.hostname !== '127.0.0.1') throw new Error('isolated_test_external_network_disabled');
      return nativeFetch(input, options);
    };
  `;
  const app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      TEAM_ROTATION_DATA_DIR: dataDir,
      TEAM_ROTATION_DATA_KEY: 'batch-auth-test-key',
      TEAM_ROTATION_API_TOKEN: '',
      TEAM_ROTATION_LOGIN_PASSWORD: 'batch-auth-test-password',
      DISABLE_MAINTENANCE: 'true',
      OPENAI_CALLBACK_ENABLED: enableCallback ? 'true' : 'false',
      ...(callbackPort ? { OPENAI_CALLBACK_PORT: String(callbackPort) } : {}),
      OPENAI_REQUEST_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (chunk) => { output += chunk.toString(); });
  app.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await exited;
    }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`server exited: ${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch {
      // Wait for the isolated server to bind.
    }
    await delay(25);
  }
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'batch-auth-test-password' }),
  });
  assert.equal(login.status, 200, await login.text());
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(cookie || '', /^team_rotation_session=/);
  async function acquire(body) {
    const response = await fetch(`${baseUrl}/api/children/acquire-missing-json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  async function state() {
    const response = await fetch(`${baseUrl}/api/state`, { headers: { cookie } });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function acquireChild(id, body = { mode: 'free-json' }) {
    const response = await fetch(`${baseUrl}/api/children/${encodeURIComponent(id)}/acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  async function acquireTeam(id, body) {
    const response = await fetch(`${baseUrl}/api/children/${encodeURIComponent(id)}/team-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  async function acquireQuick(body) {
    const response = await fetch(`${baseUrl}/api/tools/quick-json/acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(7000),
    });
    return { status: response.status, data: await response.json() };
  }
  async function persistedState() {
    const saved = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
    if (!saved.encrypted) return saved;
    const key = createHash('sha256').update('batch-auth-test-key').digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(saved.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'base64')), decipher.final()]).toString());
  }
  async function callback(state, code, expectedStatus = 200, host = '127.0.0.1') {
    const response = await fetch(`http://${host}:${callbackPort}/auth/callback?${new URLSearchParams({ state, code })}`);
    const text = await response.text();
    assert.equal(response.status, expectedStatus, text);
    return { status: response.status, text };
  }
  return { acquire, acquireChild, acquireTeam, acquireQuick, state, persistedState, requests, grants, sub2apiRequests, sub2apiExchangeRequests, callback, maxActive: () => maxActive };
}

function browserPending(id, email) {
  return {
    id,
    email,
    status: 'login_pending',
    loginStatus: 'verification_required',
    loginMessage: '登录需要浏览器验证，请打开授权链接完成验证后重试',
    loginBrowserRequired: true,
    loginUrl: `https://auth.example.test/authorize?state=${id}`,
  };
}

test('batch acquisition skips browser verification by default and returns its safe auth URL', async (t) => {
  const child = {
    ...browserPending('browser-1', 'browser-one@example.test'),
    password: 'test-secret-password',
    totp: 'test-secret-totp',
    refreshToken: 'test-secret-rt',
    authSession: { codeVerifier: 'test-secret-verifier', cookies: [{ value: 'test-secret-cookie' }] },
  };
  const app = await startApp(t, [child]);
  const result = await app.acquire({});
  assert.equal(result.status, 200);
  assert.equal(result.data.status, 207);
  assert.equal(result.data.attempted, 0);
  assert.equal(result.data.skipped, 1);
  assert.equal(result.data.results[0].skipped, true);
  assert.equal(result.data.results[0].browserRequired, true);
  assert.match(result.data.results[0].authUrl, /^https:\/\/auth\.example\.test\/authorize\?/);
  assert.equal(app.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(result.data), /test-secret-/);
});

test('explicit verification retry attempts browser-pending accounts without retrying phone or OTP states', async (t) => {
  const browser = { ...browserPending('browser-2', 'browser-two@example.test'), refreshToken: 'browser-rt' };
  const phone = {
    ...browserPending('phone-1', 'phone-one@example.test'),
    status: 'phone_verification_required',
    loginStatus: 'phone_verification_required',
  };
  const otp = {
    ...browserPending('otp-1', 'otp-one@example.test'),
    loginStatus: 'waiting_code',
    status: 'login_required',
  };
  const app = await startApp(t, [browser, phone, otp], {
    refreshResponses: { 'browser-rt': refreshedToken(browser.email, 'browser-2') },
  });
  const result = await app.acquire({ retryVerification: true });
  assert.equal(result.status, 200);
  assert.equal(result.data.status, 207);
  const byEmail = new Map(result.data.results.map((item) => [item.email, item]));
  assert.equal(byEmail.get(browser.email).skipped, undefined);
  assert.equal(byEmail.get(browser.email).ok, true);
  assert.equal(byEmail.get(browser.email).source, 'refresh_token');
  assert.equal(byEmail.get(browser.email).browserRequired, false);
  assert.equal(byEmail.get(browser.email).authUrl, null);
  assert.equal(byEmail.get(phone.email).skipped, true);
  assert.equal(byEmail.get(otp.email).skipped, true);
  assert.equal(byEmail.get(phone.email).browserRequired, false);
  assert.equal(byEmail.get(phone.email).authUrl, null);
  assert.equal(byEmail.get(otp.email).browserRequired, false);
  assert.equal(byEmail.get(otp.email).authUrl, null);
  assert.equal(result.data.attempted, 1);
  assert.equal(result.data.skipped, 2);
  assert.deepEqual(app.requests, ['browser-rt']);
  const persisted = await app.state();
  const persistedChildren = new Map(persisted.children.map((item) => [item.email, item]));
  assert.equal(persistedChildren.get(phone.email).login.status, 'phone_verification_required');
  assert.equal(persistedChildren.get(otp.email).login.status, 'waiting_code');
});

function refreshedToken(email, identity) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: identity,
    'https://api.openai.com/auth': { chatgpt_account_id: `personal-${identity}`, chatgpt_plan_type: 'free' },
    'https://api.openai.com/profile': { email },
  })).toString('base64url');
  return { access_token: `${header}.${payload}.test-signature`, refresh_token: `new-${identity}-rt`, expires_in: 3600 };
}

test('explicit browser verification retries obey configured batch concurrency', async (t) => {
  const children = Array.from({ length: 3 }, (_, index) => ({
    ...browserPending(`parallel-${index}`, `parallel-${index}@example.test`),
    refreshToken: `parallel-${index}-rt`,
  }));
  const refreshResponses = Object.fromEntries(children.map((child) => [child.refreshToken, refreshedToken(child.email, child.id)]));
  const app = await startApp(t, children, { refreshResponses, concurrencyBarrier: 2 });
  const result = await app.acquire({ retryVerification: true });
  assert.equal(result.data.concurrency, 2);
  assert.equal(result.data.attempted, 3);
  assert.equal(result.data.acquired, 3);
  assert.equal(result.data.skipped, 0);
  assert.equal(app.maxActive(), 2);
  assert.equal(app.requests.length, 3);
});

test('normal batch acquisition still refreshes RT-only accounts without exposing tokens', async (t) => {
  const child = { id: 'rt-only', email: 'rt-only@example.test', refreshToken: 'private-original-rt', loginStatus: 'login_required' };
  const response = refreshedToken(child.email, child.id);
  const app = await startApp(t, [child], { refreshResponses: { [child.refreshToken]: response } });
  const result = await app.acquire({});
  assert.equal(result.data.status, 200);
  assert.equal(result.data.acquired, 1);
  assert.equal(result.data.results[0].source, 'refresh_token');
  assert.equal(result.data.results[0].authUrl, null);
  assert.doesNotMatch(JSON.stringify(result.data), /private-original-rt|new-rt-only-rt|test-signature/);
});

test('explicit retry resumes an official MFA step and requests its missing TOTP without restarting authorization', async (t) => {
  const child = { ...browserPending('no-rt', 'no-rt@example.test'), password: 'test-private-password', authSession: {
    state: 'fixture-official-mfa-state', codeVerifier: 'private-official-mfa-verifier', currentUrl: 'https://auth.openai.com/mfa-challenge/fixture-official-mfa',
  } };
  const app = await startApp(t, [child]);
  const result = await app.acquire({ retryVerification: true });
  assert.equal(result.data.attempted, 1);
  assert.equal(result.data.skipped, 0);
  assert.equal(result.data.results[0].code, 'totp_required');
  assert.equal(result.data.results[0].needsInput, true);
  assert.equal(result.data.results[0].browserRequired, false);
  assert.equal(result.data.results[0].authUrl, null);
  const persisted = await app.state();
  assert.equal(persisted.children[0].login.status, 'waiting_code');
  assert.equal(persisted.children[0].login.browserRequired, false);
  assert.equal(persisted.children[0].login.authUrl, null);
  assert.equal(app.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(result.data), /test-private-password/);
});

test('explicit batch retry resumes the matching saved OAuth session and callback', async (t) => {
  const child = {
    ...browserPending('callback-child', 'callback-child@example.test'),
    password: 'test-private-password',
    totp: 'JBSWY3DPEHPK3PXP',
    authSession: {
      state: 'saved-oauth-state',
      codeVerifier: 'saved-private-pkce-verifier',
      currentUrl: 'https://auth.openai.com/log-in',
      phase: 'verification_required',
    },
  };
  const app = await startApp(t, [child], {
    enableCallback: true,
    refreshResponses: { 'returned-oauth-code': refreshedToken(child.email, child.id) },
  });
  await app.callback('saved-oauth-state', 'returned-oauth-code');
  const result = await app.acquire({ retryVerification: true });
  assert.equal(result.data.acquired, 1);
  assert.equal(result.data.results[0].source, 'email_password_2fa');
  assert.deepEqual(app.requests, ['returned-oauth-code']);
  assert.deepEqual(app.grants, [{ type: 'authorization_code', verifier: 'saved-private-pkce-verifier' }]);
  assert.equal(result.data.results[0].authUrl, null);
  assert.doesNotMatch(JSON.stringify(result.data), /test-private-password|JBSWY3DPEHPK3PXP|saved-private-pkce-verifier|returned-oauth-code/);
});

test('normal batch acquisition completes arrived browser callbacks without verification retry, password, or TOTP', async (t) => {
  const child = {
    ...browserPending('normal-callback-child', 'normal-callback-child@example.test'),
    authSession: {
      state: 'normal-batch-callback-state',
      codeVerifier: 'normal-batch-private-verifier',
      currentUrl: 'https://auth.openai.com/log-in',
      phase: 'verification_required',
    },
  };
  const app = await startApp(t, [child], {
    enableCallback: true,
    refreshResponses: { 'normal-batch-callback-code': refreshedToken(child.email, child.id) },
  });
  await app.callback(child.authSession.state, 'normal-batch-callback-code');
  const result = await app.acquire({});
  assert.equal(result.data.acquired, 1);
  assert.equal(result.data.failed, 0);
  assert.equal(result.data.skipped, 0);
  assert.equal(result.data.results[0].ok, true);
  assert.equal(result.data.results[0].authUrl, null);
  assert.deepEqual(app.requests, ['normal-batch-callback-code']);
  assert.deepEqual(app.grants, [{ type: 'authorization_code', verifier: child.authSession.codeVerifier }]);
  const saved = (await app.persistedState()).children[0];
  assert.equal(saved.authSession, null);
  assert.equal(saved.loginStatus, 'ready');
  assert.equal(saved.chatgptUserId, child.id);
  assert.doesNotMatch(JSON.stringify(result.data), /normal-batch-private-verifier|normal-batch-callback-code|test-signature/);
});

test('single-account JSON acquisition completes the matching browser callback before an existing usable RT', async (t) => {
  const id = 'callback-before-rt-child';
  const email = 'callback-before-rt@example.test';
  const original = refreshedToken(email, id);
  const returned = { ...refreshedToken(email, id), refresh_token: 'fixture-returned-callback-rt' };
  const child = {
    ...browserPending(id, email),
    accessToken: original.access_token,
    refreshToken: 'fixture-existing-usable-rt',
    chatgptUserId: id,
    accountId: `personal-${id}`,
    authSession: {
      state: 'callback-before-rt-state',
      codeVerifier: 'callback-before-rt-verifier',
      currentUrl: 'https://auth.openai.com/log-in',
    },
  };
  const app = await startApp(t, [child], {
    enableCallback: true,
    refreshResponses: {
      [child.refreshToken]: original,
      'callback-before-rt-code': returned,
    },
  });
  await app.callback(child.authSession.state, 'callback-before-rt-code');
  const result = await app.acquireChild(id);
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.deepEqual(app.requests, ['callback-before-rt-code']);
  assert.deepEqual(app.grants, [{ type: 'authorization_code', verifier: child.authSession.codeVerifier }]);
  const saved = (await app.persistedState()).children[0];
  assert.equal(saved.refreshToken, returned.refresh_token);
  assert.equal(saved.chatgptUserId, child.chatgptUserId);
  assert.equal(saved.accountId, child.accountId);
  assert.equal(saved.email, child.email);
  assert.doesNotMatch(JSON.stringify(result.data), /fixture-existing-usable-rt|fixture-returned-callback-rt|callback-before-rt-verifier|callback-before-rt-code/);
});

test('single-account callback identity mismatch preserves the original identity and credentials instead of using the old RT', async (t) => {
  const id = 'callback-wrong-identity-child';
  const email = 'callback-wrong-identity@example.test';
  const original = refreshedToken(email, id);
  const child = {
    ...browserPending(id, email),
    accessToken: original.access_token,
    refreshToken: 'fixture-protected-existing-rt',
    chatgptUserId: id,
    accountId: `personal-${id}`,
    authSession: {
      state: 'protected-identity-callback-state',
      codeVerifier: 'protected-identity-callback-verifier',
    },
  };
  const app = await startApp(t, [child], {
    enableCallback: true,
    refreshResponses: {
      [child.refreshToken]: original,
      'protected-identity-callback-code': refreshedToken('another-account@example.test', 'another-account-user'),
    },
  });
  await app.callback(child.authSession.state, 'protected-identity-callback-code');
  const result = await app.acquireChild(id);
  assert.equal(result.status, 502);
  assert.equal(result.data.code, 'token_identity_mismatch');
  assert.deepEqual(app.requests, ['protected-identity-callback-code']);
  const saved = (await app.persistedState()).children[0];
  for (const field of ['email', 'chatgptUserId', 'accountId', 'accessToken', 'refreshToken']) {
    assert.equal(saved[field], child[field], `${field} must remain unchanged after an identity mismatch`);
  }
});

test('callback listener persists a matching callback so it can resume with an empty inbox after restart', async (t) => {
  const child = {
    ...browserPending('persisted-callback-child', 'persisted-callback-child@example.test'),
    authSession: {
      state: 'persisted-browser-callback-state',
      codeVerifier: 'persisted-browser-callback-verifier',
      currentUrl: 'https://auth.openai.com/log-in',
    },
  };
  const app = await startApp(t, [child], { enableCallback: true });
  await app.callback(child.authSession.state, 'persisted-browser-callback-code');
  const saved = await app.persistedState();
  const stored = saved.children.find((item) => item.id === child.id);
  assert.equal(typeof stored.authSession.callbackUrl, 'string', 'the listener must persist the matching callback before acknowledging success');
  const callbackUrl = new URL(stored.authSession.callbackUrl);
  assert.equal(callbackUrl.searchParams.get('state'), child.authSession.state);
  assert.equal(callbackUrl.searchParams.get('code'), 'persisted-browser-callback-code');
  assert.equal(stored.authSession.codeVerifier, child.authSession.codeVerifier);
  assert.equal(Number.isFinite(Date.parse(stored.authSession.callbackReceivedAt)), true);
  assert.ok(Math.abs(Date.now() - Date.parse(stored.authSession.callbackReceivedAt)) < 5000);
  assert.deepEqual(app.requests, []);

  // A new isolated process has no callback inbox; only the persisted session
  // can resume the authorization received by the previous process.
  const restarted = await startApp(t, saved.children, {
    refreshResponses: { 'persisted-browser-callback-code': refreshedToken(child.email, child.id) },
  });
  const result = await restarted.acquireChild(child.id);
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.deepEqual(restarted.requests, ['persisted-browser-callback-code']);
  assert.deepEqual(restarted.grants, [{ type: 'authorization_code', verifier: child.authSession.codeVerifier }]);
  assert.equal((await restarted.persistedState()).children[0].authSession, null);
  assert.doesNotMatch(JSON.stringify(await restarted.state()), /persisted-browser-callback-code|persisted-browser-callback-verifier/);
});

test('callback listener rejects an unknown state without polluting any account', async (t) => {
  const child = {
    ...browserPending('unknown-state-protected-child', 'unknown-state-protected@example.test'),
    authSession: { state: 'known-account-callback-state', codeVerifier: 'known-account-private-verifier' },
  };
  const app = await startApp(t, [child], { enableCallback: true });
  const before = (await app.persistedState()).children;
  const response = await app.callback('unknown-account-callback-state', 'unknown-account-callback-code', 400);
  assert.equal(response.status, 400);
  assert.deepEqual((await app.persistedState()).children, before);
  assert.deepEqual(app.requests, []);
  assert.doesNotMatch(JSON.stringify(await app.state()), /unknown-account-callback-code|known-account-private-verifier/);
});

test('callback listener persists the exact matching primary and additional Team owner sessions', async (t) => {
  const workspaceId = 'owner-listener-workspace';
  const mother = {
    id: 'owner-listener-mother', team: workspaceId, accountId: workspaceId, email: 'primary-owner@example.test',
    teamAuthSessions: {
      [workspaceId]: { state: 'primary-owner-callback-state', codeVerifier: 'primary-owner-private-verifier' },
    },
    ownerAccounts: [{
      email: 'additional-owner@example.test', accountId: workspaceId,
      teamAuthSessions: {
        [workspaceId]: { state: 'additional-owner-callback-state', codeVerifier: 'additional-owner-private-verifier' },
      },
    }],
  };
  const app = await startApp(t, [], { enableCallback: true, mothers: [mother] });
  await app.callback('primary-owner-callback-state', 'primary-owner-callback-code');
  let saved = (await app.persistedState()).mothers.find((item) => item.id === mother.id);
  assert.equal(new URL(saved.teamAuthSessions[workspaceId].callbackUrl).searchParams.get('code'), 'primary-owner-callback-code');
  assert.equal(saved.ownerAccounts[0].teamAuthSessions[workspaceId].callbackUrl, undefined, 'a primary owner callback must not alter the additional owner session');
  await app.callback('additional-owner-callback-state', 'additional-owner-callback-code');
  saved = (await app.persistedState()).mothers.find((item) => item.id === mother.id);
  assert.equal(new URL(saved.ownerAccounts[0].teamAuthSessions[workspaceId].callbackUrl).searchParams.get('code'), 'additional-owner-callback-code');
  assert.equal(saved.teamAuthSessions[workspaceId].codeVerifier, 'primary-owner-private-verifier');
  assert.equal(saved.ownerAccounts[0].teamAuthSessions[workspaceId].codeVerifier, 'additional-owner-private-verifier');
  assert.deepEqual(app.requests, []);
  assert.doesNotMatch(JSON.stringify(await app.state()), /primary-owner-callback-code|additional-owner-callback-code|primary-owner-private-verifier|additional-owner-private-verifier/);
});

test('expired persisted browser callbacks are cleared without exchanging their authorization code', async (t) => {
  const state = 'expired-persisted-callback-state';
  const child = {
    ...browserPending('expired-persisted-callback-child', 'expired-callback@example.test'),
    authSession: {
      state, codeVerifier: 'expired-callback-private-verifier',
      callbackUrl: `http://localhost:1455/auth/callback?state=${state}&code=expired-callback-code`,
      callbackReceivedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
    },
  };
  const app = await startApp(t, [child], {
    refreshResponses: { 'expired-callback-code': refreshedToken(child.email, child.id) },
  });
  const result = await app.acquire({});
  assert.equal(result.data.acquired, 0);
  assert.equal(result.data.attempted, 0);
  assert.equal(result.data.skipped, 1);
  assert.deepEqual(app.requests, []);
  const saved = (await app.persistedState()).children[0];
  assert.equal(saved.authSession.callbackUrl, undefined);
  assert.equal(saved.authSession.callbackReceivedAt, undefined);
});

test('an expired callback cannot be recovered again from currentUrl after its persisted callback is cleared', async (t) => {
  const state = 'expired-current-url-state';
  const callbackUrl = `http://localhost:1455/auth/callback?state=${state}&code=expired-current-url-code`;
  const child = {
    ...browserPending('expired-current-url-child', 'expired-current-url@example.test'),
    password: 'fixture-expired-url-password', totp: 'JBSWY3DPEHPK3PXP',
    authSession: {
      state, codeVerifier: 'expired-current-url-private-verifier', currentUrl: callbackUrl,
      callbackUrl, callbackReceivedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
    },
  };
  const app = await startApp(t, [child], {
    refreshResponses: { 'expired-current-url-code': refreshedToken(child.email, child.id) },
  });
  const result = await app.acquireChild(child.id);
  assert.equal(result.data.ok, false);
  assert.deepEqual(app.requests, [], 'an expired callback must never reach the token exchange even via currentUrl');
  const saved = (await app.persistedState()).children[0];
  assert.notEqual(saved.authSession?.currentUrl, callbackUrl);
  assert.equal(Boolean(saved.authSession?.callbackUrl), false);
});

test('callback exchange retry keeps its original received timestamp instead of extending its validity', async (t) => {
  const state = 'timestamp-preserved-callback-state';
  const receivedAt = new Date(Date.now() - 60_000).toISOString();
  const callbackUrl = `http://localhost:1455/auth/callback?state=${state}&code=timestamp-preserved-callback-code`;
  const child = {
    ...browserPending('timestamp-preserved-child', 'timestamp-preserved@example.test'),
    authSession: { state, codeVerifier: 'timestamp-preserved-verifier', callbackUrl, callbackReceivedAt: receivedAt },
  };
  // The isolated OAuth server returns invalid_grant for the fixture code.
  const app = await startApp(t, [child]);
  const result = await app.acquireChild(child.id);
  assert.equal(result.data.ok, false);
  assert.equal(result.data.code, 'token_exchange_failed');
  const saved = (await app.persistedState()).children[0];
  assert.equal(saved.authSession.callbackUrl, callbackUrl);
  assert.equal(saved.authSession.callbackReceivedAt, receivedAt);
  assert.deepEqual(app.requests, ['timestamp-preserved-callback-code']);
  assert.doesNotMatch(JSON.stringify(await app.state()), /timestamp-preserved-callback-code|timestamp-preserved-verifier/);
});

function teamTokenResponse(email, identity, workspaceId) {
  const response = refreshedToken(email, identity);
  const parts = response.access_token.split('.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  claims['https://api.openai.com/auth'].chatgpt_account_id = workspaceId;
  claims['https://api.openai.com/auth'].chatgpt_plan_type = 'team';
  response.access_token = `${parts[0]}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${parts[2]}`;
  return response;
}

test('Quick Team browser authorization resumes after restart from an independent persisted session without replacing Free credentials', async (t) => {
  const id = 'quick-independent-session-child';
  const email = 'quick-independent-session@example.test';
  const workspaceId = 'quick-independent-session-workspace';
  const original = refreshedToken(email, id);
  const child = {
    id, email, status: 'ready', plan: 'free', accessToken: original.access_token,
    refreshToken: 'quick-protected-original-rt', accountId: `personal-${id}`, chatgptUserId: id,
  };
  const mother = { id: 'quick-independent-mother', team: workspaceId, accountId: workspaceId, email: 'quick-owner@example.test' };
  const app = await startApp(t, [child], {
    enableCallback: true, consentShell: true, mothers: [mother],
    refreshResponses: { 'quick-independent-browser-code': teamTokenResponse(email, id, workspaceId) },
  });
  const initial = await app.acquireQuick({
    scope: 'team', email, motherId: mother.id, password: 'quick-temporary-password', totp: 'JBSWY3DPEHPK3PXP',
  });
  assert.equal(initial.data.ok, false);
  assert.equal(initial.data.code, 'workspace_list_unavailable');
  assert.equal(initial.data.needsInput, true);
  const oauthState = new URL(initial.data.authUrl).searchParams.get('state');
  assert.ok(oauthState);
  let saved = await app.persistedState();
  const registryKey = JSON.stringify(['team', email, workspaceId]);
  const entry = saved.quickJsonAuthSessions[registryKey];
  assert.ok(entry, 'a failed temporary Quick login must keep its own recoverable session');
  assert.equal(entry.session.state, oauthState);
  assert.ok(entry.expiresAt > Date.now() && entry.expiresAt <= Date.now() + 15 * 60_000);
  const verifier = entry.session.codeVerifier;
  assert.ok(verifier);
  for (const field of ['accessToken', 'refreshToken', 'accountId', 'chatgptUserId']) assert.equal(saved.children[0][field], child[field]);
  assert.equal(saved.children[0].teamAuthSessions?.[workspaceId], undefined);
  assert.doesNotMatch(JSON.stringify(await app.state()), /quickJsonAuthSessions|quick-temporary-password/);
  await app.callback(oauthState, 'quick-independent-browser-code');
  saved = await app.persistedState();
  assert.equal(new URL(saved.quickJsonAuthSessions[registryKey].session.callbackUrl).searchParams.get('code'), 'quick-independent-browser-code');
  const restarted = await startApp(t, saved.children, {
    mothers: saved.mothers, quickJsonAuthSessions: saved.quickJsonAuthSessions,
    refreshResponses: { 'quick-independent-browser-code': teamTokenResponse(email, id, workspaceId) },
  });
  const resumed = await restarted.acquireQuick({ scope: 'team', email, motherId: mother.id });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.ok, true);
  assert.equal(resumed.data.account.credentials.chatgpt_account_id, workspaceId);
  assert.equal(resumed.data.account.credentials.plan_type, 'team');
  assert.deepEqual(app.requests, []);
  assert.deepEqual(restarted.requests, ['quick-independent-browser-code']);
  assert.deepEqual(restarted.grants, [{ type: 'authorization_code', verifier }]);
  saved = await restarted.persistedState();
  for (const field of ['accessToken', 'refreshToken', 'accountId', 'chatgptUserId']) assert.equal(saved.children[0][field], child[field]);
  assert.equal(saved.quickJsonAuthSessions[registryKey], undefined, 'a successful Quick exchange must discard its temporary session');
  assert.equal(saved.children[0].teamAuthSessions?.[workspaceId], undefined);
  assert.doesNotMatch(JSON.stringify(await restarted.state()), /quickJsonAuthSessions|quick-independent-browser-code|quick-temporary-password/);
});

test('expired Quick authorization sessions are neither accepted by the listener nor reused for Quick JSON', async (t) => {
  const id = 'quick-expired-session-child';
  const email = 'quick-expired-session@example.test';
  const workspaceId = 'quick-expired-session-workspace';
  const child = { id, email, status: 'ready', plan: 'free' };
  const mother = { id: 'quick-expired-mother', team: workspaceId, accountId: workspaceId, email: 'quick-expired-owner@example.test' };
  const registryKey = JSON.stringify(['team', email, workspaceId]);
  const app = await startApp(t, [child], {
    enableCallback: true, mothers: [mother],
    quickJsonAuthSessions: {
      [registryKey]: {
        scope: 'team', email, workspaceId, expiresAt: Date.now() - 1000,
        session: { state: 'quick-expired-state', codeVerifier: 'quick-expired-private-verifier' },
      },
    },
  });
  await app.callback('quick-expired-state', 'quick-expired-code', 400);
  const result = await app.acquireQuick({ scope: 'team', email, motherId: mother.id });
  assert.equal(result.status, 400);
  assert.equal(result.data.code, 'refresh_token_required');
  assert.deepEqual(app.requests, []);
  assert.equal((await app.persistedState()).quickJsonAuthSessions[registryKey], undefined);
  assert.doesNotMatch(JSON.stringify(await app.state()), /quickJsonAuthSessions|quick-expired-code|quick-expired-private-verifier/);
});

test('an independently authorized Quick account can resume without adding any record to the Free pool', async (t) => {
  const email = 'quick-not-in-free-pool@example.test';
  const registryKey = JSON.stringify(['free', email, '']);
  const app = await startApp(t, [], {
    enableCallback: true,
    refreshResponses: { 'quick-outside-pool-code': refreshedToken(email, 'quick-outside-pool-user') },
    quickJsonAuthSessions: {
      [registryKey]: {
        scope: 'free', email, workspaceId: '', expiresAt: Date.now() + 15 * 60_000,
        session: { state: 'quick-outside-pool-state', codeVerifier: 'quick-outside-pool-private-verifier' },
      },
    },
  });
  await app.callback('quick-outside-pool-state', 'quick-outside-pool-code');
  const result = await app.acquireQuick({ scope: 'free', email });
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.account.credentials.plan_type, 'free');
  assert.equal(result.data.account.credentials.chatgpt_account_id, 'personal-quick-outside-pool-user');
  assert.deepEqual(app.requests, ['quick-outside-pool-code']);
  assert.deepEqual(app.grants, [{ type: 'authorization_code', verifier: 'quick-outside-pool-private-verifier' }]);
  const saved = await app.persistedState();
  assert.deepEqual(saved.children, []);
  assert.equal(saved.quickJsonAuthSessions[registryKey], undefined);
  assert.doesNotMatch(JSON.stringify(await app.state()), /quickJsonAuthSessions|quick-outside-pool-private-verifier|quick-outside-pool-code/);
});

for (const conflict of ['email', 'user']) {
  test(`external OAuth ${conflict} conflict is rejected before any Sub2API group lookup or account write`, async (t) => {
    const id = `external-conflict-${conflict}-child`;
    const email = `external-conflict-${conflict}@example.test`;
    const original = refreshedToken(email, id);
    const oauthState = `external-conflict-${conflict}-state`;
    const callbackCode = `external-conflict-${conflict}-code`;
    const child = {
      ...browserPending(id, email), accessToken: original.access_token, refreshToken: `external-original-${conflict}-rt`,
      accountId: `personal-${id}`, chatgptUserId: id,
      authSession: {
        state: oauthState,
        authorization: {
          source: 'sub2api', providerId: 'fixture-sub2api-provider', sessionId: `external-${conflict}-session`, state: oauthState,
          authUrl: `https://auth.openai.com/oauth/authorize?state=${oauthState}`,
          redirectUri: 'http://localhost:1455/auth/callback',
        },
      },
    };
    const wrongToken = refreshedToken(conflict === 'email' ? 'another-user@example.test' : email, conflict === 'user' ? 'another-user-id' : id);
    const app = await startApp(t, [child], {
      enableCallback: true, sub2apiExchangeResponses: { [callbackCode]: wrongToken },
    });
    await app.callback(oauthState, callbackCode);
    const result = await app.acquireChild(id);
    assert.equal(result.status, 409);
    assert.equal(result.data.code, 'token_identity_mismatch');
    assert.deepEqual(app.sub2apiRequests, [{ method: 'POST', pathname: '/api/v1/admin/openai/exchange-code' }]);
    assert.deepEqual(app.requests, [], 'a rejected external callback must not fall back to a fresh local login or old RT');
    const saved = (await app.persistedState()).children[0];
    for (const field of ['email', 'chatgptUserId', 'accountId', 'accessToken', 'refreshToken']) {
      assert.equal(saved[field], child[field], `${field} must remain unchanged on an external OAuth ${conflict} conflict`);
    }
    assert.doesNotMatch(JSON.stringify(result.data), /external-original-.*-rt|another-user-id|test-signature/);
  });
}

for (const rejection of [
  { status: 400, payload: { message: 'session not found or expired' } },
  { status: 404, payload: { error: { code: 'session_not_found' } } },
]) {
  test(`expired external OAuth ${rejection.status} replaces only the rejected session and accepts its new callback`, async (t) => {
    const id = `provider-expired-${rejection.status}`;
    const email = `${id}@example.test`;
    const oldState = `${id}-old-state`;
    const newState = `${id}-new-state`;
    const oldCode = `${id}-old-code`;
    const newCode = `${id}-new-code`;
    const token = refreshedToken(email, id);
    const child = {
      ...browserPending(id, email),
      accessToken: token.access_token, refreshToken: `${id}-original-rt`,
      accountId: `personal-${id}`, chatgptUserId: id,
      authSession: {
        state: oldState, cookies: { 'old-provider-cookie': 'fixture-private-cookie' },
        authorization: {
          source: 'sub2api', providerId: 'fixture-sub2api-provider', sessionId: `${id}-old-session`, state: oldState,
          authUrl: `https://auth.openai.com/oauth/authorize?state=${oldState}`,
          redirectUri: 'http://localhost:1455/auth/callback',
        },
      },
    };
    const other = {
      id: 'unrelated-provider-child', email: 'unrelated-provider@example.test', status: 'available',
      accessToken: refreshedToken('unrelated-provider@example.test', 'unrelated-provider-child').access_token,
      refreshToken: 'fixture-unrelated-original-rt',
      authSession: { state: 'unrelated-provider-state', codeVerifier: 'fixture-unrelated-verifier' },
    };
    const app = await startApp(t, [child, other], {
      enableCallback: true,
      sub2apiExchangeFailures: { [oldCode]: rejection },
      sub2apiExchangeResponses: { [newCode]: { ...token, refresh_token: `${id}-new-rt` } },
      sub2apiAuthResponse: {
        state: newState, session_id: `${id}-new-session`,
        auth_url: `https://auth.openai.com/oauth/authorize?state=${newState}`,
      },
    });
    await app.callback(oldState, oldCode);
    const result = await app.acquireChild(id);
    assert.equal(result.status, 202);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.code, 'oauth_session_expired');
    assert.equal(result.data.browserRequired, true);
    assert.equal(result.data.needsInput, true);
    assert.match(result.data.message, /过期|失效/);
    assert.equal(new URL(result.data.authUrl).searchParams.get('state'), newState);
    assert.deepEqual(app.sub2apiRequests, [
      { method: 'POST', pathname: '/api/v1/admin/openai/exchange-code' },
      { method: 'POST', pathname: '/api/v1/admin/openai/generate-auth-url' },
    ]);
    assert.deepEqual(app.requests, [], 'recovery must not repeat password login or refresh the original RT');
    let saved = await app.persistedState();
    const recovered = saved.children.find((item) => item.id === id);
    assert.equal(recovered.authSession.state, newState);
    assert.equal(recovered.authSession.authorization.sessionId, `${id}-new-session`);
    assert.equal(Boolean(recovered.authSession.callbackUrl), false);
    assert.equal(Boolean(recovered.authSession.codeVerifier), false);
    assert.deepEqual(recovered.authSession.cookies, {});
    assert.equal(recovered.accessToken, child.accessToken);
    assert.equal(recovered.refreshToken, child.refreshToken);
    assert.deepEqual(saved.children.find((item) => item.id === other.id).authSession, other.authSession);
    assert.equal(saved.children.find((item) => item.id === other.id).refreshToken, other.refreshToken);
    await app.callback(oldState, oldCode, 400);
    await app.callback(newState, newCode);
    const completed = await app.acquireChild(id);
    assert.equal(completed.status, 200);
    assert.equal(completed.data.ok, true);
    assert.equal(completed.data.code, 'ready');
    assert.deepEqual(app.sub2apiExchangeRequests.map((item) => item.code), [oldCode, newCode]);
    assert.deepEqual(app.sub2apiExchangeRequests.map((item) => item.session_id), [`${id}-old-session`, `${id}-new-session`]);
    saved = await app.persistedState();
    assert.equal(saved.children.find((item) => item.id === id).refreshToken, `${id}-new-rt`);
    assert.equal(saved.children.find((item) => item.id === other.id).refreshToken, other.refreshToken);
    assert.doesNotMatch(JSON.stringify(await app.state()), /fixture-private-cookie|fixture-unrelated-verifier|old-session|new-session|old-code|new-code/);
  });
}

for (const status of [408, 429, 503]) {
  test(`external OAuth ${status} retains its original callback even if its message mentions session expiry`, async (t) => {
    const id = `provider-transient-${status}`;
    const oauthState = `${id}-state`;
    const code = `${id}-code`;
    const callbackUrl = `http://localhost:1455/auth/callback?state=${oauthState}&code=${code}`;
    const receivedAt = new Date(Date.now() - 60_000).toISOString();
    const child = {
      ...browserPending(id, `${id}@example.test`),
      authSession: {
        state: oauthState, callbackUrl, callbackReceivedAt: receivedAt,
        authorization: {
          source: 'sub2api', providerId: 'fixture-sub2api-provider', sessionId: `${id}-session`, state: oauthState,
          authUrl: `https://auth.openai.com/oauth/authorize?state=${oauthState}`,
        },
      },
    };
    const app = await startApp(t, [child], {
      sub2apiExchangeFailures: { [code]: { status, payload: { message: 'session not found or expired' } } },
    });
    for (let retry = 0; retry < 2; retry += 1) {
      const result = await app.acquireChild(id);
      assert.equal(result.status, status);
      assert.equal(result.data.code, 'sub2api_oauth_exchange_failed');
      const saved = (await app.persistedState()).children[0];
      assert.equal(saved.authSession.callbackUrl, callbackUrl);
      assert.equal(saved.authSession.callbackReceivedAt, receivedAt);
      assert.equal(saved.authSession.authorization.sessionId, `${id}-session`);
    }
    assert.deepEqual(app.sub2apiRequests.map((item) => item.pathname), [
      '/api/v1/admin/openai/exchange-code', '/api/v1/admin/openai/exchange-code',
    ]);
    assert.deepEqual(app.requests, []);
  });
}

test('a completed Sub2API browser authorization is consumed on the next Free JSON click instead of creating another link', async (t) => {
  const id = 'provider-callback-after-link-child';
  const email = 'callback-user@example.test';
  const state = 'provider-callback-after-link-state';
  const code = 'provider-callback-after-link-code';
  const sessionId = 'provider-callback-after-link-session';
  const child = {
    id, email, password: 'fixture-password', totp: 'JBSWY3DPEHPK3PXP', status: 'login_required',
  };
  const app = await startApp(t, [child], {
    enableCallback: true,
    sub2apiAuthResponse: {
      state, session_id: sessionId,
      auth_url: `https://auth.openai.com/oauth/authorize?state=${state}`,
    },
    sub2apiExchangeResponses: {
      [code]: refreshedToken(email, id),
    },
  });

  // The first click only obtains the provider link; the browser callback is
  // delivered asynchronously after the user finishes authorization.
  const first = await app.acquireChild(id, { mode: 'free-json' });
  assert.equal(first.status, 502);
  assert.equal(first.data.ok, false);
  assert.equal(first.data.browserRequired, false);
  assert.deepEqual(app.sub2apiRequests, [{ method: 'POST', pathname: '/api/v1/admin/openai/generate-auth-url' }]);
  const pending = (await app.persistedState()).children[0];
  assert.equal(pending.authSession.state, state);
  assert.equal(pending.authSession.authorization.sessionId, sessionId);

  await app.callback(state, code, 200, 'localhost');
  const receivedCallback = (await app.persistedState()).children[0].authSession.callbackUrl;
  assert.match(receivedCallback, /^http:\/\/localhost:/);
  await app.callback(state, code, 200, '[::1]');
  assert.equal(new URL((await app.persistedState()).children[0].authSession.callbackUrl).hostname, '[::1]');
  const second = await app.acquireChild(id, { mode: 'free-json' });
  assert.equal(second.status, 200);
  assert.equal(second.data.ok, true);
  assert.equal(second.data.code, 'ready');
  assert.deepEqual(app.sub2apiRequests, [
    { method: 'POST', pathname: '/api/v1/admin/openai/generate-auth-url' },
    { method: 'POST', pathname: '/api/v1/admin/openai/exchange-code' },
    { method: 'GET', pathname: '/api/v1/admin/accounts' },
  ], 'the completed callback must be exchanged without requesting a second authorization link');
  const saved = (await app.persistedState()).children[0];
  assert.equal(saved.authSession, null);
  assert.equal(saved.loginStatus, 'ready');
  assert.doesNotMatch(JSON.stringify(second.data), /fixture-password|JBSWY3DPEHPK3PXP|provider-callback-after-link-code/);
});

function manualCallbackFixture(kind, { external = false, missingSession = false } = {}) {
  const identity = `manual-${kind}-${external ? 'provider' : 'local'}`;
  const email = `${identity}@example.test`;
  const workspaceId = `${identity}-workspace`;
  const state = `${identity}-state`;
  const code = `${identity}-code`;
  const session = external ? {
    state,
    authorization: {
      source: 'sub2api', providerId: 'fixture-sub2api-provider', sessionId: `${identity}-session`, state,
      authUrl: `https://auth.openai.com/oauth/authorize?state=${state}`,
      redirectUri: 'http://localhost:1455/auth/callback',
    },
  } : {
    state, codeVerifier: `${identity}-private-verifier`,
    currentUrl: 'https://auth.openai.com/log-in', phase: 'verification_required',
  };
  const isTeam = kind === 'team' || kind === 'quick-team';
  const isQuick = kind.startsWith('quick-');
  const original = refreshedToken(email, identity);
  const token = isTeam ? teamTokenResponse(email, identity, workspaceId) : refreshedToken(email, identity);
  token.refresh_token = `${identity}-returned-rt`;
  const mother = { id: `${identity}-mother`, team: workspaceId, accountId: workspaceId, email: `${identity}-owner@example.test` };
  const retryAfter = new Date(Date.now() + 5 * 60_000).toISOString();
  const child = {
    ...browserPending(identity, email), password: `${identity}-original-password`, totp: 'JBSWY3DPEHPK3PXP',
    accessToken: original.access_token, refreshToken: `${identity}-original-rt`,
    chatgptUserId: identity, accountId: `personal-${identity}`,
    authSession: { state: `${identity}-unrelated-free-state`, codeVerifier: `${identity}-unrelated-free-verifier` },
    teamAuthSessions: {},
    teamLoginStates: {
      [workspaceId]: {
        status: 'browser_verification_required', code: 'browser_verification_required',
        browserRequired: true, needsInput: true,
        authUrl: `https://auth.openai.com/oauth/authorize?state=${state}`,
        retryAfter,
      },
    },
    workspaceHistory: [{
      team: workspaceId, status: 'active', teamAuthRetryAfter: retryAfter,
      teamAuthLastError: 'fixture-existing-team-backoff', workspaceTokenStatus: 'login_required',
    }],
  };
  const registryKey = JSON.stringify([isTeam ? 'team' : 'free', email, isTeam ? workspaceId : '']);
  const quickJsonAuthSessions = isQuick && !missingSession ? {
    [registryKey]: { scope: isTeam ? 'team' : 'free', email, workspaceId: isTeam ? workspaceId : '', expiresAt: Date.now() + 15 * 60_000, session },
  } : {};
  if (!isQuick) {
    if (isTeam && !missingSession) child.teamAuthSessions[workspaceId] = session;
    if (!isTeam) child.authSession = missingSession ? null : session;
  }
  const body = isQuick ? { scope: isTeam ? 'team' : 'free', email, ...(isTeam ? { motherId: mother.id } : {}) }
    : isTeam ? { motherId: mother.id } : { mode: 'free-json' };
  return { identity, email, workspaceId, state, code, session, token, child, mother, registryKey, quickJsonAuthSessions, body, isTeam, isQuick };
}

function submitManualCallback(app, fixture, callbackUrl, extra = {}) {
  const body = { ...fixture.body, ...extra, callbackUrl };
  return fixture.isQuick ? app.acquireQuick(body)
    : fixture.isTeam ? app.acquireTeam(fixture.identity, body) : app.acquireChild(fixture.identity, body);
}

for (const { kind, host = 'localhost' } of [
  { kind: 'free' }, { kind: 'team' }, { kind: 'team', host: '[::1]' }, { kind: 'quick-free' }, { kind: 'quick-team' },
]) {
  test(`manual ${kind} ${host} callback exchanges the original PKCE session and returns complete credentials`, async (t) => {
    const fixture = manualCallbackFixture(kind);
    const app = await startApp(t, [fixture.child], {
      mothers: [fixture.mother], quickJsonAuthSessions: fixture.quickJsonAuthSessions,
      refreshResponses: { [fixture.code]: fixture.token },
    });
    const before = await app.persistedState();
    const result = await submitManualCallback(app, fixture, `http://${host}:1455/auth/callback?${new URLSearchParams({ state: fixture.state, code: fixture.code })}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.ok, true);
    assert.deepEqual(app.requests, [fixture.code], 'a pasted callback must take precedence over an existing RT');
    assert.deepEqual(app.grants, [{ type: 'authorization_code', verifier: fixture.session.codeVerifier }]);
    assert.deepEqual(app.sub2apiRequests, [], 'manual completion must not generate another authorization link');
    const saved = await app.persistedState();
    if (fixture.isQuick) {
      assert.equal(result.data.account.credentials.access_token, fixture.token.access_token);
      assert.equal(result.data.account.credentials.refresh_token, fixture.token.refresh_token);
      assert.deepEqual(saved.children, before.children, 'Quick JSON must preserve the managed account credentials and membership');
      assert.equal(saved.quickJsonAuthSessions[fixture.registryKey], undefined);
    } else if (fixture.isTeam) {
      const stored = saved.children[0];
      assert.equal(stored.workspaceTokens[fixture.workspaceId].accessToken, fixture.token.access_token);
      assert.equal(stored.workspaceTokens[fixture.workspaceId].refreshToken, fixture.token.refresh_token);
      assert.equal(stored.teamAuthSessions[fixture.workspaceId], undefined);
      assert.equal(stored.workspaceHistory[0].teamAuthRetryAfter, null);
      assert.equal(stored.refreshToken, fixture.child.refreshToken, 'Team completion must preserve the personal RT');
    } else {
      assert.equal(saved.children[0].accessToken, fixture.token.access_token);
      assert.equal(saved.children[0].refreshToken, fixture.token.refresh_token);
      assert.equal(saved.children[0].authSession, null);
      assert.equal(saved.children[0].loginUrl, null);
    }
    if (!fixture.isQuick) assert.doesNotMatch(JSON.stringify(result.data), new RegExp(`${fixture.code}|${fixture.session.codeVerifier}|${fixture.token.refresh_token}`));
  });
}

for (const kind of ['free', 'team']) {
  test(`manual ${kind} callback consumes the original Sub2API authorization without generating a new link`, async (t) => {
    const fixture = manualCallbackFixture(kind, { external: true });
    const app = await startApp(t, [fixture.child], {
      mothers: [fixture.mother], sub2apiExchangeResponses: { [fixture.code]: fixture.token },
    });
    const result = await submitManualCallback(app, fixture, `http://localhost:1455/auth/callback?${new URLSearchParams({ state: fixture.state, code: fixture.code })}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.ok, true);
    assert.deepEqual(app.requests, [], 'a provider session must not fall back to password login or the personal RT');
    assert.equal(app.sub2apiExchangeRequests.length, 1);
    assert.equal(app.sub2apiExchangeRequests[0].session_id, fixture.session.authorization.sessionId);
    assert.equal(app.sub2apiExchangeRequests[0].code, fixture.code);
    assert.equal(app.sub2apiRequests.some((item) => item.pathname.endsWith('/generate-auth-url')), false);
    const saved = (await app.persistedState()).children[0];
    const token = fixture.isTeam ? saved.workspaceTokens[fixture.workspaceId] : saved;
    assert.equal(token.accessToken, fixture.token.access_token);
    assert.equal(token.refreshToken, fixture.token.refresh_token);
    assert.doesNotMatch(JSON.stringify(result.data), new RegExp(`${fixture.code}|${fixture.token.refresh_token}`));
  });
}

for (const kind of ['free', 'team', 'quick-free', 'quick-team']) {
  test(`manual ${kind} rejects an invalid callback before changing the original session, credentials, links, or Team backoff`, async (t) => {
    const fixture = manualCallbackFixture(kind, { external: kind === 'free' || kind === 'team' });
    const app = await startApp(t, [fixture.child], {
      mothers: [fixture.mother], quickJsonAuthSessions: fixture.quickJsonAuthSessions,
      sub2apiExchangeResponses: { [fixture.code]: fixture.token }, refreshResponses: { [fixture.code]: fixture.token },
    });
    const before = await app.persistedState();
    const query = new URLSearchParams({ state: fixture.state, code: fixture.code });
    for (const [callbackUrl, errorCode] of [
      [`http://outside.example.test:1455/auth/callback?${query}`, 'callback_invalid'],
      [`https://localhost:1455/auth/callback?${query}`, 'callback_invalid'],
      [`http://localhost:1455/wrong/callback?${query}`, 'callback_invalid'],
      [`http://localhost:1455/auth/callback?state=unrelated-state&code=${fixture.code}`, 'callback_state_mismatch'],
      [`http://localhost:1455/auth/callback?code=${fixture.code}`, 'callback_state_mismatch'],
      [`http://localhost:1455/auth/callback?state=${fixture.state}`, 'callback_code_missing'],
    ]) {
      const result = await submitManualCallback(app, fixture, callbackUrl, { password: 'fixture-must-not-replace-password', totp: 'JBSWY3DPEHPK3PXP' });
      assert.equal(result.status, 400, `${kind}: ${errorCode}: ${JSON.stringify(result.data)}`);
      assert.equal(result.data.code, errorCode);
      const saved = await app.persistedState();
      assert.deepEqual(saved.children, before.children, `${kind}: an invalid callback must preserve account and Team authorization state`);
      assert.deepEqual(saved.quickJsonAuthSessions, before.quickJsonAuthSessions, `${kind}: an invalid callback must preserve its independent Quick session`);
      assert.deepEqual(app.requests, []);
      assert.deepEqual(app.sub2apiRequests, []);
      assert.doesNotMatch(JSON.stringify(result.data), new RegExp(fixture.code));
    }
  });

  test(`manual ${kind} rejects a callback without its original OAuth session instead of generating a replacement`, async (t) => {
    const fixture = manualCallbackFixture(kind, { missingSession: true });
    const app = await startApp(t, [fixture.child], {
      mothers: [fixture.mother], refreshResponses: { [fixture.code]: fixture.token },
    });
    const before = await app.persistedState();
    const result = await submitManualCallback(app, fixture, `http://localhost:1455/auth/callback?${new URLSearchParams({ state: fixture.state, code: fixture.code })}`);
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.equal(result.data.code, 'callback_session_missing');
    const saved = await app.persistedState();
    assert.deepEqual(saved.children, before.children);
    assert.deepEqual(saved.quickJsonAuthSessions, before.quickJsonAuthSessions);
    assert.deepEqual(app.requests, []);
    assert.deepEqual(app.sub2apiRequests, []);
  });
}
