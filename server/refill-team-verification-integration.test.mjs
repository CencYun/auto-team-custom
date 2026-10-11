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
const roxyModule = new URL('./roxy-browser.mjs', import.meta.url).href;
const workspaceId = 'refill-browser-team-workspace';
const motherId = 'refill-browser-team-mother';
const childId = 'refill-browser-team-child';
const childEmail = 'refill-browser-member@example.test';
const freeAuthUrl = 'https://auth.example.test/free-authorize?state=fixture-free-only-state';

function token(email, identity, accountId, planType) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600, sub: identity,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: planType, chatgpt_user_id: identity },
    'https://api.openai.com/profile': { email },
  })).toString('base64url');
  return `${header}.${payload}.fixture-signature`;
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t, { teamAuthSessions = {}, teamLoginStates = {}, browserChallenge = true, noMfa = false } = {}) {
  const requests = [];
  const roxyProfiles = new Map([['fixture-child-profile', { dirId: 'fixture-child-profile', windowRemark: `auto-team:child:${childId}` }]]);
  const openRoxyProfiles = new Set();
  let roxySequence = 0;
  const grants = [];
  const browserSessions = new Map();
  const freeToken = token(childEmail, childId, 'refill-browser-personal-workspace', 'free');
  const teamToken = token(childEmail, childId, workspaceId, 'team');
  const members = [
    { id: 'refill-owner-user', email: 'refill-owner@example.test', role: 'account-owner', seat_type: 'default' },
    { id: childId, email: childEmail, role: 'standard-user', seat_type: 'default' },
  ];
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const entry = { method: req.method, path: url.pathname, browserMode: req.headers['x-fixture-browser-mode'] || '' };
    requests.push(entry);
    if (url.pathname.startsWith('/browser/')) {
      assert.equal(req.headers.token, 'fixture-private-roxy');
      const body = raw ? JSON.parse(raw) : null;
      let data = {};
      if (req.method === 'GET' && url.pathname === '/browser/list_v3') {
        data = { rows: [...roxyProfiles.values()], total: roxyProfiles.size };
      } else if (req.method === 'POST' && url.pathname === '/browser/create') {
        assert.equal(body.workspaceId, 'fixture-roxy-workspace');
        const profile = { dirId: `fixture-roxy-${++roxySequence}`, windowRemark: body.windowRemark, windowName: body.windowName };
        roxyProfiles.set(profile.dirId, profile);
        data = { dirId: profile.dirId };
      } else if (req.method === 'GET' && url.pathname === '/browser/connection_info') {
        const dirId = url.searchParams.get('dirIds');
        data = openRoxyProfiles.has(dirId) ? [{ dirId }] : [];
      } else if (req.method === 'POST' && url.pathname === '/browser/open') {
        assert.ok(roxyProfiles.has(body.dirId));
        assert.equal(openRoxyProfiles.has(body.dirId), false);
        openRoxyProfiles.add(body.dirId);
        data = { ws: `ws://127.0.0.1:${upstream.address().port}/devtools/browser/${body.dirId}` };
      } else if (req.method === 'POST' && url.pathname === '/browser/close') {
        assert.equal(openRoxyProfiles.delete(body.dirId), true);
      } else if (req.method === 'POST' && url.pathname === '/browser/delete') {
        assert.equal(body.isSoftDelete, true);
        for (const dirId of body.dirIds) {
          assert.equal(openRoxyProfiles.has(dirId), false);
          assert.equal(roxyProfiles.delete(dirId), true);
        }
      } else {
        entry.unexpected = true;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 1, msg: 'unexpected_fixture_roxy_request' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data }));
      return;
    }
    if (url.pathname === '/mock-auth/oauth/authorize') {
      entry.state = url.searchParams.get('state');
      browserSessions.set(entry.state, { redirectUri: url.searchParams.get('redirect_uri') });
      res.writeHead(302, { location: 'https://auth.openai.com/workspace', 'set-cookie': 'fixture-auth-cookie=fixture-private-cookie; Path=/; HttpOnly' });
      res.end();
      return;
    }
    if (['/mock-auth/workspace', '/mock-auth/sign-in-with-chatgpt/codex/consent'].includes(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><div id="app">Official consent shell with no structured workspace data</div>');
      return;
    }
    let status = 200;
    let payload;
    if (url.pathname === '/mock-auth/browser/workspace/select') {
      const body = JSON.parse(raw);
      entry.selectedWorkspace = body.workspaceId;
      const session = browserSessions.get(body.state);
      assert.equal(body.workspaceId, workspaceId);
      assert.ok(session, 'the original browser authorization state must exist');
      session.selectedWorkspace = body.workspaceId;
      payload = { callbackUrl: session.redirectUri + '?' + new URLSearchParams({ state: body.state, code: 'fixture-browser-team-code:' + body.state }) };
    } else if (url.pathname === '/mock-auth/oauth/token') {
      const form = new URLSearchParams(raw);
      grants.push({ type: form.get('grant_type'), verifier: form.get('code_verifier'), code: form.get('code') });
      const code = form.get('code') || '';
      if (code === 'fixture-team-callback-code' || browserSessions.get(code.replace(/^fixture-browser-team-code:/, ''))?.selectedWorkspace === workspaceId) {
        payload = { access_token: teamToken, refresh_token: 'fixture-new-team-rt' };
      } else {
        status = 400;
        payload = { error: 'invalid_grant' };
      }
    } else if (req.method === 'GET' && url.pathname === '/backend-api/subscriptions') {
      payload = { seats_in_use: 2, seats_entitled: 2, seat_capacity: [{ type: 'default', paid: 2, held: 0 }], assigned: { default: 2 } };
    } else if (req.method === 'GET' && url.pathname === `/backend-api/accounts/${workspaceId}/users`) {
      payload = { items: members, total: members.length, offset: 0, limit: 100 };
    } else if (req.method === 'GET' && url.pathname === '/backend-api/wham/usage') {
      payload = { rate_limit: { limit_reached: false, primary_window: { used_percent: 0, limit_window_seconds: 18000 }, secondary_window: { used_percent: 0, limit_window_seconds: 604800 } } };
    } else {
      status = 503;
      payload = { message: 'unexpected_isolated_request' };
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const upstreamPort = await listen(upstream);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'refill-team-verification-'));
  const port = await unusedPort();
  const callbackPort = await unusedPort();
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1,
    settings: { autoRefill: false, promoteJoinedAccounts: false, joinMode: 'invite', concurrency: 1, kickOnExhausted: false,
      integrations: { roxy: { enabled: true, baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'fixture-private-roxy', workspaceId: 'fixture-roxy-workspace', profiles: [{ childId, dirId: 'fixture-child-profile' }] } },
    },
    mothers: [{ id: motherId, team: workspaceId, accountId: workspaceId, email: 'refill-owner@example.test', primaryOwnerEmail: 'refill-owner@example.test', rotationMode: 'fixed', accessToken: token('refill-owner@example.test', 'refill-owner-user', workspaceId, 'team') }],
    children: [{
      id: childId, email: childEmail, status: 'active', team: workspaceId, plan: 'free', accountId: 'refill-browser-personal-workspace', chatgptUserId: childId,
      accessToken: freeToken, refreshToken: 'fixture-original-free-rt', password: 'fixture-private-password', totp: noMfa ? undefined : 'JBSWY3DPEHPK3PXP',
      loginStatus: 'verification_required', loginBrowserRequired: true, loginUrl: freeAuthUrl,
      authSession: { state: 'fixture-free-only-state', codeVerifier: 'fixture-private-free-pkce' },
      teamAuthSessions, teamLoginStates,
      workspaceHistory: [{ team: workspaceId, status: 'active', role: 'standard-user', seatType: 'default', joinStatus: 'member_confirmed_token_pending', workspaceTokenStatus: 'pending', joinedAt: new Date().toISOString() }],
    }],
    history: [],
  }));
  // Keep the real Roxy adapter and lifecycle; replace only browser I/O.
  const browserFixture = `
    export async function completeBrowserOAuth(options) {
      const session = await options.acquireSession({ timeoutMs: 1000 });
      try {
      const authorization = new URL(options.authUrl);
      if (authorization.origin !== 'https://auth.openai.com' || authorization.pathname !== '/oauth/authorize'
        || authorization.searchParams.get('state') !== options.expectedState
        || authorization.searchParams.get('redirect_uri') !== options.redirectUri) throw new Error('fixture_browser_invalid_oauth_binding');
      if (options.workspaceMode !== 'team' || options.workspaceId !== ${JSON.stringify(workspaceId)}) throw new Error('fixture_browser_wrong_team');
      if (options.email !== ${JSON.stringify(childEmail)} || options.password !== 'fixture-private-password') throw new Error('fixture_browser_wrong_credentials');
      if (!${JSON.stringify(noMfa)} && !/^\\d{6}$/.test(await options.getTotpCode())) throw new Error('fixture_browser_totp_missing');
      const headers = { 'content-type': 'application/json', 'x-fixture-browser-mode': options.workspaceMode };
      options.onProgress?.('browser_email', '正在填写登录邮箱');
      await fetch(options.authUrl, { headers, redirect: 'manual' });
      options.onProgress?.('browser_workspace', '正在选择目标工作空间');
      if (${JSON.stringify(browserChallenge)}) throw Object.assign(new Error('登录需要完成官方安全验证'), { code: 'browser_verification_required', status: 202, browserRequired: true, needsInput: true });
      const selected = await fetch('https://auth.openai.com/browser/workspace/select', { method: 'POST', headers, body: JSON.stringify({ state: options.expectedState, workspaceId: options.workspaceId }) });
      return selected.json();
      } finally { await session.close({ keepOpen: false }); }
    }
  `;
  const preload = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === './roxy-browser.mjs') return { url: 'fixture:refill-roxy-session', shortCircuit: true };
      return nextResolve(specifier, context);
    }, load(url, context, nextLoad) {
      if (url === 'fixture:refill-roxy-session') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
        export * from ${JSON.stringify(roxyModule)};
        import { openRoxyBrowserSession as actualOpen } from ${JSON.stringify(roxyModule)};
        export function openRoxyBrowserSession(options) {
          return actualOpen(options, { connect: async () => ({
            newPage: async () => ({ close: async () => {} }),
            createBrowserContext: async () => ({ newPage: async () => ({ close: async () => {} }), close: async () => {} }),
            disconnect: async () => {},
          }) });
        }
      `)} };
      if (url.endsWith('/openai-browser-login.mjs')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(browserFixture)} };
      return nextLoad(url, context);
    } });
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.hostname === 'auth.openai.com') return nativeFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/mock-auth`)} + url.pathname + url.search, options);
      if (url.hostname !== '127.0.0.1' || Number(url.port) !== ${upstreamPort}) throw new Error('isolated_external_network_disabled');
      return nativeFetch(input, options);
    };
  `;
  let output = '';
  const app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      TEAM_ROTATION_DATA_DIR: dataDir, TEAM_ROTATION_DATA_KEY: 'refill-team-verification-test-key', TEAM_ROTATION_API_TOKEN: '', TEAM_ROTATION_LOGIN_PASSWORD: 'fixture-dashboard-password',
      DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: 'true', OPENAI_CALLBACK_PORT: String(callbackPort), OPENAI_REQUEST_TIMEOUT_MS: '2000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (chunk) => { output += chunk; });
  app.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (app.exitCode === null && app.signalCode === null) { const exited = new Promise((resolve) => app.once('exit', resolve)); app.kill(); await exited; }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    assert.equal(openRoxyProfiles.size, 0, 'every fixture Roxy session must close');
    const browserStarts = requests.filter((entry) => entry.path === '/mock-auth/oauth/authorize' && entry.browserMode).length;
    assert.equal(requests.filter((entry) => entry.path === '/browser/open').length, browserStarts, 'each browser OAuth flow acquires a Roxy session');
    assert.equal(requests.filter((entry) => entry.path === '/browser/close').length, browserStarts, 'successful and challenged browser flows close their Roxy sessions');
    assert.equal(requests.some((entry) => entry.unexpected), false);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`fixture server exited: ${output}`);
    try { if ((await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Wait for the isolated listener. */ }
    await delay(25);
  }
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'fixture-dashboard-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  return {
    requests, grants, freeToken, teamToken,
    async refill() {
      const response = await fetch(`${baseUrl}/api/maintenance/refill`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ motherId }), signal: AbortSignal.timeout(8000) });
      assert.equal(response.status, 200);
      return response.json();
    },
    async publicState() { return (await fetch(`${baseUrl}/api/state`, { headers: { cookie } })).json(); },
    async persistedState() {
      const saved = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
      if (!saved.encrypted) return saved;
      const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update('refill-team-verification-test-key').digest(), Buffer.from(saved.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'base64')), decipher.final()]).toString());
    },
    async callback(state) {
      const response = await fetch(`http://127.0.0.1:${callbackPort}/auth/callback?${new URLSearchParams({ state, code: 'fixture-team-callback-code' })}`);
      assert.equal(response.status, 200);
    },
  };
}

