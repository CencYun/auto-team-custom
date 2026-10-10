import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createStateStorage } from './security.mjs';

const serverScript = fileURLToPath(new URL('./index.mjs', import.meta.url));
const email = 'member@example.test';
const scope = { motherId: 'mother-b', workspaceId: 'team-b', reason: 'manual', retryAfter: null };
const endpoint = '/api/children/member/kick';
function token(workspaceId, tokenEmail = email, userId = 'user-member', plan = 'team') {
  return `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: userId,
    'https://api.openai.com/auth': { chatgpt_account_id: workspaceId, chatgpt_plan_type: plan, chatgpt_user_id: userId },
    'https://api.openai.com/profile': { email: tokenEmail },
  })).toString('base64url')}.private-signature`;
}
function member(team = 'team-a', fields = {}) {
  return { team, status: 'active', role: 'standard-user', memberId: `member-${team}`, quota5h: 81, quota7d: 65, ...fields };
}
function child(fields = {}) {
  return { id: 'member', email, password: 'private-password', totp: 'PRIVATESECRET',
    accessToken: token('personal', email, 'user-member', 'free'), refreshToken: 'private-rt',
    chatgptUserId: 'user-member', team: 'team-a', status: 'active', memberId: 'unrelated-team-b-member',
    workspaceHistory: [member('team-a'), member('team-b', { manualKickEnabled: true,
      manualKickStartedAt: new Date().toISOString(), manualKickAt: new Date(Date.now() + 3600000).toISOString(), manualKickDurationMinutes: 60,
      quotaKickPendingUntil: new Date(Date.now() + 300000).toISOString(), quotaKickWindow: '5h' })],
    workspaceTokens: { 'team-a': { accessToken: token('team-a'), refreshToken: 'private-team-a-rt' }, 'team-b': { accessToken: token('team-b'), refreshToken: 'private-team-b-rt' } },
    ...fields };
}
function mother(workspaceId = 'team-a', fields = {}) {
  return { id: `mother-${workspaceId.slice(-1)}`, team: workspaceId, accountId: workspaceId,
    email: 'owner@example.test', chatgptUserId: 'user-owner', accessToken: token(workspaceId, 'owner@example.test', 'user-owner'),
    rotationMode: 'fixed', primaryOwnerEmail: 'owner@example.test', rotationEnabled: false, used: 9, ...fields };
}
const defaultMembers = (workspaceId) => [
  { id: 'user-owner', email: 'owner@example.test', role: 'account-owner' },
  { id: `member-${workspaceId}`, email, role: 'standard-user' },
  { id: 'unrelated-team-b-member', email: 'unrelated@example.test', role: 'standard-user' },
];
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }

async function fixture(t, { children = [child()], mothers = [mother(), mother('team-b')], onRequest } = {}) {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const entry = { path: url.pathname, method: req.method, workspaceId: req.headers['chatgpt-account-id'] };
    requests.push(entry);
    let reply = await onRequest?.(entry);
    if (!reply && /\/users$/.test(entry.path)) {
      const items = defaultMembers(entry.workspaceId);
      reply = { status: 200, payload: { items, total: items.length, offset: Number(url.searchParams.get('offset')) || 0 } };
    }
    if (!reply && req.method === 'DELETE') reply = { status: 200, payload: { success: true } };
    if (!reply) reply = { status: 503, payload: { error: 'unexpected-local-fixture-request' } };
    res.writeHead(reply.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.payload || {}));
  });
  const upstreamPort = await listen(upstream);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'scoped-member-kick-'));
  const stateFile = path.join(dataDir, 'state.json');
  await writeFile(stateFile, JSON.stringify({ version: 1, settings: { autoRefill: false, promoteJoinedAccounts: false }, mothers, children, history: [] }));
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const preload = `const nativeFetch = globalThis.fetch; globalThis.fetch = (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === 'auth.openai.com') return nativeFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/token`)}, options);
    if (url.hostname !== '127.0.0.1') throw new Error('external_network_disabled');
    return nativeFetch(input, options);
  };`;
  const app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      TEAM_ROTATION_DATA_DIR: dataDir, TEAM_ROTATION_DATA_KEY: '', TEAM_ROTATION_API_TOKEN: '', TEAM_ROTATION_LOGIN_PASSWORD: 'fixture-password',
      DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: 'false', OPENAI_REQUEST_TIMEOUT_MS: '3000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk; });
  app.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (app.exitCode === null && app.signalCode === null) { const done = new Promise((resolve) => app.once('exit', resolve)); app.kill(); await done; }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (app.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${base}/api/auth/session`)).ok) break; } catch { /* Wait for isolated process. */ }
    await delay(25);
  }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'fixture-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const storage = await createStateStorage(dataDir);
  return { requests,
    async request(route = endpoint, { method = 'POST', body = scope, authenticated = true } = {}) {
      const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      return { status: response.status, data: await response.json() };
    },
    async saved() { return storage.decode(await readFile(stateFile, 'utf8')); },
  };
}

