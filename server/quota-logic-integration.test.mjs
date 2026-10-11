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

function token(accountId, identity = accountId, expiresIn = 3600, { email, userId, plan = 'team' } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    ...(expiresIn == null ? {} : { exp: Math.floor(Date.now() / 1000) + expiresIn }),
    sub: identity,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan, ...(userId ? { chatgpt_user_id: userId } : {}) },
    ...(email ? { 'https://api.openai.com/profile': { email } } : {}),
  })).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

function requestIdentity(req) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try {
    return JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub || '';
  } catch {
    return '';
  }
}

function usageKey(workspace, identity) {
  return `${workspace}:${identity}`;
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

async function waitForApp(baseUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`test server exited early: ${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Wait for the isolated server to bind its local port.
    }
    await delay(50);
  }
  throw new Error(`test server did not start: ${output()}`);
}

async function startQuotaApp(t, {
  teams,
  children,
  usage,
  initialState = {},
  refreshResponses = null,
  sessionResponses = {},
  workspaceResponses = {},
  roxyEnabled = false,
}) {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const accountId = req.headers['chatgpt-account-id'] || '';
    const identity = requestIdentity(req);
    const request = { method: req.method, pathname: url.pathname, accountId, identity };
    requests.push(request);
    let status = 200;
    let payload = {};
    const sourceTeam = Array.isArray(teams)
      ? teams.find((item) => item.accountId === accountId || item.team === accountId)
      : teams[accountId];
    const members = sourceTeam?.members || [];
    if (req.method === 'POST' && url.pathname === '/mock-oauth/token') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      request.grantType = form.get('grant_type');
      request.refreshToken = form.get('refresh_token');
      request.authorizationCode = form.get('code');
      const mock = refreshResponses?.[request.refreshToken || request.authorizationCode];
      status = mock?.status || 400;
      payload = mock?.payload || { error: 'test_oauth_response_not_configured' };
    } else if (url.pathname === '/mock-blocked-external') {
      status = 200;
    } else if (workspaceResponses[accountId] && ['/backend-api/subscriptions', `/backend-api/accounts/${accountId}/users`].includes(url.pathname)) {
      status = workspaceResponses[accountId].status;
      payload = workspaceResponses[accountId].payload;
    } else if (req.method === 'GET' && url.pathname === '/backend-api/subscriptions') {
      payload = { seats_in_use: members.length, seats_entitled: 2, seat_capacity: [{ type: 'default', paid: 2, held: 0 }], assigned: { default: members.length } };
    } else if (req.method === 'GET' && url.pathname === `/backend-api/accounts/${accountId}/users`) {
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Number(url.searchParams.get('limit')) || 100;
      payload = { items: members.slice(offset, offset + limit), total: members.length, offset, limit };
    } else if (req.method === 'GET' && url.pathname === '/backend-api/wham/usage') {
      const current = usage[usageKey(accountId, identity)] || usage[accountId] || usage.default;
      status = current?.status || 200;
      payload = current?.payload || {};
    } else if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      const current = sessionResponses[identity];
      status = current?.status || 503;
      payload = current?.payload || { error: 'test_workspace_session_not_configured' };
    } else if (req.method === 'POST' && url.pathname === '/backend-api/codex/responses') {
      payload = { status: 'active' };
    } else {
      status = 503;
      payload = { message: `unexpected_mock_request:${req.method}:${url.pathname}` };
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const upstreamPort = await listen(upstream);
  const dataRoot = path.resolve(tmpdir());
  const dataDir = await mkdtemp(path.join(dataRoot, 'quota-logic-integration-'));
  const state = {
    version: 1,
    ...initialState,
    settings: {
      autoRefill: false,
      promoteJoinedAccounts: false,
      delayedKickEnabled: false,
      ...initialState.settings,
      ...(roxyEnabled ? { integrations: { ...initialState.settings?.integrations, roxy: {
        enabled: true,
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'fixture-roxy-api-key',
        workspaceId: 'fixture-roxy-workspace',
        profileMode: 'dedicated',
        useProxyPool: false,
      } } } : {}),
    },
    mothers: teams,
    children,
    history: [],
  };
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify(state));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const spawnArgs = [];
  if (refreshResponses || roxyEnabled) {
    const preload = `
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (input, options) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        if (url.hostname === 'auth.openai.com' && ['/api/oauth/oauth2/token', '/oauth/token'].includes(url.pathname)) {
          return nativeFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/mock-oauth/token`)}, options);
        }
        if (url.hostname !== '127.0.0.1') {
          await nativeFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/mock-blocked-external`)}, { method: 'POST' });
          throw new Error('isolated_test_external_network_disabled');
        }
        return nativeFetch(input, options);
      };
    `;
    spawnArgs.push('--import', `data:text/javascript,${encodeURIComponent(preload)}`);
  }
  spawnArgs.push(serverScript);
  const app = spawn(process.execPath, spawnArgs, {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      TEAM_ROTATION_DATA_DIR: dataDir,
      TEAM_ROTATION_DATA_KEY: 'quota-logic-test-only-key',
      TEAM_ROTATION_API_TOKEN: '',
      TEAM_ROTATION_LOGIN_PASSWORD: 'daixuteam',
      DISABLE_MAINTENANCE: 'true',
      OPENAI_CALLBACK_ENABLED: 'false',
      OPENAI_REQUEST_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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
  await waitForApp(baseUrl, app, () => output);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'daixuteam' }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(login.status, 200, await login.text());
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(cookie || '', /^team_rotation_session=/);
  async function rawPost(endpoint, body) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json();
    return { status: response.status, ok: response.ok, data };
  }
  async function post(endpoint, body) {
    const result = await rawPost(endpoint, body);
    assert.ok(result.ok, JSON.stringify(result.data));
    return result.data;
  }
  async function check(motherId, childIds) {
    return post('/api/maintenance/check', { motherId, ...(childIds === undefined ? {} : { childIds }) });
  }
  async function publicState() {
    const response = await fetch(`${baseUrl}/api/state`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function persistedState() {
    const saved = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
    if (!saved.encrypted) return saved;
    const key = createHash('sha256').update('quota-logic-test-only-key').digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(saved.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'base64')), decipher.final()]).toString());
  }
  return { check, post, rawPost, publicState, persistedState, requests, usage, refreshResponses };
}

function team(id, ownerEmail, members) {
  return {
    id: `mother-${id}`,
    team: id,
    accountId: id,
    teamName: id,
    email: ownerEmail,
    primaryOwnerEmail: ownerEmail,
    accessToken: token(id, `owner:${ownerEmail}`),
    ownerAccounts: [],
    members,
  };
}

function member(id, email, role = 'standard-user') {
  return { id, accountUserId: `${id}__member`, email, role, seat_type: 'default', createdTime: '2026-10-01T00:00:00.000Z' };
}

function child(id, email, memberships) {
  const workspaceTokens = Object.fromEntries(memberships.map((entry) => [entry.team, { accessToken: token(entry.team, `child:${id}`) }]));
  return {
    id,
    email,
    status: 'active',
    team: memberships[0]?.team || null,
    accessToken: token(`free-${id}`, `child:${id}`),
    workspaceTokens,
    workspaceHistory: memberships.map((entry) => ({ status: 'active', ...entry, quota5h: entry.quota5h ?? null, quota7d: entry.quota7d ?? null, quotaSnapshot: entry.quotaSnapshot || null })),
  };
}

function currentAccount(state, workspace, email) {
  const account = state.teams.find((item) => item.id === `mother-${workspace}`)?.currentAccounts
    .find((item) => item.email === email);
  assert.ok(account, `current Team account not found: ${workspace}/${email}`);
  return account;
}

function snapshot(used5h, used7d, extra = {}) {
  return {
    primary: { usedPercent: used5h, windowMinutes: 300 },
    secondary: { usedPercent: used7d, windowMinutes: 10080 },
    quotaWindowMapping: 'duration-v1',
    source: 'wham/usage',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

test('quota windows are mapped by duration and preserve legal 0/100 values', { timeout: 25_000 }, async (t) => {
  const workspace = 'quota-window-workspace';
  const ownerEmail = 'owner@quota-window.test';
  const childEmail = 'member@quota-window.test';
  const app = await startQuotaApp(t, {
    usage: {
      [workspace]: {
        payload: { rate_limit: {
          // Deliberately swap the upstream order: primary is the 7d window.
          primary_window: { used_percent: 100, limit_window_seconds: 604800 },
          secondary_window: { used_percent: 0, limit_window_seconds: 18000 },
        } },
      },
    },
    teams: [team(workspace, ownerEmail, [member('owner-member', ownerEmail, 'account-owner'), member('child-member', childEmail)])],
    children: [child('child-window', childEmail, [{ team: workspace, memberId: 'child-member' }])],
  });
  await app.check('mother-' + workspace);
  const state = await app.publicState();
  const current = state.teams[0].currentAccounts.find((account) => account.email === childEmail);
  assert.ok(current);
  assert.equal(current.quota5h, 100, 'the 18,000-second window is the 5h column');
  assert.equal(current.quota7d, 0, 'the 604,800-second window is the 7d column');
});

test('quota failures retain Team history, while successful missing windows clear stale values and remain isolated', { timeout: 30_000 }, async (t) => {
  const teamA = 'quota-isolation-a';
  const teamB = 'quota-isolation-b';
  const sharedEmail = 'shared@quota-isolation.test';
  const ownerA = 'owner-a@quota-isolation.test';
  const ownerB = 'owner-b@quota-isolation.test';
  const teams = [
    team(teamA, ownerA, [member('owner-a', ownerA, 'account-owner'), member('shared-a', sharedEmail)]),
    team(teamB, ownerB, [member('owner-b', ownerB, 'account-owner'), member('shared-b', sharedEmail)]),
  ];
  const shared = child('shared-quota-child', sharedEmail, [
    { team: teamA, memberId: 'shared-a', quota5h: 55, quota7d: 66, quotaSnapshot: { primary: { usedPercent: 45 }, secondary: { usedPercent: 34 } } },
    { team: teamB, memberId: 'shared-b', quota5h: 11, quota7d: 22, quotaSnapshot: { primary: { usedPercent: 89 }, secondary: { usedPercent: 78 } } },
  ]);
  const app = await startQuotaApp(t, {
    usage: {
      [teamA]: { payload: { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } } } },
      [teamB]: { payload: { rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 18000 }, secondary_window: { used_percent: 10, limit_window_seconds: 604800 } } } },
    },
    teams,
    children: [shared],
  });
  await app.check('mother-' + teamA);
  await app.check('mother-' + teamB);
  let state = await app.publicState();
  let rowA = state.teams.find((item) => item.id === 'mother-' + teamA).currentAccounts.find((account) => account.email === sharedEmail);
  let rowB = state.teams.find((item) => item.id === 'mother-' + teamB).currentAccounts.find((account) => account.email === sharedEmail);
  const ownerRowA = state.teams.find((item) => item.id === 'mother-' + teamA).currentAccounts.find((account) => account.email === ownerA);
  const ownerRowB = state.teams.find((item) => item.id === 'mother-' + teamB).currentAccounts.find((account) => account.email === ownerB);
  assert.equal(rowA.quota5h, 80);
  assert.equal(rowA.quota7d, null, 'successful response missing 7d clears only Team A 7d');
  assert.equal(rowB.quota5h, 40);
  assert.equal(rowB.quota7d, 90);
  assert.equal(ownerRowA?.quota5h, 80, 'Team A owner quota comes from Team A probe');
  assert.equal(ownerRowA?.quota7d, null);
  assert.equal(ownerRowB?.quota5h, 40, 'Team B owner quota stays isolated');
  assert.equal(ownerRowB?.quota7d, 90);

  // A failed response must keep both previously measured Team B windows.
  app.usage[teamB].status = 503;
  app.usage[teamB].payload = { error: 'temporary_failure' };
  await app.check('mother-' + teamB);
  state = await app.publicState();
  rowB = state.teams.find((item) => item.id === 'mother-' + teamB).currentAccounts.find((account) => account.email === sharedEmail);
  assert.equal(rowB.quota5h, 40, 'failed Team B probe keeps its 5h history');
  assert.equal(rowB.quota7d, 90, 'failed Team B probe keeps its 7d history');
});

test('a primary weekly window clears stale 5h values, reset data, and exported metadata', { timeout: 25_000 }, async (t) => {
  const workspace = 'weekly-only-workspace';
  const ownerEmail = 'owner@weekly-only.test';
  const childEmail = 'member@weekly-only.test';
  const stale = {
    quota5h: 9,
    quota7d: 33,
    quota5hResetAfterSeconds: 500,
    quota5hResetAt: '2026-10-01T01:00:00.000Z',
    quotaSnapshot: snapshot(91, 67),
    extra: { codex_5h_used_percent: 91, codex_5h_reset_after_seconds: 500, codex_5h_reset_at: '2026-10-01T01:00:00.000Z', codex_5h_window_minutes: 300, codex_primary_used_percent: 91, unrelated: 'preserved' },
  };
  const mother = { ...team(workspace, ownerEmail, [member('weekly-owner', ownerEmail, 'account-owner'), member('weekly-child', childEmail)]), ...stale };
  const account = { ...child('weekly-child-local', childEmail, [{ team: workspace, memberId: 'weekly-child', ...stale }]), ...stale };
  const app = await startQuotaApp(t, {
    teams: [mother],
    children: [account],
    usage: { [workspace]: { payload: { rate_limit: { primary_window: { used_percent: 22, limit_window_seconds: 604800, reset_after_seconds: 4000 } } } } },
  });
  await app.check(mother.id);
  let state = await app.publicState();
  for (const email of [ownerEmail, childEmail]) {
    const row = currentAccount(state, workspace, email);
    assert.equal(row.quota5h, null, `${email} has no measured 5h window`);
    assert.equal(row.quota7d, 78, `${email} weekly window is displayed in 7d`);
    assert.equal(row.quota5hResetAfterSeconds, null, `${email} stale 5h reset seconds are cleared`);
    assert.equal(row.quota5hResetAt, null, `${email} stale 5h reset timestamp is cleared`);
    assert.equal(row.quotaSnapshot.primary.usedPercent, null);
    assert.equal(row.quotaSnapshot.secondary.windowMinutes, 10080);
  }
  const exported = await app.post('/api/sub2api/team-export', { motherIds: [mother.id] });
  assert.equal(exported.accounts.length, 2);
  for (const entry of exported.accounts) {
    assert.equal(entry.extra.codex_7d_used_percent, 22);
    assert.equal(entry.extra.unrelated, 'preserved');
    assert.deepEqual(Object.keys(entry.extra).filter((key) => /^codex_(5h|primary)_/.test(key)), [], 'absent 5h window cannot leak from old export metadata');
  }

  // An unknown-duration primary must not be guessed as 5h when the other
  // window is explicitly weekly. Positional compatibility is for legacy
  // responses that have no duration information for either window.
  app.usage[workspace].payload = { rate_limit: {
    primary_window: { used_percent: 17 },
    secondary_window: { used_percent: 22, limit_window_seconds: 604800 },
  } };
  await app.check(mother.id);
  state = await app.publicState();
  assert.equal(currentAccount(state, workspace, childEmail).quota5h, null);
  assert.equal(currentAccount(state, workspace, childEmail).quota7d, 78);

  app.usage[workspace].payload = { rate_limit: { primary_window: { used_percent: 17 }, secondary_window: { used_percent: 22 } } };
  await app.check(mother.id);
  state = await app.publicState();
  assert.equal(currentAccount(state, workspace, childEmail).quota5h, 83, 'legacy windows without duration retain positional compatibility');
  assert.equal(currentAccount(state, workspace, childEmail).quota7d, 78);
});

test('null, empty, whitespace, and invalid usage values remain unknown rather than becoming zero usage', { timeout: 25_000 }, async (t) => {
  const workspace = 'unknown-usage-workspace';
  const ownerEmail = 'owner@unknown-usage.test';
  const cases = [
    ['null', null],
    ['empty', ''],
    ['whitespace', '  '],
    ['invalid-string', 'not-a-number'],
    ['boolean', false],
    ['array', []],
    ['object', {}],
  ];
  const children = cases.map(([name]) => child(`invalid-${name}`, `${name}@unknown-usage.test`, [{ team: workspace, memberId: `member-${name}`, quota5h: 42, quota7d: 24, quotaSnapshot: snapshot(58, 76) }]));
  const usage = {
    [workspace]: { payload: { rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 18000 }, secondary_window: { used_percent: 50, limit_window_seconds: 604800 } } } },
  };
  cases.forEach(([name, value]) => {
    usage[usageKey(workspace, `child:invalid-${name}`)] = { payload: { rate_limit: {
      primary_window: { used_percent: value, limit_window_seconds: 18000 },
      secondary_window: { used_percent: value, limit_window_seconds: 604800 },
    } } };
  });
  const app = await startQuotaApp(t, {
    teams: [team(workspace, ownerEmail, [member('unknown-owner', ownerEmail, 'account-owner'), ...children.map((item, index) => member(`member-${cases[index][0]}`, item.email))])],
    children,
    usage,
  });
  await app.check(`mother-${workspace}`);
  const state = await app.publicState();
  for (const [name] of cases) {
    const row = currentAccount(state, workspace, `${name}@unknown-usage.test`);
    assert.equal(row.quota5h, null, `${name} must not become a 100% remaining 5h quota`);
    assert.equal(row.quota7d, null, `${name} must not become a 100% remaining 7d quota`);
    assert.equal(row.quotaSnapshot.primary.usedPercent, null);
    assert.equal(row.quotaSnapshot.secondary.usedPercent, null);
  }
});

test('identity-only local owner membership may display that same owner current-Team measurement', { timeout: 25_000 }, async (t) => {
  const workspace = 'owner-identity-workspace';
  const ownerEmail = 'owner@owner-identity.test';
  const mother = {
    ...team(workspace, ownerEmail, [member('identity-owner', ownerEmail, 'account-owner')]),
    quota5h: 83,
    quota7d: 65,
    quotaSnapshot: snapshot(17, 35),
    quota5hResetAfterSeconds: 1234,
    quota5hResetAt: '2026-10-08T02:00:00.000Z',
    lastProbe: { ok: true, status: 200, ...snapshot(17, 35) },
  };
  mother.ownerAccounts = [{ email: ownerEmail, accessToken: token(workspace, `owner:${ownerEmail}`) }];
  const app = await startQuotaApp(t, {
    teams: [mother],
    children: [child('identity-owner-local', ownerEmail, [{ team: workspace, memberId: 'identity-owner' }])],
    usage: {},
  });
  const row = currentAccount(await app.publicState(), workspace, ownerEmail);
  assert.equal(row.id, 'identity-owner-local', 'local identity remains available for member actions');
  assert.equal(row.quota5h, 83);
  assert.equal(row.quota7d, 65);
  assert.equal(row.quotaSnapshot.primary.usedPercent, 17);
  assert.equal(row.quota5hResetAfterSeconds, 1234);
  assert.equal(row.lastProbe.ok, true);
});

test('an empty legacy owner snapshot falls back to the same owner, while a complete empty snapshot stays authoritative', { timeout: 25_000 }, async (t) => {
  const legacyTeam = 'owner-empty-legacy-workspace';
  const completeTeam = 'owner-empty-complete-workspace';
  const ownerEmail = 'owner@empty-snapshot.test';
  const measured = {
    quota5h: 83,
    quota7d: 65,
    quotaSnapshot: snapshot(17, 35),
    quota5hResetAfterSeconds: 1234,
    quota5hResetAt: '2026-10-08T02:00:00.000Z',
    quotaUpdatedAt: '2026-10-08T01:00:00.000Z',
    lastProbe: { ok: true, status: 200, ...snapshot(17, 35) },
  };
  const app = await startQuotaApp(t, {
    teams: [
      { ...team(legacyTeam, ownerEmail, [member('empty-legacy-owner', ownerEmail, 'account-owner')]), ...measured },
      { ...team(completeTeam, ownerEmail, [member('empty-complete-owner', ownerEmail, 'account-owner')]), ...measured },
    ],
    children: [child('empty-snapshot-owner-local', ownerEmail, [
      { team: legacyTeam, memberId: 'empty-legacy-owner', quotaSnapshot: { primary: { usedPercent: null }, secondary: { usedPercent: null } } },
      { team: completeTeam, memberId: 'empty-complete-owner', quotaSnapshot: snapshot(null, null) },
    ])],
    usage: {},
  });
  const state = await app.publicState();
  const legacyRow = currentAccount(state, legacyTeam, ownerEmail);
  const completeRow = currentAccount(state, completeTeam, ownerEmail);
  assert.equal(legacyRow.quota5h, 83, 'an empty legacy snapshot is not a measurement that can hide the same owner quota');
  assert.equal(legacyRow.quota7d, 65);
  assert.equal(legacyRow.quotaSnapshot.primary.usedPercent, 17);
  assert.equal(legacyRow.quota5hResetAfterSeconds, 1234);
  assert.equal(completeRow.quota5h, null, 'a successful duration-v1 snapshot explicitly missing every window remains authoritative');
  assert.equal(completeRow.quota7d, null);
  assert.equal(completeRow.quotaSnapshot.primary.usedPercent, null);
  assert.equal(completeRow.quota5hResetAfterSeconds, null);

  const legacyExport = await app.post('/api/sub2api/team-export', { motherIds: [`mother-${legacyTeam}`] });
  const completeExport = await app.post('/api/sub2api/team-export', { motherIds: [`mother-${completeTeam}`] });
  assert.equal(legacyExport.accounts.length, 1);
  assert.equal(completeExport.accounts.length, 1);
  assert.equal(legacyExport.accounts[0].extra.codex_5h_used_percent, 17, 'Team JSON uses the same measured fallback as currentAccounts');
  assert.equal(legacyExport.accounts[0].extra.codex_7d_used_percent, 35);
  assert.equal(legacyExport.accounts[0].extra.codex_5h_reset_after_seconds, 1234);
  assert.deepEqual(Object.keys(completeExport.accounts[0].extra).filter((key) => /^codex_(5h|7d|primary|secondary)_/.test(key)), [], 'authoritative empty windows cannot be restored by exporting owner metadata');
});

test('a real child quota of zero and its reset/probe fields take precedence over owner cache', { timeout: 25_000 }, async (t) => {
  const workspace = 'owner-zero-workspace';
  const ownerEmail = 'owner@owner-zero.test';
  const mother = {
    ...team(workspace, ownerEmail, [member('zero-owner', ownerEmail, 'account-owner')]),
    quota5h: 88,
    quota7d: 77,
    quotaSnapshot: snapshot(12, 23),
    quota5hResetAfterSeconds: 1000,
    lastProbe: { ok: true, status: 200, ...snapshot(12, 23) },
  };
  const localOwner = child('zero-owner-local', ownerEmail, [{
    team: workspace,
    memberId: 'zero-owner',
    quota5h: 0,
    quota7d: 0,
    quotaSnapshot: snapshot(100, 100),
    quota5hResetAfterSeconds: 99,
    lastProbe: { ok: false, status: 503, message: 'child-temporary-failure' },
  }]);
  const app = await startQuotaApp(t, { teams: [mother], children: [localOwner], usage: {} });
  const row = currentAccount(await app.publicState(), workspace, ownerEmail);
  assert.equal(row.quota5h, 0);
  assert.equal(row.quota7d, 0);
  assert.equal(row.quotaSnapshot.primary.usedPercent, 100);
  assert.equal(row.quota5hResetAfterSeconds, 99, 'reset fields belong to the displayed quota source');
  assert.equal(row.lastProbe.status, 503, 'probe failure belongs to the displayed cached child quota');
});

test('a successful child missing-window snapshot cannot resurrect an older owner cache', { timeout: 25_000 }, async (t) => {
  const workspace = 'owner-missing-window-workspace';
  const ownerEmail = 'owner@owner-missing-window.test';
  const localId = 'missing-window-owner-local';
  const mother = {
    ...team(workspace, ownerEmail, [member('missing-window-owner', ownerEmail, 'account-owner')]),
    quota5h: 80,
    quota7d: 90,
    quotaSnapshot: snapshot(20, 10),
    quota5hResetAfterSeconds: 1000,
  };
  const app = await startQuotaApp(t, {
    teams: [mother],
    children: [child(localId, ownerEmail, [{ team: workspace, memberId: 'missing-window-owner', quota5h: 80, quota7d: 90, quotaSnapshot: snapshot(20, 10) }])],
    usage: {
      [usageKey(workspace, `owner:${ownerEmail}`)]: { payload: { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 }, secondary_window: { used_percent: 10, limit_window_seconds: 604800 } } } },
      [usageKey(workspace, `child:${localId}`)]: { payload: { rate_limit: { primary_window: { used_percent: 22, limit_window_seconds: 604800 } } } },
    },
  });
  await app.check(mother.id);
  const state = await app.publicState();
  const row = currentAccount(state, workspace, ownerEmail);
  assert.equal(state.mothers[0].quota5h, 80, 'owner and local-child probes intentionally have distinct values');
  assert.equal(row.quota5h, null, 'known missing 5h window must not fall back to the owner old/full snapshot');
  assert.equal(row.quota7d, 78);
  assert.equal(row.quota5hResetAfterSeconds, null);
  assert.equal(row.quotaSnapshot.primary.usedPercent, null);
  assert.equal(row.lastProbe.secondary.usedPercent, 22, 'the displayed successful probe must match the child snapshot');
});

test('a Team with identity-only membership cannot inherit quota, resets, or probes from another Team', { timeout: 25_000 }, async (t) => {
  const teamA = 'identity-isolation-a';
  const teamB = 'identity-isolation-b';
  const email = 'shared@identity-isolation.test';
  const known = {
    quota5h: 12,
    quota7d: 34,
    quotaSnapshot: snapshot(88, 66),
    quota5hResetAfterSeconds: 111,
    quota5hResetAt: '2026-10-08T03:00:00.000Z',
    lastProbe: { ok: true, status: 200, ...snapshot(88, 66) },
  };
  const account = {
    ...child('identity-shared', email, [{ team: teamA, memberId: 'isolation-a', ...known }, { team: teamB, memberId: 'isolation-b' }]),
    ...known,
  };
  const app = await startQuotaApp(t, {
    teams: [team(teamA, 'owner-a@identity-isolation.test', [member('isolation-a', email)]), team(teamB, 'owner-b@identity-isolation.test', [member('isolation-b', email)])],
    children: [account],
    usage: {},
  });
  const state = await app.publicState();
  const rowA = currentAccount(state, teamA, email);
  const rowB = currentAccount(state, teamB, email);
  assert.equal(rowA.quota5h, 12);
  assert.equal(rowA.quota7d, 34);
  assert.equal(rowB.quota5h, null);
  assert.equal(rowB.quota7d, null);
  assert.equal(rowB.quotaSnapshot, null);
  assert.equal(rowB.quota5hResetAfterSeconds, null);
  assert.equal(rowB.quota5hResetAt, null);
  assert.equal(rowB.lastProbe, null);
});

test('main-owner quota uses the main-owner identity even when another owner token expires later', { timeout: 25_000 }, async (t) => {
  const workspace = 'owner-probe-identity-workspace';
  const mainEmail = 'main-owner@owner-probe-identity.test';
  const otherEmail = 'other-owner@owner-probe-identity.test';
  const mother = {
    ...team(workspace, mainEmail, [member('probe-main', mainEmail, 'account-owner'), member('probe-other', otherEmail, 'account-owner')]),
    accessToken: token(workspace, `owner:${mainEmail}`, 1800),
    quota5h: 80,
    quota7d: 90,
    quotaSnapshot: snapshot(20, 10),
    extra: { codex_5h_used_percent: 20, codex_7d_used_percent: 10 },
    ownerAccounts: [{ email: otherEmail, accessToken: token(workspace, `owner:${otherEmail}`, 3600) }],
  };
  const app = await startQuotaApp(t, {
    teams: [mother],
    children: [],
    usage: {
      [usageKey(workspace, `owner:${mainEmail}`)]: { payload: { rate_limit: { primary_window: { used_percent: 18, limit_window_seconds: 18000 }, secondary_window: { used_percent: 39, limit_window_seconds: 604800 } } } },
      [usageKey(workspace, `owner:${otherEmail}`)]: { payload: { rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 18000 }, secondary_window: { used_percent: 95, limit_window_seconds: 604800 } } } },
    },
  });
  await app.check(mother.id);
  const state = await app.publicState();
  const row = currentAccount(state, workspace, mainEmail);
  const other = currentAccount(state, workspace, otherEmail);
  assert.equal(row.quota5h, 82, 'main-owner quota cannot be measured through another owner token');
  assert.equal(row.quota7d, 61);
  assert.equal(other.quota5h, null, 'unmeasured second owner cannot copy the main-owner quota');
  assert.equal(other.quota7d, null);
  assert.equal(other.quotaSnapshot, null);
  assert.deepEqual(app.requests.filter((entry) => entry.pathname === '/backend-api/wham/usage').map((entry) => entry.identity), [`owner:${mainEmail}`]);
  const exported = await app.post('/api/sub2api/team-export', { motherIds: [mother.id] });
  const otherExport = exported.accounts.find((entry) => entry.email === otherEmail);
  assert.ok(otherExport);
  assert.deepEqual(Object.keys(otherExport.extra).filter((key) => /^codex_(5h|7d|primary|secondary|usage_)/.test(key)), [], 'unmeasured owner export cannot inherit main-owner usage metadata');
});

test('failed owner and member probes preserve each identity successful current-Team cache', { timeout: 25_000 }, async (t) => {
  const workspace = 'failed-cache-workspace';
  const ownerEmail = 'owner@failed-cache.test';
  const childEmail = 'member@failed-cache.test';
  const localId = 'failed-cache-child';
  const ownerKey = usageKey(workspace, `owner:${ownerEmail}`);
  const childKey = usageKey(workspace, `child:${localId}`);
  const app = await startQuotaApp(t, {
    teams: [team(workspace, ownerEmail, [member('cache-owner', ownerEmail, 'account-owner'), member('cache-child', childEmail)])],
    children: [child(localId, childEmail, [{ team: workspace, memberId: 'cache-child' }])],
    usage: {
      [ownerKey]: { payload: { rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 }, secondary_window: { used_percent: 32, limit_window_seconds: 604800 } } } },
      [childKey]: { payload: { rate_limit: { primary_window: { used_percent: 44, limit_window_seconds: 18000 }, secondary_window: { used_percent: 22, limit_window_seconds: 604800 } } } },
    },
  });
  await app.check(`mother-${workspace}`);
  app.usage[ownerKey] = { status: 503, payload: { error: 'owner-temporary-failure' } };
  app.usage[childKey] = { status: 503, payload: { error: 'child-temporary-failure' } };
  await app.check(`mother-${workspace}`);
  const state = await app.publicState();
  const ownerRow = currentAccount(state, workspace, ownerEmail);
  const childRow = currentAccount(state, workspace, childEmail);
  assert.equal(ownerRow.quota5h, 88);
  assert.equal(ownerRow.quota7d, 68);
  assert.equal(childRow.quota5h, 56);
  assert.equal(childRow.quota7d, 78);
  assert.equal(ownerRow.quotaSnapshot.primary.usedPercent, 12);
  assert.equal(childRow.quotaSnapshot.primary.usedPercent, 44);
  assert.equal(ownerRow.lastProbe.status, 503);
  assert.equal(childRow.lastProbe.status, 503);
});

for (const plan of ['team', 'self_serve_business_prolite']) {
test(`a valid top-level ${plan} member token is used for that member quota and Team JSON export`, { timeout: 25_000 }, async (t) => {
  const workspace = 'top-level-team-member-workspace';
  const ownerEmail = 'owner@top-level-member.test';
  const email = 'member@top-level-member.test';
  const localId = 'top-level-member-child';
  const identity = `child:${localId}`;
  const accessToken = token(workspace, identity, 3600, { email, plan });
  const account = {
    ...child(localId, email, [{ team: workspace, memberId: 'top-level-member', workspaceTokenStatus: 'pending', joinStatus: 'member_confirmed_token_pending', teamAuthRetryAfter: '2099-01-01T00:00:00.000Z', teamAuthLastError: 'previous-login-failure' }]),
    accountId: workspace,
    plan: 'team',
    accessToken,
    refreshToken: 'fake-top-level-team-refresh-token',
    workspaceTokens: {},
  };
  const app = await startQuotaApp(t, {
    teams: [team(workspace, ownerEmail, [member('top-level-owner', ownerEmail, 'account-owner'), member('top-level-member', email)])],
    children: [account],
    usage: {
      [usageKey(workspace, `owner:${ownerEmail}`)]: { payload: { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 }, secondary_window: { used_percent: 10, limit_window_seconds: 604800 } } } },
      [usageKey(workspace, identity)]: { payload: { rate_limit: { primary_window: { used_percent: 41, limit_window_seconds: 18000 }, secondary_window: { used_percent: 66, limit_window_seconds: 604800 } } } },
    },
  });
  const result = await app.check(`mother-${workspace}`);
  assert.equal(result.results.find((item) => item.id === localId)?.ok, true, 'valid imported Team member token must not be reported as missing_token');
  const state = await app.publicState();
  const row = currentAccount(state, workspace, email);
  assert.equal(row.quota5h, 59, 'quota is measured using this member own identity');
  assert.equal(row.quota7d, 34);
  const membership = state.children.find((item) => item.id === localId)?.workspaceHistory.find((entry) => entry.team === workspace);
  assert.equal(membership?.workspaceTokenStatus, 'ready');
  assert.equal(membership?.joinStatus, 'member_confirmed');
  assert.equal(membership?.teamAuthRetryAfter, null);
  assert.equal(membership?.teamAuthLastError, null);
  const exported = await app.post('/api/sub2api/team-export', { motherIds: [`mother-${workspace}`] });
  const entry = exported.accounts.find((item) => item.email === email);
  assert.ok(entry, 'the ordinary member top-level Team token is exportable in its workspace');
  assert.equal(entry.credentials.access_token, accessToken);
  assert.equal(entry.credentials.refresh_token, account.refreshToken);
  assert.equal(entry.credentials.chatgpt_account_id, workspace);
  assert.equal(entry.extra.codex_5h_used_percent, 41);
  assert.equal(entry.extra.codex_7d_used_percent, 66);
  const persisted = await app.persistedState();
  const saved = persisted.children.find((item) => item.id === localId);
  assert.equal(saved.workspaceTokens[workspace].accessToken, accessToken, 'adopted Team credentials are saved to the isolated state file');
  assert.equal(saved.workspaceTokens[workspace].refreshToken, account.refreshToken);
  assert.equal(saved.workspaceHistory.find((item) => item.team === workspace).workspaceTokenStatus, 'ready');
  assert.deepEqual(app.requests.filter((request) => request.pathname === '/backend-api/wham/usage').map((request) => request.identity).sort(), [identity, `owner:${ownerEmail}`].sort());
});
}

test('a scoped Team quota check probes only selected members and still probes the owner, while the default checks every member', { timeout: 25_000 }, async (t) => {
  const workspace = 'scoped-quota-workspace';
  const ownerEmail = 'owner@scoped-quota.test';
  const selected = child('scoped-selected', 'selected@scoped-quota.test', [{ team: workspace, memberId: 'scoped-selected-member' }]);
  const unselected = child('scoped-unselected', 'unselected@scoped-quota.test', [{ team: workspace, memberId: 'scoped-unselected-member' }]);
  const ownerIdentity = `owner:${ownerEmail}`;
  const selectedIdentity = `child:${selected.id}`;
  const unselectedIdentity = `child:${unselected.id}`;
  const app = await startQuotaApp(t, {
    teams: [team(workspace, ownerEmail, [member('scoped-owner-member', ownerEmail, 'account-owner'), member('scoped-selected-member', selected.email), member('scoped-unselected-member', unselected.email)])],
    children: [selected, unselected],
    usage: {
      [usageKey(workspace, ownerIdentity)]: { payload: { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } } } },
      [usageKey(workspace, selectedIdentity)]: { payload: { rate_limit: { primary_window: { used_percent: 41, limit_window_seconds: 18000 } } } },
      [usageKey(workspace, unselectedIdentity)]: { payload: { rate_limit: { primary_window: { used_percent: 66, limit_window_seconds: 18000 } } } },
    },
  });
  const scopedResult = await app.check(`mother-${workspace}`, [selected.id]);
  assert.equal(scopedResult.checked, 1);
  assert.deepEqual(scopedResult.results.map((entry) => entry.id), [selected.id]);
  assert.equal(scopedResult.ownerProbe.ok, true, 'a selected-member check must retain the owner probe');
  const scopedState = await app.publicState();
  assert.equal(currentAccount(scopedState, workspace, ownerEmail).quota5h, 95);
  assert.equal(currentAccount(scopedState, workspace, selected.email).quota5h, 59);
  assert.equal(currentAccount(scopedState, workspace, unselected.email).quota5h, null, 'an unselected member cannot inherit another member measurement');
  assert.deepEqual(app.requests.filter((request) => request.pathname === '/backend-api/wham/usage').map((request) => request.identity).sort(), [ownerIdentity, selectedIdentity].sort(), 'the unselected token must not be probed');
  const beforeDefaultCheck = app.requests.length;
  const defaultResult = await app.check(`mother-${workspace}`);
  assert.equal(defaultResult.checked, 2, 'omitting childIds preserves the existing full-Team behavior');
  assert.deepEqual(defaultResult.results.map((entry) => entry.id).sort(), [selected.id, unselected.id].sort());
  assert.deepEqual(app.requests.slice(beforeDefaultCheck).filter((request) => request.pathname === '/backend-api/wham/usage').map((request) => request.identity).sort(), [ownerIdentity, selectedIdentity, unselectedIdentity].sort());
  assert.equal(currentAccount(await app.publicState(), workspace, unselected.email).quota5h, 34);
});

test('top-level Team fallback requires matching identity, Team scope, and an unexpired token', { timeout: 25_000 }, async (t) => {
  const workspace = 'top-level-token-safety-workspace';
  const ownerEmail = 'owner@top-level-safety.test';
  const cases = [
    { name: 'user-id-match', accepted: true, userId: 'same-user-id', storedUserId: 'same-user-id' },
    { name: 'business-plan', accepted: true, plan: 'business', profileEmail: true },
    { name: 'prolite-plan', accepted: true, plan: 'self_serve_business_prolite', profileEmail: true },
    { name: 'free-plan', accepted: false, plan: 'free', profileEmail: true },
    { name: 'prolite-like-free-plan', accepted: false, plan: 'self_serve_business_free', profileEmail: true },
    { name: 'unknown-business-prefix-plan', accepted: false, plan: 'self_serve_business_unknown', profileEmail: true },
    { name: 'unknown-prolite-suffix-plan', accepted: false, plan: 'self_serve_business_prolite_unknown', profileEmail: true },
    { name: 'other-team', accepted: false, tokenTeam: 'unrelated-workspace', profileEmail: true },
    { name: 'prolite-other-team', accepted: false, plan: 'self_serve_business_prolite', tokenTeam: 'unrelated-workspace', profileEmail: true },
    { name: 'wrong-email', accepted: false, email: 'someone-else@top-level-safety.test' },
    { name: 'prolite-wrong-email', accepted: false, plan: 'self_serve_business_prolite', email: 'someone-else@top-level-safety.test' },
    { name: 'expired', accepted: false, expiresIn: -3600, profileEmail: true },
    { name: 'expiring', accepted: false, expiresIn: 10, profileEmail: true },
    { name: 'missing-expiration', accepted: false, expiresIn: null, profileEmail: true },
    { name: 'unknown-identity', accepted: false },
    { name: 'wrong-user-id', accepted: false, userId: 'different-user-id', storedUserId: 'wrong-user-id-stored' },
    { name: 'prolite-wrong-user-id', accepted: false, plan: 'self_serve_business_prolite', userId: 'different-prolite-user-id', storedUserId: 'wrong-prolite-user-id-stored' },
    { name: 'mismatched-email-matching-user-id', accepted: false, email: 'someone-else@top-level-safety.test', userId: 'matching-user-id-with-wrong-email', storedUserId: 'matching-user-id-with-wrong-email' },
    { name: 'matching-email-mismatched-user-id', accepted: false, profileEmail: true, userId: 'wrong-user-with-matching-email', storedUserId: 'expected-user-with-matching-email' },
  ];
  const children = cases.map((entry) => {
    const id = `safety-${entry.name}`;
    const email = `${entry.name}@top-level-safety.test`;
    return {
      ...child(id, email, [{ team: workspace, memberId: `member-${entry.name}` }]),
      accountId: workspace,
      plan: 'team',
      chatgptUserId: entry.storedUserId || '',
      accessToken: token(entry.tokenTeam || workspace, `child:${id}`, entry.expiresIn === undefined ? 3600 : entry.expiresIn, { email: entry.profileEmail ? email : entry.email, userId: entry.userId, plan: entry.plan || 'team' }),
      workspaceTokens: {},
    };
  });
  const usage = {
    [usageKey(workspace, `owner:${ownerEmail}`)]: { payload: { rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 18000 } } } },
  };
  children.forEach((account) => {
    usage[usageKey(workspace, `child:${account.id}`)] = { payload: { rate_limit: { primary_window: { used_percent: 33, limit_window_seconds: 18000 }, secondary_window: { used_percent: 44, limit_window_seconds: 604800 } } } };
  });
  const app = await startQuotaApp(t, {
    teams: [team(workspace, ownerEmail, [member('safety-owner', ownerEmail, 'account-owner'), ...children.map((account, index) => member(`member-${cases[index].name}`, account.email))])],
    children,
    usage,
  });
  const result = await app.check(`mother-${workspace}`);
  const state = await app.publicState();
  const exported = await app.post('/api/sub2api/team-export', { motherIds: [`mother-${workspace}`] });
  for (const entry of cases) {
    const id = `safety-${entry.name}`;
    const email = `${entry.name}@top-level-safety.test`;
    const row = currentAccount(state, workspace, email);
    const probe = result.results.find((item) => item.id === id);
    assert.equal(probe?.ok, entry.accepted, `${entry.name} acceptance must match the confirmed token identity and scope`);
    assert.equal(row.quota5h, entry.accepted ? 67 : null, `${entry.name} cannot use unrelated or expired credentials to read quota`);
    assert.equal(row.quota7d, entry.accepted ? 56 : null);
    assert.equal(exported.accounts.some((account) => account.email === email), entry.accepted, `${entry.name} Team export follows the same scope rules`);
    assert.equal(app.requests.some((request) => request.pathname === '/backend-api/wham/usage' && request.identity === `child:${id}`), entry.accepted);
  }
});

test('a same-Team workspace map token belonging to another member cannot supply this member quota or Team export', { timeout: 25_000 }, async (t) => {
  const workspace = 'workspace-map-identity-isolation';
  const ownerEmail = 'owner@workspace-map-isolation.test';
  const email = 'member@workspace-map-isolation.test';
  const localId = 'workspace-map-isolation-child';
  const userId = 'workspace-map-isolation-user';
  const mother = team(workspace, ownerEmail, [member('map-isolation-owner', ownerEmail, 'account-owner'), member('map-isolation-member', email)]);
  const personalToken = token(`personal-${localId}`, `child:${localId}`, 3600, { email, userId, plan: 'free' });
  const account = {
    ...child(localId, email, [{ team: workspace, memberId: 'map-isolation-member' }]),
    chatgptUserId: userId,
    accountId: `personal-${localId}`,
    accessToken: personalToken,
    workspaceTokens: { [workspace]: { accessToken: mother.accessToken } },
  };
  const app = await startQuotaApp(t, {
    teams: [mother],
    children: [account],
    usage: { [usageKey(workspace, `owner:${ownerEmail}`)]: { payload: { rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 18000 }, secondary_window: { used_percent: 11, limit_window_seconds: 604800 } } } } },
    refreshResponses: {},
  });
  const result = await app.check(mother.id);
  const probe = result.results.find((entry) => entry.id === localId);
  assert.equal(probe?.ok, false);
  assert.equal(probe?.message, 'missing_token');
  const row = currentAccount(await app.publicState(), workspace, email);
  assert.equal(row.quota5h, null);
  assert.equal(row.quota7d, null);
  assert.deepEqual(app.requests.filter((request) => request.pathname === '/backend-api/wham/usage').map((request) => request.identity), [`owner:${ownerEmail}`], 'the owner token can be measured only as the owner, never again as this child');
  const exported = await app.post('/api/sub2api/team-export', { motherIds: [mother.id] });
  assert.equal(exported.accounts.some((entry) => entry.email === email), false);
  assert.equal((await app.persistedState()).children[0].accessToken, personalToken);
});

test('workspace switching refuses another member same-Team token and preserves the original personal identity and credentials', { timeout: 25_000 }, async (t) => {
  const workspace = 'workspace-switch-identity-isolation';
  const ownerEmail = 'owner@workspace-switch-isolation.test';
  const email = 'member@workspace-switch-isolation.test';
  const localId = 'workspace-switch-isolation-child';
  const userId = 'workspace-switch-isolation-user';
  const identity = `child:${localId}`;
  const personalId = `personal-${localId}`;
  const personalToken = token(personalId, identity, 3600, { email, userId, plan: 'free' });
  const mother = team(workspace, ownerEmail, [member('switch-isolation-owner', ownerEmail, 'account-owner'), member('switch-isolation-member', email)]);
  const account = { ...child(localId, email, [{ team: workspace, memberId: 'switch-isolation-member' }]), chatgptUserId: userId, accountId: personalId, accessToken: personalToken, refreshToken: 'fixture-original-personal-rt', workspaceTokens: {} };
  const app = await startQuotaApp(t, {
    teams: [mother],
    children: [account],
    usage: { [usageKey(workspace, `owner:${ownerEmail}`)]: { payload: { rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 18000 } } } } },
    refreshResponses: {},
    sessionResponses: { [identity]: { status: 200, payload: { accessToken: mother.accessToken } } },
  });
  const switched = await app.rawPost(`/api/children/${localId}/switch`, { workspaceId: workspace });
  assert.equal(switched.ok, false, 'a matching workspace alone cannot authorize using another person token');
  assert.equal(switched.data.ok, false);
  assert.equal(switched.data.code, 'token_identity_mismatch');
  const saved = (await app.persistedState()).children[0];
  assert.equal(saved.accessToken, personalToken);
  assert.equal(saved.refreshToken, account.refreshToken);
  assert.equal(saved.accountId, personalId);
  assert.equal(saved.chatgptUserId, userId);
  assert.equal(saved.workspaceTokens[workspace], undefined);
  assert.equal(saved.workspaceHistory.find((entry) => entry.team === workspace).quota5h ?? null, null);
  assert.deepEqual(app.requests.filter((request) => request.pathname === '/api/auth/session').map((request) => request.identity), [identity]);
  const exported = await app.post('/api/sub2api/team-export', { motherIds: [mother.id] });
  assert.equal(exported.accounts.some((entry) => entry.email === email), false);
});

test('a valid workspace map token takes priority, while an expired map may fall back to a valid matching top-level token', { timeout: 25_000 }, async (t) => {
  const workspace = 'top-level-map-priority-workspace';
  const ownerEmail = 'owner@map-priority.test';
  const cases = [
    { name: 'valid-map', mapExpiresIn: 3600, expectedIdentity: 'workspace:valid-map', expectedQuota: 76 },
    { name: 'expired-map', mapExpiresIn: -3600, expectedIdentity: 'top-level:expired-map', expectedQuota: 49 },
  ];
  const children = cases.map((entry) => {
    const email = `${entry.name}@map-priority.test`;
    return {
      ...child(`priority-${entry.name}`, email, [{ team: workspace, memberId: `priority-${entry.name}` }]),
      plan: 'team',
      accountId: workspace,
      accessToken: token(workspace, `top-level:${entry.name}`, 3600, { email }),
      workspaceTokens: { [workspace]: { accessToken: token(workspace, `workspace:${entry.name}`, entry.mapExpiresIn, { email }) } },
    };
  });
  const usage = {
    [usageKey(workspace, `owner:${ownerEmail}`)]: { payload: { rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 18000 } } } },
  };
  for (const entry of cases) {
    usage[usageKey(workspace, `workspace:${entry.name}`)] = { payload: { rate_limit: { primary_window: { used_percent: 24, limit_window_seconds: 18000 } } } };
    usage[usageKey(workspace, `top-level:${entry.name}`)] = { payload: { rate_limit: { primary_window: { used_percent: 51, limit_window_seconds: 18000 } } } };
  }
  const app = await startQuotaApp(t, {
    teams: [team(workspace, ownerEmail, [member('priority-owner', ownerEmail, 'account-owner'), ...children.map((account) => member(account.id, account.email))])],
    children,
    usage,
  });
  const result = await app.check(`mother-${workspace}`);
  const state = await app.publicState();
  const exported = await app.post('/api/sub2api/team-export', { motherIds: [`mother-${workspace}`] });
  for (const entry of cases) {
    const account = children.find((item) => item.email === `${entry.name}@map-priority.test`);
    assert.equal(result.results.find((item) => item.id === account.id)?.ok, true, `${entry.name} must select a valid own Team token`);
    assert.equal(currentAccount(state, workspace, account.email).quota5h, entry.expectedQuota);
    const requests = app.requests.filter((request) => request.pathname === '/backend-api/wham/usage' && request.identity.includes(`:${entry.name}`));
    assert.deepEqual(requests.map((request) => request.identity), [entry.expectedIdentity]);
    const exportEntry = exported.accounts.find((item) => item.email === account.email);
    assert.ok(exportEntry);
    const exportIdentity = requestIdentity({ headers: { authorization: `Bearer ${exportEntry.credentials.access_token}` } });
    assert.equal(exportIdentity, entry.expectedIdentity);
  }
});

test('an expired matching top-level Team token can use its RT to restore its own Team quota', { timeout: 25_000 }, async (t) => {
  const workspace = 'expired-top-level-refresh-workspace';
  const ownerEmail = 'owner@expired-top-refresh.test';
  const email = 'member@expired-top-refresh.test';
  const localId = 'expired-top-refresh-child';
  const userId = 'expired-top-refresh-user';
  const refreshToken = 'fake-expired-top-level-refresh-token';
  const renewedToken = token(workspace, 'renewed:expired-top-refresh', 3600, { email, userId });
  const account = {
    ...child(localId, email, [{ team: workspace, memberId: 'expired-top-refresh-member', joinStatus: 'member_confirmed', workspaceTokenStatus: 'pending' }]),
    accountId: workspace,
    chatgptUserId: userId,
    plan: 'team',
    accessToken: token(workspace, 'expired:top-level-refresh', -3600, { email, userId }),
    refreshToken,
    workspaceTokens: {},
  };
  const app = await startQuotaApp(t, {
    teams: [team(workspace, ownerEmail, [member('expired-top-refresh-owner', ownerEmail, 'account-owner'), member('expired-top-refresh-member', email)])],
    children: [account],
    usage: {
      [usageKey(workspace, `owner:${ownerEmail}`)]: { payload: { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } } } },
      [usageKey(workspace, 'renewed:expired-top-refresh')]: { payload: { rate_limit: { primary_window: { used_percent: 39, limit_window_seconds: 18000 }, secondary_window: { used_percent: 72, limit_window_seconds: 604800 } } } },
    },
    refreshResponses: { [refreshToken]: { status: 200, payload: { access_token: renewedToken, refresh_token: 'fake-rotated-team-refresh-token' } } },
  });
  const result = await app.check(`mother-${workspace}`);
  const probe = result.results.find((item) => item.id === localId);
  assert.equal(probe?.ok, true);
  assert.equal(probe?.tokenRecovery?.ok, true);
  assert.equal(probe?.tokenRecovery?.credentialLogin, false, 'matching RT recovery does not need a password login');
  const state = await app.publicState();
  assert.equal(currentAccount(state, workspace, email).quota5h, 61);
  assert.equal(currentAccount(state, workspace, email).quota7d, 28);
  const saved = (await app.persistedState()).children.find((item) => item.id === localId);
  assert.equal(saved.chatgptUserId, userId);
  assert.equal(saved.workspaceTokens[workspace].accessToken, renewedToken);
  assert.equal(saved.workspaceTokens[workspace].refreshToken, 'fake-rotated-team-refresh-token');
  assert.equal(saved.workspaceHistory.find((entry) => entry.team === workspace).workspaceTokenStatus, 'ready');
  const exported = await app.post('/api/sub2api/team-export', { motherIds: [`mother-${workspace}`] });
  const entry = exported.accounts.find((item) => item.email === email);
  assert.equal(entry?.credentials.access_token, renewedToken);
  assert.equal(entry?.credentials.refresh_token, 'fake-rotated-team-refresh-token');
  assert.deepEqual(app.requests.filter((request) => request.pathname === '/mock-oauth/token').map((request) => [request.grantType, request.refreshToken]), [['refresh_token', refreshToken]]);
});

for (const endpoint of ['/api/maintenance/check', '/api/maintenance/check-all']) {
  test(`${endpoint} queries existing quota without browser or password login when manager and member tokens fail`, { timeout: 25_000 }, async (t) => {
    const workspace = 'quota-check-no-login-workspace';
    const ownerEmail = 'owner@quota-check-no-login.test';
    const cases = ['missing', 'unauthorized', 'rejected-refresh', 'expired-403', 'challenge-403', 'healthy'];
    const children = cases.map((name) => {
      const id = `quota-check-${name}`;
      const account = {
        ...child(id, `${name}@quota-check-no-login.test`, [{ team: workspace, memberId: id }]),
        password: 'fixture-account-password',
        totp: 'JBSWY3DPEHPK3PXP',
      };
      if (name === 'missing') account.workspaceTokens = {};
      if (name === 'rejected-refresh') account.workspaceTokens[workspace].refreshToken = 'fixture-rejected-team-rt';
      return account;
    });
    const mother = {
      ...team(workspace, ownerEmail, [member('quota-check-owner', ownerEmail, 'account-owner'), ...children.map((account) => member(account.id, account.email))]),
      password: 'fixture-owner-password',
      totp: 'JBSWY3DPEHPK3PXP',
    };
    const app = await startQuotaApp(t, {
      teams: [mother],
      children,
      roxyEnabled: true,
      workspaceResponses: { [workspace]: { status: 401, payload: { error: { code: 'token_expired', message: 'owner authorization expired' } } } },
      usage: {
        default: { status: 401, payload: { error: { code: 'token_expired', message: 'authorization expired' } } },
        [usageKey(workspace, 'child:quota-check-expired-403')]: { status: 403, payload: { error: { code: 'token_expired', message: 'authorization token expired' } } },
        [usageKey(workspace, 'child:quota-check-challenge-403')]: { status: 403, payload: { error: { code: 'cloudflare_challenge', message: 'Cloudflare challenge required' } } },
        [usageKey(workspace, 'child:quota-check-healthy')]: { payload: { rate_limit: {
          primary_window: { used_percent: 23, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 41, limit_window_seconds: 604800 },
        } } },
      },
      refreshResponses: { 'fixture-rejected-team-rt': { status: 400, payload: { error: 'invalid_grant' } } },
    });
    assert.equal((await app.publicState()).settings.integrations.roxy.enabled, true, 'the regression requires a configured and enabled browser backend');
    const response = await app.rawPost(endpoint, { motherId: mother.id });
    assert.equal(response.status, 200);
    const result = endpoint.endsWith('/check-all') ? response.data.teams[0] : response.data;
    assert.equal(result.status, 207, 'unavailable authorization is a partial quota result');
    assert.equal(result.syncOk, false);
    assert.equal(result.managerAuthorizationRequired, true, 'manager 401 must direct the user to Free management');
    assert.equal(result.checked, children.length, 'failed Team management cannot suppress other member quota checks');
    assert.equal(result.reloggedTeamAccounts, 0);
    const healthy = result.results.find((entry) => entry.id === 'quota-check-healthy');
    assert.equal(healthy?.ok, true);
    assert.equal(healthy.authorizationRequired, false);
    assert.equal(healthy.quota5h, 77);
    assert.equal(healthy.quota7d, 59);
    for (const name of cases.filter((entry) => entry !== 'healthy')) {
      const probe = result.results.find((entry) => entry.id === `quota-check-${name}`);
      assert.equal(probe?.ok, false, `${name} retains its authorization failure`);
      assert.equal(probe.quota5h, null, `${name} must not invent a quota`);
      assert.equal(probe.quota7d, null);
      assert.equal(probe.authorizationRequired, name !== 'challenge-403', `${name} distinguishes authorization loss from an unrelated 403`);
      if (name === 'challenge-403') assert.equal(probe.tokenRecovery, null, 'an upstream challenge cannot require a new Team authorization');
      else assert.ok(probe.tokenRecovery, `${name} may attempt its existing refresh token`);
      if (probe.tokenRecovery) {
        assert.equal(probe.tokenRecovery.credentialLogin, false);
        assert.equal(probe.tokenRecovery.credentialLoginAttempted, false, `${name} must never start a login`);
        assert.equal(probe.tokenRecovery.browserRequired, false);
        assert.equal(probe.tokenRecovery.needsInput, false);
        assert.match(probe.tokenRecovery.message, /Free 账号管理/, 'unavailable Team authorization points to the explicit login action');
      }
    }
    const saved = await app.persistedState();
    assert.equal(saved.mothers[0].lastManagerRecoveryAttemptAt ?? null, null, 'manager quota recovery cannot attempt a password login');
    for (const account of saved.children) {
      assert.equal(account.teamLoginAttemptedAt ?? null, null, 'quota checks cannot replace the Free management login state');
      assert.deepEqual(Object.keys(account.teamAuthSessions || {}), [], 'quota checks cannot create an OAuth session');
    }
    assert.deepEqual(app.requests.filter((entry) => entry.pathname.startsWith('/browser/')), [], 'Roxy must not receive profile creation, opening, or cleanup requests');
    assert.deepEqual(app.requests.filter((entry) => entry.pathname === '/mock-blocked-external'), [], 'quota checks cannot attempt a protocol login either');
    const refreshRequests = app.requests.filter((entry) => entry.pathname === '/mock-oauth/token');
    assert.ok(refreshRequests.length > 0, 'the existing Team refresh token was attempted');
    assert.ok(refreshRequests.every((entry) => entry.grantType === 'refresh_token' && entry.refreshToken === 'fixture-rejected-team-rt'));
  });
}

test('an explicit same-member Team refresh updates the account and selected workspace credentials together', { timeout: 25_000 }, async (t) => {
  const workspace = 'explicit-refresh-workspace';
  const otherWorkspace = 'explicit-refresh-other-workspace';
  const email = 'member@explicit-refresh.test';
  const localId = 'explicit-refresh-child';
  const userId = 'explicit-refresh-user';
  const refreshToken = 'fake-explicit-refresh-token';
  const oldToken = token(workspace, 'old:explicit-refresh', -3600, { email, userId });
  const oldMappedToken = token(workspace, 'old-map:explicit-refresh', 3600, { email, userId });
  const otherToken = token(otherWorkspace, 'other:explicit-refresh', 3600, { email, userId });
  const renewedToken = token(workspace, 'new:explicit-refresh', 3600, { email, userId });
  const account = {
    ...child(localId, email, [{ team: workspace, memberId: 'explicit-refresh-member', workspaceTokenStatus: 'pending', joinStatus: 'member_confirmed_token_pending', teamAuthRetryAfter: '2099-01-01T00:00:00.000Z', teamAuthLastError: 'old-auth-failure' }]),
    accountId: workspace,
    chatgptUserId: userId,
    plan: 'team',
    accessToken: oldToken,
    refreshToken,
    workspaceTokens: {
      [workspace]: { accessToken: oldMappedToken, refreshToken: 'fake-old-map-refresh-token' },
      [otherWorkspace]: { accessToken: otherToken, refreshToken: 'fake-other-workspace-refresh-token' },
    },
  };
  const app = await startQuotaApp(t, {
    teams: [team(workspace, 'owner@explicit-refresh.test', [member('explicit-refresh-member', email)])],
    children: [account],
    usage: {},
    refreshResponses: { [refreshToken]: { status: 200, payload: { access_token: renewedToken, refresh_token: 'fake-explicit-rotated-refresh-token' } } },
  });
  const response = await app.rawPost(`/api/children/${localId}/acquire`, { mode: 'refresh-at' });
  assert.equal(response.status, 200);
  assert.equal(response.data.source, 'refresh_token');
  const saved = (await app.persistedState()).children.find((item) => item.id === localId);
  assert.equal(saved.accessToken, renewedToken);
  assert.equal(saved.refreshToken, 'fake-explicit-rotated-refresh-token');
  assert.equal(saved.chatgptUserId, userId);
  assert.equal(saved.workspaceTokens[workspace].accessToken, renewedToken, 'regular account refresh replaces the selected workspace old AT');
  assert.equal(saved.workspaceTokens[workspace].refreshToken, 'fake-explicit-rotated-refresh-token');
  assert.equal(saved.workspaceTokens[otherWorkspace].accessToken, otherToken, 'another Team retains its own credentials');
  const membership = saved.workspaceHistory.find((entry) => entry.team === workspace);
  assert.equal(membership.workspaceTokenStatus, 'ready');
  assert.equal(membership.joinStatus, 'member_confirmed');
  assert.equal(membership.teamAuthRetryAfter, null);
  assert.equal(membership.teamAuthLastError, null);
  const exported = await app.post('/api/sub2api/team-export', { motherIds: [`mother-${workspace}`] });
  assert.equal(exported.accounts.find((item) => item.email === email)?.credentials.access_token, renewedToken);
});

test('refresh and callback login reject another member token without replacing the original identity or credentials', { timeout: 25_000 }, async (t) => {
  const workspace = 'refresh-identity-mismatch-workspace';
  const cases = [
    { name: 'refresh-wrong-user', responseEmail: 'same', responseUser: 'wrong', login: false },
    { name: 'refresh-wrong-email', responseEmail: 'wrong', responseUser: 'same', login: false },
    { name: 'login-wrong-user', responseEmail: 'same', responseUser: 'wrong', login: true },
    { name: 'login-wrong-email', responseEmail: 'wrong', responseUser: 'same', login: true },
  ];
  const children = cases.map((entry) => {
    const email = `${entry.name}@identity-mismatch.test`;
    const userId = `stored-user:${entry.name}`;
    const accessToken = token(workspace, `original:${entry.name}`, -3600, { email, userId });
    return {
      ...child(`identity-${entry.name}`, email, [{ team: workspace, memberId: `member-${entry.name}` }]),
      accountId: workspace,
      chatgptUserId: userId,
      accessToken,
      refreshToken: entry.login ? '' : `fake-refresh:${entry.name}`,
      workspaceTokens: { [workspace]: { accessToken, refreshToken: `fake-map-refresh:${entry.name}` } },
      ...(entry.login ? { password: 'test-only-password', totp: 'JBSWY3DPEHPK3PXP', authSession: { state: `oauth-state:${entry.name}`, codeVerifier: 'test-only-code-verifier' } } : {}),
    };
  });
  const refreshResponses = {};
  cases.forEach((entry, index) => {
    const account = children[index];
    const wrongToken = token(workspace, `unexpected:${entry.name}`, 3600, {
      email: entry.responseEmail === 'same' ? account.email : 'another-member@identity-mismatch.test',
      userId: entry.responseUser === 'same' ? account.chatgptUserId : `different-user:${entry.name}`,
    });
    refreshResponses[entry.login ? `authorization-code:${entry.name}` : account.refreshToken] = {
      status: 200,
      payload: { access_token: wrongToken, refresh_token: `fake-unexpected-refresh:${entry.name}` },
    };
  });
  const app = await startQuotaApp(t, {
    teams: [team(workspace, 'owner@identity-mismatch.test', children.map((account, index) => member(`member-${cases[index].name}`, account.email)))],
    children,
    usage: {},
    refreshResponses,
  });
  for (const [index, entry] of cases.entries()) {
    const account = children[index];
    const body = entry.login
      ? { mode: 'free-json', callbackUrl: `http://localhost:1455/auth/callback?code=${encodeURIComponent(`authorization-code:${entry.name}`)}&state=${encodeURIComponent(`oauth-state:${entry.name}`)}` }
      : { mode: 'refresh-at' };
    const response = await app.rawPost(`/api/children/${account.id}/acquire`, body);
    assert.equal(response.status, 502, `${entry.name} rejects a different-member credential response`);
    assert.equal(response.data.code, 'token_identity_mismatch');
    const saved = (await app.persistedState()).children.find((item) => item.id === account.id);
    assert.equal(saved.email, account.email);
    assert.equal(saved.chatgptUserId, account.chatgptUserId);
    assert.equal(saved.accessToken, account.accessToken);
    assert.equal(saved.refreshToken, account.refreshToken);
    assert.equal(saved.workspaceTokens[workspace].accessToken, account.accessToken);
    assert.equal(saved.workspaceTokens[workspace].refreshToken, `fake-map-refresh:${entry.name}`);
  }
  assert.deepEqual(app.requests.filter((request) => request.pathname === '/mock-oauth/token').map((request) => request.grantType), ['refresh_token', 'refresh_token', 'authorization_code', 'authorization_code']);
});