function publicTeamMember(snapshot) { return snapshot.teams.find((item) => item.id === motherId).currentAccounts.find((item) => item.email === childEmail); }
function assertNoSecrets(value) { assert.doesNotMatch(JSON.stringify(value), /fixture-private-cookie|fixture-private-password|fixture-private-free-pkce|JBSWY3DPEHPK3PXP|codeVerifier|teamAuthSessions|teamLoginStates/); }

test('refill preserves an active member Team browser challenge and resumes only its matching callback during backoff', async (t) => {
  const app = await fixture(t);
  const first = await app.refill();
  const failure = first.joinFailures.find((item) => item.id === childId && item.phase === 'workspace_token_retry');
  assert.ok(failure);
  assert.equal(failure.code, 'browser_verification_required');
  assert.equal(failure.needsInput, true);
  assert.equal(failure.browserRequired, true);
  assert.notEqual(failure.authUrl, freeAuthUrl);
  const officialUrl = new URL(failure.authUrl);
  assert.equal(officialUrl.hostname, 'auth.openai.com');
  const snapshot = await app.publicState();
  const projected = publicTeamMember(snapshot).teamLogin;
  assert.equal(projected.workspaceId, workspaceId);
  assert.equal(projected.code, failure.code);
  assert.equal(projected.status, 'browser_verification_required');
  assert.equal(projected.needsInput, true);
  assert.equal(projected.browserRequired, true);
  assert.equal(projected.authUrl, failure.authUrl);
  assert.equal(snapshot.children[0].login.authUrl, freeAuthUrl, 'the separate Free authorization state must remain separate');
  assertNoSecrets(first);
  assertNoSecrets(snapshot);
  let saved = (await app.persistedState()).children[0];
  const teamSession = saved.teamAuthSessions[workspaceId];
  const originalVerifier = teamSession.codeVerifier;
  assert.ok(originalVerifier);
  assert.ok(Date.parse(saved.workspaceHistory[0].teamAuthRetryAfter) > Date.now());
  const starts = app.requests.filter((item) => item.path === '/mock-auth/oauth/authorize').length;
  assert.equal(starts, 1);
  await app.callback('fixture-free-only-state');
  const second = await app.refill();
  const repeated = second.joinFailures.find((item) => item.id === childId);
  assert.equal(repeated.code, failure.code);
  assert.equal(repeated.needsInput, true);
  assert.equal(repeated.browserRequired, true);
  assert.equal(repeated.authUrl, failure.authUrl);
  assert.equal(app.requests.filter((item) => item.path === '/mock-auth/oauth/authorize').length, starts, 'ordinary refill must not restart OAuth while official verification is pending');
  assert.deepEqual(app.grants, [], 'a completed Free authorization cannot be consumed as the pending Team authorization');
  assertNoSecrets(second);

  await app.callback(teamSession.state);
  const recovered = await app.refill();
  assert.equal(recovered.joinFailures.some((item) => item.id === childId), false);
  assert.equal(recovered.teamJsonReady, 1);
  assert.equal(recovered.acceptedSeats, 0, 'recovering an existing member must not send another invitation');
  assert.deepEqual(app.grants, [{ type: 'authorization_code', verifier: originalVerifier, code: 'fixture-team-callback-code' }]);
  assert.equal(app.requests.filter((item) => item.path === '/mock-auth/oauth/authorize').length, starts);
  assert.equal(app.requests.some((item) => item.method !== 'GET' && item.path.startsWith('/backend-api/accounts/')), false, 'no invitation, role change, or kick is permitted in this fixture');
  saved = (await app.persistedState()).children[0];
  assert.equal(saved.accessToken, app.freeToken);
  assert.equal(saved.refreshToken, 'fixture-original-free-rt');
  assert.equal(saved.workspaceTokens[workspaceId].accessToken, app.teamToken);
  const recoveredMember = publicTeamMember(await app.publicState());
  assert.equal(recoveredMember.teamLogin.status, 'ready');
  assert.equal(recoveredMember.teamLogin.authUrl, null);
  assert.equal(recoveredMember.teamLogin.needsInput, false);
  assert.equal(recoveredMember.teamLogin.browserRequired, false);
  assert.equal(recoveredMember.quota5h, 100);
  assert.equal(recoveredMember.quota7d, 100);
  assertNoSecrets(recovered);
  assertNoSecrets(await app.publicState());
});