test('scoped removal targets noncurrent Team by verified email and preserves account and other Team data', async (t) => {
  const app = await fixture(t);
  const before = await app.saved();
  const result = await app.request();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.workspaceId, 'team-b');
  assert.deepEqual(app.requests.map(({ path, method }) => ({ path, method })), [
    { path: '/backend-api/accounts/team-b/users', method: 'GET' },
    { path: '/backend-api/accounts/team-b/users/member-team-b', method: 'DELETE' },
  ]);
  const after = await app.saved();
  assert.equal(after.children.length, 1);
  const account = after.children[0];
  for (const key of ['email', 'password', 'totp', 'accessToken', 'refreshToken', 'workspaceTokens', 'team', 'status', 'memberId']) assert.deepEqual(account[key], before.children[0][key], key);
  assert.deepEqual(account.workspaceHistory[0], before.children[0].workspaceHistory[0]);
  assert.equal(account.workspaceHistory[1].status, 'kicked');
  assert.equal(account.workspaceHistory[1].manualKickEnabled, false);
  assert.equal(account.workspaceHistory[1].quotaKickPendingUntil, null);
  assert.deepEqual(after.mothers[0], before.mothers[0]);
  assert.equal(after.mothers[1].used, 2);
  assert.equal(after.mothers[1].members.some((item) => item.email === email), false);
  assert.doesNotMatch(JSON.stringify(result.data), /private-password|PRIVATESECRET|private-team.*-rt|private-rt/);
});

test('legacy unscoped removal still selects current Team and retains a different active Team', async (t) => {
  const app = await fixture(t);
  const result = await app.request(endpoint, { body: { reason: 'manual', retryAfter: null } });
  assert.equal(result.status, 200);
  const child = (await app.saved()).children[0];
  assert.equal(child.team, 'team-b');
  assert.equal(child.status, 'active');
  assert.equal(child.workspaceHistory[0].status, 'kicked');
  assert.equal(child.workspaceHistory[1].status, 'active');
});

test('invalid explicit scope, absent member and pending seat reservations reject before remote removal', async (t) => {
  const app = await fixture(t);
  for (const body of [null, [], { motherId: 'mother-b' }, { workspaceId: 'team-b' }, { motherId: [], workspaceId: 'team-b' }]) {
    assert.equal((await app.request(endpoint, { body })).status, 400);
  }
  assert.equal((await app.request(endpoint, { body: { ...scope, workspaceId: 'team-a' } })).data.code, 'team_workspace_mismatch');
  assert.equal((await app.request(endpoint, { body: { ...scope, motherId: 'missing' } })).status, 404);
  assert.equal((await app.request(endpoint, { authenticated: false })).status, 401);
  assert.equal(app.requests.length, 0);
  await t.test('only invited or previously removed', async (t) => {
    const app = await fixture(t, { children: [child({ workspaceHistory: [member('team-a'), member('team-b', { status: 'kicked' })], teamInvitations: [{ ...scope, status: 'invited' }] })] });
    assert.equal((await app.request()).status, 409);
    assert.equal(app.requests.length, 0);
  });
  await t.test('seat approval pending', async (t) => {
    const app = await fixture(t, { mothers: [mother(), mother('team-b', { seatClaims: [{ id: 'claim-b', workspaceId: 'team-b', childId: 'member', email, phase: 'approval_pending' }] })] });
    assert.equal((await app.request()).data.code, 'child_has_pending_seat_claim');
    assert.equal(app.requests.length, 0);
  });
});

test('global stale member ID never selects another email, and malformed member pages fail closed', async (t) => {
  for (const [name, payload] of [
    ['wrong-email', { items: [{ id: 'user-owner', email: 'owner@example.test', role: 'account-owner' }, { id: 'unrelated-team-b-member', email: 'not-this-child@example.test' }], total: 2 }],
    ['malformed', { success: false, error: 'private-upstream-detail', items: [], total: 0 }],
  ]) await t.test(name, async (t) => {
    const app = await fixture(t, { onRequest: () => ({ payload }) });
    assert.notEqual((await app.request()).status, 200);
    assert.equal(app.requests.some((item) => item.method === 'DELETE'), false);
    assert.equal((await app.saved()).children[0].workspaceHistory[1].status, 'active');
  });
});

