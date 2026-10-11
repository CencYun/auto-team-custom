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
const workspaceId = 'refill-pipeline-team';
const personalId = 'refill-pipeline-personal';
const motherId = 'refill-pipeline-mother';
const childId = 'refill-pipeline-child';
const childEmail = 'member@refill-pipeline.test';
const ownerEmail = 'owner@refill-pipeline.test';
const dataKey = 'refill-pipeline-test-only-key';

function token(accountId, email, plan) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: email === ownerEmail ? 'fixture-owner-user' : 'fixture-member-user',
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_user_id: email === ownerEmail ? 'fixture-owner-user' : 'fixture-member-user',
      chatgpt_plan_type: plan,
    },
    'https://api.openai.com/profile': { email },
  })).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

function requestClaims(req) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { return JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()); } catch { return {}; }
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

async function fixture(t, { browserChallenge = false, teamBrowserChallenge = false, existingMemberCallback = false, roxyEnabled = false } = {}) {
  const ownerToken = token(workspaceId, ownerEmail, 'team');
  const freeToken = token(personalId, childEmail, 'free');
  const teamToken = token(workspaceId, childEmail, 'self_serve_business_prolite');
  const requests = [];
  const roxyProfiles = new Map();
  const openRoxyProfiles = new Set();
  let roxySequence = 0;
  const authSessions = new Map();
  const members = [{ id: 'fixture-owner-user', email: ownerEmail, role: 'account-owner', seat_type: 'default' }];
  if (existingMemberCallback) members.push({ id: 'fixture-member-user', email: childEmail, role: 'standard-user', seat_type: 'default' });
  const invitations = [];
  const child = existingMemberCallback ? {
    id: childId,
    email: childEmail,
    status: 'active',
    team: workspaceId,
    accountId: personalId,
    chatgptUserId: 'fixture-member-user',
    accessToken: freeToken,
    refreshToken: 'fixture-existing-free-rt',
    workspaceTokens: {},
    workspaceHistory: [{ team: workspaceId, status: 'active', memberId: 'fixture-member-user', joinStatus: 'member_confirmed_token_pending', workspaceTokenStatus: 'pending' }],
    teamAuthSessions: {
      [workspaceId]: {
        state: 'fixture-completed-team-state',
        codeVerifier: 'fixture-completed-team-pkce',
        callbackUrl: 'http://localhost:1455/auth/callback?state=fixture-completed-team-state&code=fixture-completed-team-code',
        currentUrl: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
        phase: 'verification_required',
      },
    },
  } : {
    id: childId,
    email: childEmail,
    password: 'fixture-member-password',
    totp: 'JBSWY3DPEHPK3PXP',
    status: 'ready',
    workspaceTokens: {},
    workspaceHistory: [],
  };
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = new URLSearchParams(text); }
    const claims = requestClaims(req);
    const entry = { method: req.method, path: url.pathname, identity: claims.sub || '', tokenAccountId: claims['https://api.openai.com/auth']?.chatgpt_account_id || '', accountId: req.headers['chatgpt-account-id'] || '', browserMode: req.headers['x-fixture-browser-mode'] || '' };
    requests.push(entry);
    if (url.pathname.startsWith('/browser/')) {
      assert.equal(req.headers.token, 'fixture-private-roxy');
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
    const sessionState = String(req.headers.cookie || '').match(/(?:^|;\s*)fixture_oauth_state=([^;]+)/)?.[1] || '';
    const session = authSessions.get(sessionState);
    let status = 200;
    let payload = {};
    let headers = {};
    const authPath = url.pathname.replace(/^\/mock-auth/, '');
    const accountPath = `/backend-api/accounts/${workspaceId}`;
    if (url.pathname === '/mock-sentinel/backend-api/sentinel/req') {
      payload = { token: 'fixture-protocol-sentinel' };
    } else if (url.pathname.startsWith('/mock-auth')) {
      if (req.method === 'GET' && authPath === '/oauth/authorize') {
        const state = url.searchParams.get('state');
        authSessions.set(state, { redirectUri: url.searchParams.get('redirect_uri'), state });
        headers = { location: 'https://auth.openai.com/log-in', 'set-cookie': `fixture_oauth_state=${state}; Path=/; HttpOnly` };
        status = 302;
      } else if (req.method === 'GET' && ['/log-in', '/workspace'].includes(authPath)) {
        payload = {};
      } else if (req.method === 'POST' && authPath === '/api/accounts/authorize/continue') {
        entry.email = body?.username?.value;
        if (browserChallenge || (teamBrowserChallenge && members.some((member) => member.email === childEmail))) {
          status = 403;
          payload = { error: 'turnstile_required' };
        } else payload = { continue_url: 'https://auth.openai.com/log-in/password' };
      } else if (req.method === 'POST' && authPath === '/api/accounts/password/verify') {
        entry.passwordMatches = body?.password === 'fixture-member-password';
        payload = { continue_url: 'https://auth.openai.com/mfa-challenge/fixture-challenge' };
      } else if (req.method === 'POST' && authPath === '/api/accounts/mfa/verify') {
        entry.validTotpShape = body?.id === 'fixture-challenge' && body?.type === 'totp' && /^\d{6}$/.test(body?.code || '');
        const workspaces = [{ id: personalId, kind: 'personal' }, ...(members.some((member) => member.email === childEmail) ? [{ id: workspaceId, kind: 'team' }] : [])];
        const cookie = `${Buffer.from(JSON.stringify({ workspaces })).toString('base64url')}.fixture-signature`;
        headers['set-cookie'] = `oai-client-auth-session=${cookie}; Path=/; HttpOnly`;
        payload = { continue_url: 'https://auth.openai.com/workspace' };
      } else if (req.method === 'GET' && authPath === '/sign-in-with-chatgpt/codex/consent') {
        payload = {};
      } else if (req.method === 'POST' && authPath === '/api/accounts/workspace/select' && session) {
        entry.selectedWorkspace = body?.workspace_id;
        session.workspaceId = body?.workspace_id;
        payload = { continue_url: `${session.redirectUri}?${new URLSearchParams({ state: session.state, code: `fixture-code:${session.state}` })}` };
      } else if (req.method === 'POST' && ['/oauth/token', '/api/oauth/oauth2/token'].includes(authPath)) {
        const form = body instanceof URLSearchParams ? body : new URLSearchParams(text);
        entry.grantType = form.get('grant_type');
        entry.codeVerifier = form.get('code_verifier');
        const code = form.get('code') || '';
        const selected = code === 'fixture-completed-team-code' ? workspaceId : authSessions.get(code.replace(/^fixture-code:/, ''))?.workspaceId;
        if (entry.grantType === 'authorization_code' && [personalId, workspaceId].includes(selected)) {
          payload = { access_token: selected === workspaceId ? teamToken : freeToken, refresh_token: selected === workspaceId ? 'fixture-team-rt' : 'fixture-free-rt' };
        } else {
          status = 400;
          payload = { error: 'invalid_grant' };
        }
      } else {
        status = 503;
        payload = { error: 'unexpected_mock_auth_request' };
        entry.unexpected = true;
      }
    } else if (req.method === 'GET' && url.pathname === '/backend-api/subscriptions') {
      payload = { seats_in_use: members.length, seats_entitled: 2, seat_capacity: [{ type: 'default', paid: 2, held: 0 }], assigned: { default: members.length } };
    } else if (req.method === 'GET' && url.pathname === `${accountPath}/users`) {
      const query = (url.searchParams.get('query') || '').toLowerCase();
      const matching = query ? members.filter((member) => member.email.toLowerCase().includes(query)) : members;
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Number(url.searchParams.get('limit')) || 100;
      payload = { items: matching.slice(offset, offset + limit), total: matching.length, offset, limit };
    } else if (req.method === 'GET' && url.pathname === `${accountPath}/invites`) {
      payload = { items: invitations, total: invitations.length };
    } else if (req.method === 'POST' && url.pathname === `${accountPath}/invites`) {
      entry.invitedEmail = body?.email_addresses?.[0];
      const invitation = { id: 'fixture-invitation', email_address: entry.invitedEmail };
      invitations.push(invitation);
      payload = { account_invites: [invitation] };
    } else if (req.method === 'POST' && url.pathname === `${accountPath}/invites/accept`) {
      if (entry.identity !== 'fixture-member-user' || entry.tokenAccountId !== personalId) {
        status = 403;
        payload = { error: 'fixture_accept_requires_members_own_free_token' };
      } else {
        if (!members.some((member) => member.email === childEmail)) members.push({ id: 'fixture-member-user', email: childEmail, role: 'standard-user', seat_type: 'default' });
        payload = { success: true };
      }
    } else if (req.method === 'GET' && url.pathname === '/backend-api/wham/usage') {
      const ownTeam = entry.identity === 'fixture-member-user' && entry.tokenAccountId === workspaceId && entry.accountId === workspaceId;
      const ownerTeam = entry.identity === 'fixture-owner-user' && entry.tokenAccountId === workspaceId && entry.accountId === workspaceId;
      if (!ownTeam && !ownerTeam) {
        status = 403;
        payload = { error: 'fixture_usage_requires_own_target_team_token' };
      } else payload = { rate_limit: { primary_window: { used_percent: ownTeam ? 41 : 2, limit_window_seconds: 18000 }, secondary_window: { used_percent: ownTeam ? 66 : 3, limit_window_seconds: 604800 } } };
    } else {
      status = 503;
      payload = { error: 'unexpected_mock_upstream_request' };
      entry.unexpected = true;
    }
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  });
  const upstreamPort = await listen(upstream);
  const dataRoot = path.resolve(tmpdir());
  const dataDir = await mkdtemp(path.join(dataRoot, 'refill-pipeline-integration-'));
  let app;
  t.after(async () => {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await exited;
    }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(path.resolve(dataDir)), dataRoot);
    assert.match(path.basename(dataDir), /^refill-pipeline-integration-/);
    await rm(dataDir, { recursive: true, force: true });
    assert.equal(openRoxyProfiles.size, 0, 'every fixture Roxy session must close');
    const browserStarts = requests.filter((entry) => entry.path === '/mock-auth/oauth/authorize' && entry.browserMode).length;
    assert.equal(requests.filter((entry) => entry.path === '/browser/open').length, browserStarts, 'each browser OAuth flow acquires a Roxy session');
    assert.equal(requests.filter((entry) => entry.path === '/browser/close').length, browserStarts, 'successful and challenged browser flows close their Roxy sessions');
  });
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1,
    settings: { autoRefill: false, promoteJoinedAccounts: false, delayedKickEnabled: false, concurrency: 2, joinMode: 'invite', inviteSeatType: 'default',
      ...(roxyEnabled ? { integrations: { roxy: { enabled: true, baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'fixture-private-roxy', workspaceId: 'fixture-roxy-workspace', profiles: [] } } } : {}),
    },
    mothers: [{ id: motherId, team: workspaceId, accountId: workspaceId, teamName: 'Refill Pipeline Fixture', email: ownerEmail, primaryOwnerEmail: ownerEmail, accessToken: ownerToken, defaultSeatType: 'default', members: [] }],
    children: [child],
    history: [],
  }));
  const port = await unusedPort();
  const callbackPort = teamBrowserChallenge ? await unusedPort() : null;
  const baseUrl = `http://127.0.0.1:${port}`;
  // Replace only browser I/O. Roxy profile/session lifecycle, callback exchange,
  // identity checks, invitation, membership confirmation, and quota run intact.
  const browserFixture = `
    export async function completeBrowserOAuth(options) {
      const session = await options.acquireSession({ timeoutMs: 1000 });
      try {
      const authorization = new URL(options.authUrl);
      if (authorization.origin !== 'https://auth.openai.com' || authorization.pathname !== '/oauth/authorize'
        || authorization.searchParams.get('state') !== options.expectedState
        || authorization.searchParams.get('redirect_uri') !== options.redirectUri) throw new Error('fixture_browser_invalid_oauth_binding');
      if (options.workspaceMode === 'team' && options.workspaceId !== ${JSON.stringify(workspaceId)}) throw new Error('fixture_browser_wrong_team');
      const cookie = 'fixture_oauth_state=' + options.expectedState;
      const headers = { 'content-type': 'application/json', cookie, 'x-fixture-browser-mode': options.workspaceMode };
      const request = (pathname, body) => fetch('https://auth.openai.com' + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
      options.onProgress?.('browser_email', '正在填写登录邮箱');
      await fetch(options.authUrl, { headers, redirect: 'manual' });
      const email = await request('/api/accounts/authorize/continue', { username: { kind: 'email', value: options.email } });
      if (email.status === 403) throw Object.assign(new Error('登录需要完成官方安全验证'), { code: 'browser_verification_required', status: 202, browserRequired: true, needsInput: true });
      options.onProgress?.('browser_password', '正在填写登录密码');
      await request('/api/accounts/password/verify', { password: options.password });
      options.onProgress?.('browser_totp', '正在填写动态验证码');
      await request('/api/accounts/mfa/verify', { id: 'fixture-challenge', type: 'totp', code: await options.getTotpCode() });
      options.onProgress?.('browser_workspace', '正在选择目标工作空间');
      const selected = await request('/api/accounts/workspace/select', { workspace_id: options.workspaceMode === 'team' ? options.workspaceId : ${JSON.stringify(personalId)} });
      return { callbackUrl: (await selected.json()).continue_url };
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
      if (url.endsWith('/openai-sentinel.mjs')) return { format: 'module', shortCircuit: true, source: 'export async function fetchSentinelToken() { return "fixture-sentinel-only"; }' };
      return nextLoad(url, context);
    } });
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.hostname === 'auth.openai.com') return nativeFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/mock-auth`)} + url.pathname + url.search, options);
      if (url.hostname === 'sentinel.openai.com') return nativeFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/mock-sentinel`)} + url.pathname + url.search, options);
      if (url.hostname !== '127.0.0.1' || Number(url.port) !== ${upstreamPort}) throw new Error('isolated_test_external_network_disabled');
      return nativeFetch(input, options);
    };
  `;
  let output = '';
  app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`, TEAM_ROTATION_DATA_DIR: dataDir, TEAM_ROTATION_DATA_KEY: dataKey, TEAM_ROTATION_API_TOKEN: '', TEAM_ROTATION_LOGIN_PASSWORD: 'refill-pipeline-password', DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: callbackPort ? 'true' : 'false', ...(callbackPort ? { OPENAI_CALLBACK_PORT: String(callbackPort) } : {}), OPENAI_REQUEST_TIMEOUT_MS: '2000' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  app.stdout.on('data', (chunk) => { output += chunk.toString(); });
  app.stderr.on('data', (chunk) => { output += chunk.toString(); });
  let started = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`isolated test app exited: ${output}`);
    try { if ((await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(500) })).ok) { started = true; break; } } catch { /* Wait for the isolated app to bind. */ }
    await delay(25);
  }
  assert.ok(started, 'isolated app must start');
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'refill-pipeline-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(cookie || '', /^team_rotation_session=/);
  async function persistedState() {
    const saved = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
    if (!saved.encrypted) return saved;
    const key = createHash('sha256').update(dataKey).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(saved.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'base64')), decipher.final()]).toString());
  }
  return {
    requests, child, teamToken, freeToken, persistedState,
    async completeTeamCallback(state) {
      assert.ok(callbackPort, 'the callback fixture must be enabled');
      const response = await fetch(`http://127.0.0.1:${callbackPort}/auth/callback?${new URLSearchParams({ state, code: 'fixture-completed-team-code' })}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      await response.text();
    },
    async refill() {
      const response = await fetch(`${baseUrl}/api/maintenance/refill`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ motherId }), signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 200);
      return response.json();
    },
    async publicState() {
      const response = await fetch(`${baseUrl}/api/state`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

function memberQuota(state) {
  const row = state.teams.find((team) => team.id === motherId)?.currentAccounts.find((account) => account.email === childEmail);
  assert.ok(row, 'confirmed fixture member must be visible in the Team');
  return row;
}

for (const roxyEnabled of [false, true]) test(`refill uses ${roxyEnabled ? 'configured Roxy browser' : 'pure protocol'} for an email/password/2FA-only account through Free OAuth, invitation, Team JSON, and its own real quota`, { timeout: 25_000 }, async (t) => {
  const app = await fixture(t, { roxyEnabled });
  assert.equal(app.child.accessToken, undefined);
  assert.equal(app.child.refreshToken, undefined);
  const result = await app.refill();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.acceptedSeats, 1);
  assert.equal(result.joined.length, 1);
  assert.deepEqual(result.joinFailures, []);
  assert.equal(result.quotaCheck?.checked, 1);
  assert.equal(result.quotaCheck?.results[0]?.ok, true);
  const selects = app.requests.filter((request) => request.selectedWorkspace);
  assert.deepEqual(selects.map((request) => request.selectedWorkspace), [personalId, workspaceId]);
  const expectedModes = roxyEnabled ? ['free', 'team'] : ['', ''];
  assert.deepEqual(app.requests.filter((request) => request.path === '/mock-auth/oauth/authorize').map((request) => request.browserMode), expectedModes, 'rotation must use the configured mode for both normal logins');
  assert.deepEqual(selects.map((request) => request.browserMode), expectedModes);
  const invitation = app.requests.find((request) => request.method === 'POST' && request.path.endsWith('/invites'));
  const acceptance = app.requests.find((request) => request.path.endsWith('/invites/accept'));
  assert.equal(app.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/invites')).length, 1);
  assert.equal(app.requests.filter((request) => request.path.endsWith('/invites/accept')).length, 1);
  assert.equal(invitation?.identity, 'fixture-owner-user');
  assert.equal(invitation?.invitedEmail, childEmail);
  assert.equal(acceptance?.identity, 'fixture-member-user');
  assert.equal(acceptance?.tokenAccountId, personalId, 'invitation acceptance uses this member personal token');
  assert.ok(app.requests.indexOf(selects[0]) < app.requests.indexOf(invitation));
  assert.ok(app.requests.indexOf(selects[1]) > app.requests.indexOf(acceptance), 'Team authorization happens only after membership is confirmed');
  assert.equal(app.requests.filter((request) => request.passwordMatches).length, 2);
  assert.equal(app.requests.filter((request) => request.validTotpShape).length, 2);
  const memberProbes = app.requests.filter((request) => request.path === '/backend-api/wham/usage' && request.identity === 'fixture-member-user');
  assert.equal(memberProbes.length, 1);
  assert.equal(memberProbes[0].tokenAccountId, workspaceId);
  assert.equal(memberProbes[0].accountId, workspaceId);
  const row = memberQuota(await app.publicState());
  assert.equal(row.quota5h, 59);
  assert.equal(row.quota7d, 34);
  const saved = (await app.persistedState()).children[0];
  assert.equal(saved.accessToken, app.freeToken, 'the original personal credentials remain separate');
  assert.equal(saved.workspaceTokens[workspaceId].accessToken, app.teamToken);
  assert.equal(saved.workspaceTokens[workspaceId].refreshToken, 'fixture-team-rt');
  assert.equal(saved.workspaceHistory.find((membership) => membership.team === workspaceId).quota5h, 59);
  assert.equal(saved.workspaceHistory.find((membership) => membership.team === workspaceId).quota7d, 34);
  assert.equal(app.requests.some((request) => request.unexpected), false);
});

test('an official browser challenge stops refill before invitation and cannot create credentials or fake quota', { timeout: 25_000 }, async (t) => {
  const app = await fixture(t, { browserChallenge: true, roxyEnabled: true });
  const result = await app.refill();
  assert.equal(result.ok, false);
  assert.equal(result.acceptedSeats, 0);
  assert.deepEqual(result.joined, []);
  assert.equal(result.joinFailures[0]?.phase, 'free_auth');
  assert.equal(result.joinFailures[0]?.browserRequired, true);
  assert.equal(result.quotaCheck, null);
  assert.equal(app.requests.some((request) => request.path.includes('/invites')), false);
  assert.equal(app.requests.some((request) => request.grantType), false);
  assert.equal(app.requests.some((request) => request.path === '/backend-api/wham/usage' && request.identity === 'fixture-member-user'), false);
  const saved = (await app.persistedState()).children[0];
  assert.equal(Boolean(saved.accessToken), false);
  assert.equal(Boolean(saved.refreshToken), false);
  assert.deepEqual(saved.workspaceTokens, {});
  assert.equal(saved.workspaceHistory.some((membership) => membership.quota5h != null || membership.quota7d != null), false);
  assert.equal(saved.loginBrowserRequired, true);
  assert.equal(app.requests.some((request) => request.unexpected), false);
});

test('refill resumes an existing member completed Team callback without password login or a duplicate invitation and checks its own quota', { timeout: 25_000 }, async (t) => {
  const app = await fixture(t, { existingMemberCallback: true, roxyEnabled: true });
  const result = await app.refill();
  assert.equal(result.ok, true);
  assert.equal(result.acceptedSeats, 0);
  assert.deepEqual(result.joined, []);
  assert.deepEqual(result.joinFailures, []);
  assert.equal(result.quotaCheck?.checked, 1);
  assert.equal(result.quotaCheck?.results[0]?.id, childId);
  assert.equal(result.quotaCheck?.results[0]?.ok, true);
  assert.equal(app.requests.some((request) => request.path.includes('/invites')), false);
  assert.equal(app.requests.some((request) => request.path === '/mock-auth/oauth/authorize'), false);
  assert.equal(app.requests.some((request) => request.path.includes('/password/verify')), false);
  assert.equal(app.requests.some((request) => request.browserMode), false, 'an already completed callback must not launch the browser again');
  const exchanges = app.requests.filter((request) => request.grantType);
  assert.equal(exchanges.length, 1, 'the saved callback takes priority over the old Free RT');
  assert.equal(exchanges[0].grantType, 'authorization_code');
  assert.equal(exchanges[0].codeVerifier, 'fixture-completed-team-pkce');
  const probes = app.requests.filter((request) => request.path === '/backend-api/wham/usage' && request.identity === 'fixture-member-user');
  assert.equal(probes.length, 1);
  assert.equal(probes[0].tokenAccountId, workspaceId);
  assert.equal(probes[0].accountId, workspaceId);
  const row = memberQuota(await app.publicState());
  assert.equal(row.quota5h, 59);
  assert.equal(row.quota7d, 34);
  const saved = (await app.persistedState()).children[0];
  assert.equal(saved.accessToken, app.freeToken);
  assert.equal(saved.refreshToken, 'fixture-existing-free-rt');
  assert.equal(saved.workspaceTokens[workspaceId].accessToken, app.teamToken);
  assert.equal(saved.workspaceTokens[workspaceId].refreshToken, 'fixture-team-rt');
  assert.equal(saved.teamAuthSessions[workspaceId], undefined);
  assert.equal(app.requests.some((request) => request.unexpected), false);
});

test('a Team challenge after confirmed invitation resumes the original official callback on the next refill without reinviting or relogging', { timeout: 25_000 }, async (t) => {
  const app = await fixture(t, { teamBrowserChallenge: true, roxyEnabled: true });
  const first = await app.refill();
  assert.equal(first.ok, false);
  assert.equal(first.acceptedSeats, 1, 'the remote member is already admitted even though Team OAuth paused');
  assert.deepEqual(first.joined, []);
  assert.equal(first.joinFailures[0]?.phase, 'team_token');
  assert.equal(first.joinFailures[0]?.browserRequired, true);
  assert.equal(first.quotaCheck, null);
  const pending = (await app.persistedState()).children[0];
  const pendingMembership = pending.workspaceHistory.find((entry) => entry.team === workspaceId);
  assert.equal(pendingMembership.status, 'active');
  assert.equal(pendingMembership.joinStatus, 'member_confirmed_token_pending');
  assert.equal(pendingMembership.workspaceTokenStatus, 'pending');
  assert.equal(pendingMembership.quota5h ?? null, null);
  assert.equal(pendingMembership.quota7d ?? null, null);
  assert.equal(pending.workspaceTokens[workspaceId], undefined);
  const originalSession = pending.teamAuthSessions[workspaceId];
  assert.ok(originalSession.state);
  assert.ok(originalSession.codeVerifier);
  await app.completeTeamCallback(originalSession.state);
  const beforeResume = app.requests.length;
  const second = await app.refill();
  assert.equal(second.ok, true);
  assert.equal(second.acceptedSeats, 0, 'the resumed authorization cannot count another accepted seat');
  assert.deepEqual(second.joined, []);
  assert.deepEqual(second.joinFailures, []);
  assert.equal(second.quotaCheck?.checked, 1);
  assert.equal(second.quotaCheck?.results[0]?.id, childId);
  assert.equal(second.quotaCheck?.results[0]?.ok, true);
  assert.equal(app.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/invites')).length, 1);
  assert.equal(app.requests.filter((request) => request.path.endsWith('/invites/accept')).length, 1);
  const resumedRequests = app.requests.slice(beforeResume);
  assert.equal(resumedRequests.some((request) => request.path === '/mock-auth/oauth/authorize'), false);
  assert.equal(resumedRequests.some((request) => request.path.includes('/password/verify')), false);
  const exchanges = resumedRequests.filter((request) => request.grantType);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].grantType, 'authorization_code');
  assert.equal(exchanges[0].codeVerifier, originalSession.codeVerifier, 'the original Team PKCE session must survive the challenge');
  const probes = resumedRequests.filter((request) => request.path === '/backend-api/wham/usage' && request.identity === 'fixture-member-user');
  assert.equal(probes.length, 1);
  assert.equal(probes[0].tokenAccountId, workspaceId);
  assert.equal(probes[0].accountId, workspaceId);
  const row = memberQuota(await app.publicState());
  assert.equal(row.quota5h, 59);
  assert.equal(row.quota7d, 34);
  const saved = (await app.persistedState()).children[0];
  const readyMembership = saved.workspaceHistory.find((entry) => entry.team === workspaceId);
  assert.equal(readyMembership.workspaceTokenStatus, 'ready');
  assert.equal(readyMembership.joinStatus, 'member_confirmed');
  assert.equal(readyMembership.teamAuthRetryAfter, null, 'an arrived callback may complete during the old login backoff');
  assert.equal(saved.workspaceTokens[workspaceId].accessToken, app.teamToken);
  assert.equal(saved.workspaceTokens[workspaceId].refreshToken, 'fixture-team-rt');
  assert.equal(saved.teamAuthSessions[workspaceId], undefined);
  assert.equal(app.requests.some((request) => request.unexpected), false);
});