test('a legacy Team session opens only its own official browser authorization and never copies the Free login link', async (t) => {
  const originalState = 'fixture-legacy-team-state';
  const app = await fixture(t, {
    teamAuthSessions: {
      [workspaceId]: {
        state: originalState, codeVerifier: 'fixture-private-legacy-team-pkce', phase: 'workspace',
        currentUrl: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
        cookies: { 'fixture-auth-cookie': 'fixture-private-cookie' },
      },
    },
  });
  const result = await app.refill();
  const failure = result.joinFailures.find((item) => item.id === childId);
  assert.equal(failure.code, 'browser_verification_required');
  assert.equal(failure.browserRequired, true);
  const teamLink = new URL(failure.authUrl);
  assert.equal(teamLink.hostname, 'auth.openai.com');
  assert.equal(teamLink.pathname, '/oauth/authorize');
  assert.equal(teamLink.searchParams.get('state'), originalState);
  assert.notEqual(failure.authUrl, freeAuthUrl);
  const authorizations = app.requests.filter((item) => item.path === '/mock-auth/oauth/authorize');
  assert.deepEqual(authorizations.map((item) => ({ state: item.state, browserMode: item.browserMode })), [{ state: originalState, browserMode: 'team' }]);
  const snapshot = await app.publicState();
  assert.equal(publicTeamMember(snapshot).teamLogin.authUrl, failure.authUrl);
  assert.equal(snapshot.children[0].login.authUrl, freeAuthUrl);
  assertNoSecrets(result);
  assertNoSecrets(snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-private-legacy-team-pkce/);
});