test('fixed primary owner is protected, other owners and banned members remain removable, last member is protected', async (t) => {
  for (const [name, fields, config, members, expected] of [
    ['fixed-primary', { email: 'owner@example.test' }, {}, defaultMembers('team-b'), 403],
    ['secondary-owner', {}, {}, defaultMembers('team-b').map((row) => ({ ...row, role: 'account-owner' })), 200],
    ['rotating-primary', { email: 'owner@example.test' }, { rotationMode: 'rotating' }, defaultMembers('team-b'), 200],
    ['banned-member', { status: 'banned', banStatus: 'banned' }, {}, defaultMembers('team-b'), 200],
    ['last-member', {}, {}, [{ id: 'member-team-b', email, role: 'account-owner' }], 409],
  ]) await t.test(name, async (t) => {
    const app = await fixture(t, { children: [child(fields)], mothers: [mother(), mother('team-b', config)],
      onRequest: (entry) => entry.method === 'GET' ? { payload: { items: members, total: members.length } } : null });
    assert.equal((await app.request()).status, expected);
    assert.equal(app.requests.some((item) => item.method === 'DELETE'), expected === 200);
    if (name === 'banned-member') assert.equal((await app.saved()).children[0].status, 'banned');
  });
});

test('upstream 401 and 403 are operation errors without dashboard logout or leaked remote details', async (t) => {
  for (const status of [401, 403]) for (const during of ['list', 'delete']) await t.test(`${during}-${status}`, async (t) => {
    const app = await fixture(t, { onRequest: (entry) => (during === 'list' ? entry.method === 'GET' : entry.method === 'DELETE')
      ? { status, payload: { error: 'private-upstream-token' } } : null });
    const result = await app.request();
    assert.equal(result.status, 502);
    assert.equal(result.data.upstreamStatus, status);
    assert.doesNotMatch(JSON.stringify(result.data), /private-upstream-token/);
    assert.equal((await app.request('/api/state', { method: 'GET' })).status, 200);
    assert.equal((await app.saved()).children[0].workspaceHistory[1].status, 'active');
  });
});

test('scoped removal refuses an account with a live token refresh', async (t) => {
  const entered = deferred(); const release = deferred();
  const app = await fixture(t, { onRequest: async (entry) => {
    if (entry.path !== '/token') return null;
    entered.resolve(); await release.promise;
    return { payload: { access_token: token('personal', email, 'user-member', 'free'), refresh_token: 'private-new-rt' } };
  } });
  const refresh = app.request('/api/children/member/acquire', { body: { mode: 'refresh-at' } });
  await entered.promise;
  const result = await app.request();
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'account_operation_in_progress');
  release.resolve();
  await refresh;
  assert.equal(app.requests.some((entry) => entry.path.includes('/users')), false);
});

test('identity changed during remote member lookup cancels deletion', async (t) => {
  const entered = deferred(); const release = deferred();
  const app = await fixture(t, { onRequest: async (entry) => {
    if (entry.method !== 'GET') return null;
    entered.resolve(); await release.promise; return null;
  } });
  const pending = app.request();
  await entered.promise;
  assert.equal((await app.request('/api/children/member', { method: 'PATCH', body: { email: 'changed@example.test' } })).status, 200);
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'child_identity_changed_during_kick');
  assert.equal(app.requests.some((entry) => entry.method === 'DELETE'), false);
  assert.equal((await app.saved()).children[0].workspaceHistory[1].status, 'active');
});

test('scope is captured before waiting for the Team lock and checked again after workspace reconfiguration', async (t) => {
  const entered = deferred(); const release = deferred();
  const record = child();
  record.workspaceHistory[1].manualKickEnabled = false;
  const app = await fixture(t, { children: [record], onRequest: async (entry) => {
    if (entry.path !== '/backend-api/subscriptions') return null;
    entered.resolve(); await release.promise;
    return { payload: { plan_type: 'team', seats_in_use: 3, seats_entitled: 5 } };
  } });
  const holding = app.request('/api/mothers/mother-b/subscription', { method: 'GET' });
  await entered.promise;
  const changed = app.request('/api/mothers/mother-b', { method: 'PATCH', body: { accountId: 'team-c', team: 'team-c' } });
  // A read barrier lets the queued mutation enter the existing Team lock.
  await app.request('/api/state', { method: 'GET' });
  const pending = app.request();
  await app.request('/api/state', { method: 'GET' });
  release.resolve();
  assert.equal((await holding).status, 200);
  assert.equal((await changed).status, 200);
  assert.equal((await pending).data.code, 'child_workspace_changed_during_kick');
  assert.equal(app.requests.some((entry) => entry.method === 'DELETE'), false);
});