test('refill automatically obtains the pending member target Team JSON using the browser flow while preserving Free authorization', async (t) => {
  const app = await fixture(t, { browserChallenge: false });
  const recovered = await app.refill();
  assert.deepEqual(recovered.joinFailures, []);
  assert.equal(recovered.teamJsonReady, 1);
  assert.equal(recovered.acceptedSeats, 0);
  const authorizations = app.requests.filter((item) => item.path === '/mock-auth/oauth/authorize');
  assert.equal(authorizations.length, 1);
  assert.equal(authorizations[0].browserMode, 'team');
  assert.notEqual(authorizations[0].state, 'fixture-free-only-state');
  assert.deepEqual(app.requests.filter((item) => item.selectedWorkspace).map((item) => item.selectedWorkspace), [workspaceId]);
  assert.equal(app.grants.length, 1);
  assert.equal(app.grants[0].type, 'authorization_code');
  assert.equal(app.grants[0].code, 'fixture-browser-team-code:' + authorizations[0].state);
  assert.ok(app.grants[0].verifier);
  assert.equal(app.requests.some((item) => item.method !== 'GET' && item.path.startsWith('/backend-api/accounts/')), false);
  const saved = (await app.persistedState()).children[0];
  assert.equal(saved.accessToken, app.freeToken);
  assert.equal(saved.refreshToken, 'fixture-original-free-rt');
  assert.equal(saved.authSession.state, 'fixture-free-only-state');
  assert.equal(saved.authSession.codeVerifier, 'fixture-private-free-pkce');
  assert.equal(saved.workspaceTokens[workspaceId].accessToken, app.teamToken);
  assert.equal(saved.teamAuthSessions[workspaceId], undefined);
  const snapshot = await app.publicState();
  const member = publicTeamMember(snapshot);
  assert.equal(member.teamLogin.status, 'ready');
  assert.equal(member.quota5h, 100);
  assert.equal(member.quota7d, 100);
  assert.equal(snapshot.children[0].login.authUrl, freeAuthUrl);
  assertNoSecrets(recovered);
  assertNoSecrets(snapshot);
});

test('refill retries the legacy workspace-list gap with the original Team PKCE through the browser flow', async (t) => {
  const originalState = 'fixture-legacy-list-gap-state';
  const originalVerifier = 'fixture-private-list-gap-pkce';
  const app = await fixture(t, {
    browserChallenge: false,
    teamAuthSessions: {
      [workspaceId]: {
        state: originalState, codeVerifier: originalVerifier, phase: 'workspace',
        currentUrl: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
      },
    },
    teamLoginStates: {
      [workspaceId]: { status: 'browser_verification_required', code: 'workspace_list_unavailable', browserRequired: true, needsInput: true, message: '授权页面未返回空间列表' },
    },
  });
  const result = await app.refill();
  assert.deepEqual(result.joinFailures, []);
  assert.equal(result.teamJsonReady, 1);
  assert.equal(result.acceptedSeats, 0);
  assert.deepEqual(app.requests.filter((item) => item.path === '/mock-auth/oauth/authorize').map((item) => ({ state: item.state, browserMode: item.browserMode })), [{ state: originalState, browserMode: 'team' }]);
  assert.deepEqual(app.grants, [{ type: 'authorization_code', verifier: originalVerifier, code: 'fixture-browser-team-code:' + originalState }]);
  const saved = (await app.persistedState()).children[0];
  assert.equal(saved.workspaceTokens[workspaceId].accessToken, app.teamToken);
  assert.equal(saved.accessToken, app.freeToken);
  assert.equal(saved.teamAuthSessions[workspaceId], undefined);
  const snapshot = await app.publicState();
  assert.equal(publicTeamMember(snapshot).quota5h, 100);
  assert.equal(publicTeamMember(snapshot).teamLogin.status, 'ready');
  assertNoSecrets(result);
  assertNoSecrets(snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-private-list-gap-pkce/);
});

test('refill logs in an existing password-only member through the browser without requiring a configured 2FA secret', async (t) => {
  const app = await fixture(t, { browserChallenge: false, noMfa: true });
  const result = await app.refill();
  assert.deepEqual(result.joinFailures, []);
  assert.equal(result.teamJsonReady, 1);
  assert.equal(result.acceptedSeats, 0);
  assert.deepEqual(app.requests.filter((item) => item.path === '/mock-auth/oauth/authorize').map((item) => item.browserMode), ['team']);
  assert.deepEqual(app.requests.filter((item) => item.selectedWorkspace).map((item) => item.selectedWorkspace), [workspaceId]);
  assert.deepEqual(app.grants.map((item) => item.type), ['authorization_code'], 'a missing TOTP secret must not route this login into personal-token workspace switching');
  assert.equal(app.requests.some((item) => item.method !== 'GET' && item.path.startsWith('/backend-api/accounts/')), false);
  const saved = (await app.persistedState()).children[0];
  assert.equal(saved.totp, undefined);
  assert.equal(saved.accessToken, app.freeToken);
  assert.equal(saved.refreshToken, 'fixture-original-free-rt');
  assert.equal(saved.authSession.state, 'fixture-free-only-state');
  assert.equal(saved.authSession.codeVerifier, 'fixture-private-free-pkce');
  assert.equal(saved.workspaceTokens[workspaceId].accessToken, app.teamToken);
  assert.equal(saved.workspaceTokens[workspaceId].refreshToken, 'fixture-new-team-rt');
  const snapshot = await app.publicState();
  const member = publicTeamMember(snapshot);
  assert.equal(member.teamLogin.status, 'ready');
  assert.equal(member.quota5h, 100);
  assert.equal(member.quota7d, 100);
  assert.equal(snapshot.children[0].login.authUrl, freeAuthUrl);
  assertNoSecrets(result);
  assertNoSecrets(snapshot);
});
