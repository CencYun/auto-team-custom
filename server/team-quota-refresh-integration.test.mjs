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
const dataKey = 'isolated-team-quota-refresh-key';
const email = 'member@example.test';
const scope = { motherId: 'mother-a', workspaceId: 'team-a' };
const endpoint = '/api/children/member/team-quota';
const previousAt = '2026-01-01T00:00:00.000Z';
function token(workspaceId, { plan = 'team', userId = 'member-user', tokenEmail = email, expiresIn = 3600 } = {}) {
  return `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresIn, sub: userId,
    'https://api.openai.com/auth': { chatgpt_account_id: workspaceId, chatgpt_plan_type: plan, chatgpt_user_id: userId },
    'https://api.openai.com/profile': { email: tokenEmail },
  })).toString('base64url')}.private-fixture-signature`;
}
function credentials(workspaceId, options) {
  return { accountId: workspaceId, accessToken: token(workspaceId, options), refreshToken: `private-rt-${workspaceId}`, clientId: 'fixture-client' };
}
function membership(team, quota5h = 75, quota7d = 80) {
  return { team, status: 'active', role: 'standard-user', memberId: 'member-user', quota5h, quota7d, quotaUpdatedAt: previousAt,
    quotaSnapshot: { primary: { usedPercent: 100 - quota5h }, secondary: { usedPercent: 100 - quota7d }, quotaWindowMapping: 'duration-v1', source: 'wham/usage', updatedAt: previousAt } };
}
function child(fields = {}) {
  return { id: 'member', email, password: 'private-password', totp: 'PRIVATESECRET', chatgptUserId: 'member-user',
    status: 'active', team: 'team-a', ...credentials('personal', { plan: 'free' }),
    workspaceHistory: [membership('team-a'), membership('team-b', 44, 55)],
    workspaceTokens: { 'team-a': credentials('team-a'), 'team-b': credentials('team-b') }, ...fields };
}
function mother(workspace = 'team-a', id = 'mother-a') {
  return { id, team: workspace, accountId: workspace, email: 'owner@example.test', rotationEnabled: false,
    ...credentials(workspace, { userId: 'owner-user', tokenEmail: 'owner@example.test' }) };
}
function usage(used5h = 12, used7d = 34) {
  return { plan_type: 'team', rate_limit: {
    primary_window: { used_percent: used7d, limit_window_seconds: 604800, reset_after_seconds: 600 },
    secondary_window: { used_percent: used5h, limit_window_seconds: 18000, reset_after_seconds: 300 },
  } };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function fixture(t, { children = [child()], mothers = [mother(), mother('team-b', 'mother-b')], onUsage, onRefresh, onOther, settings = {} } = {}) {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let claims = {};
    try { claims = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()); } catch { /* No token for RT exchange. */ }
    const entry = { pathname, method: req.method, workspaceId: req.headers['chatgpt-account-id'], userId: claims.sub, token: bearer };
    requests.push(entry);
    let reply = await onOther?.(entry) || { status: 503, payload: { error: 'unexpected_fixture_request' } };
    if (pathname === '/backend-api/wham/usage') reply = await onUsage?.(entry, requests) || { status: 200, payload: usage() };
    if (pathname === '/mock-token') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      entry.grantType = body.get('grant_type');
      entry.refreshToken = body.get('refresh_token');
      entry.authorizationCode = body.get('code');
      reply = await onRefresh?.(entry, requests) || { status: 401, payload: { error: 'private-refresh-error' } };
    }
    res.writeHead(reply.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.payload || {}));
  });
  const upstreamPort = await listen(upstream);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'team-quota-refresh-'));
  const stateFile = path.join(dataDir, 'state.json');
  await writeFile(stateFile, JSON.stringify({ version: 1, settings: { autoRefill: false, delayedKickEnabled: false, ...settings }, mothers, children, history: [] }));
  const portProbe = createServer();
  const port = await listen(portProbe);
  await new Promise((resolve) => portProbe.close(resolve));
  const preload = `
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.hostname === 'auth.openai.com' && ['/api/oauth/oauth2/token', '/oauth/token'].includes(url.pathname)) {
        return nativeFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/mock-token`)}, options);
      }
      if (url.hostname !== '127.0.0.1') throw new Error('isolated_external_network_disabled');
      return nativeFetch(input, options);
    };`;
  const app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      TEAM_ROTATION_DATA_DIR: dataDir, TEAM_ROTATION_DATA_KEY: dataKey, TEAM_ROTATION_API_TOKEN: '',
      TEAM_ROTATION_LOGIN_PASSWORD: 'isolated-password', DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: 'false', OPENAI_REQUEST_TIMEOUT_MS: '3000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk; });
  app.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (app.exitCode === null && app.signalCode === null) { const exited = new Promise((resolve) => app.once('exit', resolve)); app.kill(); await exited; }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`fixture server exited: ${output}`);
    try { if ((await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Starting listener. */ }
    await delay(25);
  }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'isolated-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  return {
    requests,
    async request(route = endpoint, { method = 'POST', body = scope, authenticated = true } = {}) {
      const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
      return { status: response.status, data: await response.json() };
    },
    async saved() {
      const envelope = JSON.parse(await readFile(stateFile, 'utf8'));
      if (!envelope.encrypted) return envelope;
      const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(dataKey).digest(), Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString());
    },
  };
}

test('refresh measures exact Team member windows including zero and isolates other spaces and Free credentials', async (t) => {
  const member = child();
  const app = await fixture(t, { children: [member], onUsage: () => ({ payload: usage(100, 20) }) });
  const result = await app.request();
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.quota5h, 0);
  assert.equal(result.data.quota7d, 80);
  assert.notEqual(result.data.quotaUpdatedAt, previousAt);
  assert.deepEqual(app.requests.map(({ pathname, workspaceId, userId }) => ({ pathname, workspaceId, userId })),
    [{ pathname: '/backend-api/wham/usage', workspaceId: 'team-a', userId: 'member-user' }]);
  assert.doesNotMatch(JSON.stringify(result.data), /private-|accessToken|refreshToken|password|PRIVATESECRET/);
  const saved = (await app.saved()).children[0];
  assert.equal(saved.accessToken, member.accessToken);
  assert.deepEqual(saved.workspaceTokens, member.workspaceTokens);
  assert.deepEqual(saved.workspaceHistory[1], member.workspaceHistory[1]);
  assert.equal(saved.workspaceHistory[0].quota5h, 0);
  assert.equal(saved.workspaceHistory[0].quotaSnapshot.primary.windowMinutes, 300);
  assert.equal(saved.workspaceHistory[0].quotaSnapshot.secondary.windowMinutes, 10080);
});

test('refresh requires dashboard auth, explicit matching scope and active membership before network', async (t) => {
  const member = child();
  member.workspaceHistory[1].status = 'kicked';
  const app = await fixture(t, { children: [member] });
  assert.equal((await app.request(endpoint, { authenticated: false })).status, 401);
  for (const body of [{}, { motherId: scope.motherId }, { workspaceId: scope.workspaceId }, { motherId: [], workspaceId: scope.workspaceId }]) {
    assert.equal((await app.request(endpoint, { body })).status, 400);
  }
  assert.equal((await app.request(endpoint, { body: { motherId: 'mother-b', workspaceId: 'team-a' } })).data.code, 'team_workspace_mismatch');
  assert.equal((await app.request(endpoint, { body: { motherId: 'mother-b', workspaceId: 'team-b' } })).data.code, 'team_membership_required');
  assert.equal((await app.request('/api/children/unknown/team-quota')).status, 404);
  assert.equal(app.requests.length, 0);
});

test('Free, wrong-space and wrong-user credentials never become quota requests or credential login', async (t) => {
  for (const [name, credential] of [
    ['Free', credentials('team-a', { plan: 'free' })],
    ['wrong-space', credentials('team-b')],
    ['wrong-user', credentials('team-a', { userId: 'other-user', tokenEmail: 'other@example.test' })],
  ]) await t.test(name, async (t) => {
    const app = await fixture(t, { children: [child({ workspaceTokens: { 'team-a': credential } })] });
    const result = await app.request();
    assert.equal(result.status, 409);
    assert.equal(result.data.code, 'team_token_required');
    assert.equal(app.requests.length, 0);
  });
});

test('403 and empty 200 keep last good snapshot, report failure and never log out dashboard', async (t) => {
  const member = child();
  let denied = true;
  const app = await fixture(t, { children: [member], onUsage: () => denied
    ? { status: 403, payload: { detail: 'private-upstream-secret' } } : { status: 200, payload: {} } });
  for (const [upstreamStatus, code] of [[403, 'team_quota_forbidden'], [200, 'team_quota_unavailable']]) {
    const result = await app.request();
    assert.equal(result.status, 502);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.upstreamStatus, upstreamStatus);
    assert.equal(result.data.code, code);
    assert.equal(result.data.quota5h, 75);
    assert.equal(result.data.quotaUpdatedAt, previousAt);
    assert.doesNotMatch(JSON.stringify(result.data), /private-upstream-secret/);
    const stored = (await app.saved()).children[0].workspaceHistory[0];
    assert.deepEqual(stored.quotaSnapshot, member.workspaceHistory[0].quotaSnapshot);
    assert.equal(stored.lastProbe.ok, false);
    denied = false;
  }
  assert.equal((await app.request('/api/state', { method: 'GET' })).status, 200);
  assert.equal(app.requests.length, 2);
});

test('failed first refresh keeps missing quotas unknown rather than inventing zero or full quota', async (t) => {
  const member = child({ workspaceHistory: [{ team: 'team-a', status: 'active' }] });
  const app = await fixture(t, { children: [member], onUsage: () => ({ status: 503 }) });
  const result = await app.request();
  assert.equal(result.status, 502);
  assert.equal(result.data.quota5h, null);
  assert.equal(result.data.quota7d, null);
  assert.equal(result.data.quotaUpdatedAt, null);
  const stored = (await app.saved()).children[0].workspaceHistory[0];
  assert.equal(stored.quotaSnapshot, undefined);
  assert.equal(stored.lastProbe.ok, false);
});

test('expired Team token refreshes only its own RT and measures after validated refresh without login', async (t) => {
  const member = child();
  member.workspaceTokens['team-a'] = credentials('team-a', { expiresIn: -100 });
  const updatedToken = token('team-a', { expiresIn: 7200 });
  const app = await fixture(t, { children: [member], onRefresh: () => ({ payload: { access_token: updatedToken, refresh_token: 'private-rt-team-a-new' } }) });
  const result = await app.request();
  assert.equal(result.status, 200);
  assert.equal(result.data.quota5h, 88);
  assert.equal(result.data.quota7d, 66);
  assert.deepEqual(app.requests.map(({ pathname }) => pathname), ['/mock-token', '/backend-api/wham/usage']);
  assert.equal(app.requests[0].grantType, 'refresh_token');
  assert.equal(app.requests[0].refreshToken, 'private-rt-team-a');
  assert.equal(app.requests[1].token, updatedToken);
  const stored = (await app.saved()).children[0];
  assert.equal(stored.workspaceTokens['team-a'].refreshToken, 'private-rt-team-a-new');
  assert.deepEqual(stored.workspaceTokens['team-b'], member.workspaceTokens['team-b']);
  assert.equal(stored.accessToken, member.accessToken);
});

test('mismatched refreshed token is rejected without saving, querying Free or falling back to login', async (t) => {
  const member = child();
  member.workspaceTokens['team-a'] = credentials('team-a', { expiresIn: -100 });
  const app = await fixture(t, { children: [member], onRefresh: () => ({ payload: { access_token: token('personal', { plan: 'free' }), refresh_token: 'private-wrong-rt' } }) });
  const result = await app.request();
  assert.equal(result.status, 502);
  assert.equal(result.data.code, 'team_token_refresh_failed');
  assert.equal(app.requests.length, 1);
  assert.deepEqual((await app.saved()).children[0].workspaceTokens, member.workspaceTokens);
});

test('a confirmed upstream 401 retries exactly once with target Team RT and stores only real returned windows', async (t) => {
  const updatedToken = token('team-a', { expiresIn: 7200 });
  const app = await fixture(t, {
    onUsage: (entry) => entry.token === updatedToken
      ? { payload: { rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800 } } } }
      : { status: 401, payload: { error: 'expired_token' } },
    onRefresh: () => ({ payload: { access_token: updatedToken, refresh_token: 'private-refreshed-team-rt' } }),
  });
  const result = await app.request();
  assert.equal(result.status, 200);
  assert.equal(result.data.quota5h, null, 'missing 5h window must not retain an older value as if just refreshed');
  assert.equal(result.data.quota7d, 100);
  assert.deepEqual(app.requests.map(({ pathname }) => pathname), ['/backend-api/wham/usage', '/mock-token', '/backend-api/wham/usage']);
  assert.equal(app.requests[1].refreshToken, 'private-rt-team-a');
});

test('401 without Team RT remains a scoped error and never launches password/browser authorization', async (t) => {
  const member = child();
  member.workspaceTokens['team-a'].refreshToken = '';
  const app = await fixture(t, { children: [member], onUsage: () => ({ status: 401, payload: { error: 'invalid_token' } }) });
  const result = await app.request();
  assert.equal(result.status, 502);
  assert.equal(result.data.upstreamStatus, 401);
  assert.equal(result.data.code, 'team_quota_auth_failed');
  assert.equal(app.requests.length, 1);
});

test('confirmed rejected authorization invalidates only its Team while retaining credentials and historical quota', async (t) => {
  const member = child();
  const app = await fixture(t, { children: [member], onUsage: () => ({ status: 401, payload: { error: 'invalid_token' } }),
    onRefresh: () => ({ status: 400, payload: { error: 'invalid_grant', error_description: 'Please authenticate again.' } }) });
  const result = await app.request();
  assert.equal(result.data.code, 'team_token_refresh_failed');
  const saved = (await app.saved()).children[0];
  assert.equal(saved.workspaceHistory[0].workspaceTokenStatus, 'invalid');
  assert.equal(saved.workspaceHistory[0].workspaceTokenInvalid, true);
  assert.deepEqual(saved.workspaceTokens, member.workspaceTokens);
  assert.deepEqual(saved.workspaceHistory[0].quotaSnapshot, member.workspaceHistory[0].quotaSnapshot);
  assert.deepEqual(saved.workspaceHistory[1], member.workspaceHistory[1]);
  const state = (await app.request('/api/state', { method: 'GET' })).data;
  const authorizations = state.children[0].teamAuthorizations;
  assert.equal(authorizations.find((entry) => entry.workspaceId === 'team-a').ready, false);
  assert.equal(authorizations.find((entry) => entry.workspaceId === 'team-a').needsReauthorization, true);
  assert.equal(authorizations.find((entry) => entry.workspaceId === 'team-b').ready, true);
  assert.deepEqual(app.requests.map((entry) => entry.pathname), ['/backend-api/wham/usage', '/mock-token']);
});

test('expired-token RT invalid_grant is confirmed but generic 403 refresh blocking only enables a retry', async (t) => {
  for (const status of [400, 403]) await t.test(String(status), async (t) => {
    const member = child();
    member.workspaceTokens['team-a'] = credentials('team-a', { expiresIn: -100 });
    const app = await fixture(t, { children: [member], onRefresh: () => ({ status,
      payload: status === 400 ? { error: 'invalid_grant', error_description: 'Please authenticate again.' } : { error: 'challenge_required' } }) });
    const result = await app.request();
    const publicChild = (await app.request('/api/state', { method: 'GET' })).data.children[0];
    const authorization = publicChild.teamAuthorizations.find((entry) => entry.workspaceId === 'team-a');
    assert.equal(authorization.needsReauthorization, status === 400);
    assert.equal(authorization.retryAuthorization, true);
    if (status === 403) assert.doesNotMatch(result.data.message, /已失效/);
    const saved = (await app.saved()).children[0];
    assert.deepEqual(saved.workspaceTokens, member.workspaceTokens);
    assert.deepEqual(saved.workspaceHistory[0].quotaSnapshot, member.workspaceHistory[0].quotaSnapshot);
    assert.deepEqual(app.requests.map((entry) => entry.pathname), ['/mock-token']);
  });
});

test('duplicate concurrent refresh clicks share one in-flight request', async (t) => {
  const entered = deferred();
  const release = deferred();
  const app = await fixture(t, { onUsage: async () => { entered.resolve(); await release.promise; return { payload: usage(25, 40) }; } });
  const first = app.request();
  await entered.promise;
  const second = app.request();
  await delay(60);
  assert.equal(app.requests.length, 1);
  release.resolve();
  const replies = await Promise.all([first, second]);
  assert.deepEqual(replies[0], replies[1]);
  assert.equal(replies[0].status, 200);
  assert.equal(app.requests.length, 1);
});

test('a manual callback waits for an older maintenance probe and its saved token stays valid', async (t) => {
  const entered = deferred();
  const release = deferred();
  const member = child();
  member.workspaceTokens['team-a'].refreshToken = '';
  const updatedToken = token('team-a', { expiresIn: 7200 });
  const app = await fixture(t, { children: [member], onUsage: async (entry) => {
    if (entry.userId !== 'member-user') return { payload: usage() };
    entered.resolve();
    await release.promise;
    return { status: 401, payload: { error: 'invalid_token' } };
  }, onRefresh: (entry) => {
    assert.equal(entry.grantType, 'authorization_code');
    return { payload: { access_token: updatedToken, refresh_token: 'private-new-callback-rt' } };
  }, onOther: (entry) => {
    if (entry.pathname === '/backend-api/accounts/team-a/users') return { payload: { items: [
      { id: 'owner-user', email: 'owner@example.test', role: 'account-owner' },
      { id: 'member-user', email, role: 'standard-user' },
    ], total: 2 } };
    if (entry.pathname === '/backend-api/subscriptions') return { payload: { seats_entitled: 2, seats_in_use: 2 } };
    if (entry.pathname === '/backend-api/codex/responses') return { payload: { status: 'completed' } };
    return null;
  } });
  const link = await app.request('/api/children/member/team-auth', { body: { ...scope, manual: true } });
  const state = new URL(link.data.authUrl).searchParams.get('state');
  const checking = app.request('/api/maintenance/check', { body: { motherId: scope.motherId, childIds: ['member'] } });
  await entered.promise;
  const callback = app.request('/api/children/member/team-auth', { body: { ...scope,
    callbackUrl: `http://localhost:1455/auth/callback?code=manual-code&state=${state}` } });
  await delay(60);
  assert.equal(app.requests.some((entry) => entry.grantType === 'authorization_code'), false);
  release.resolve();
  const results = await Promise.all([checking, callback]);
  assert.equal(results[1].data.ok, true);
  const saved = (await app.saved()).children[0];
  assert.equal(saved.workspaceTokens['team-a'].accessToken, updatedToken);
  assert.equal(saved.workspaceHistory[0].workspaceTokenInvalid, false);
  assert.equal(saved.workspaceHistory[0].lastProbe.status, 401);
  const authorization = results[1].data.child.teamAuthorizations.find((entry) => entry.workspaceId === 'team-a');
  assert.equal(authorization.ready, true);
  assert.equal(authorization.needsReauthorization, false);
});

test('different Team refreshes for one child serialize without copying values into another Team', async (t) => {
  const entered = deferred();
  const release = deferred();
  const app = await fixture(t, { onUsage: async (entry) => {
    if (entry.workspaceId === 'team-a') { entered.resolve(); await release.promise; return { payload: usage(12, 34) }; }
    return { payload: usage(67, 89) };
  } });
  const first = app.request();
  await entered.promise;
  const second = app.request(endpoint, { body: { motherId: 'mother-b', workspaceId: 'team-b' } });
  await delay(60);
  assert.equal(app.requests.length, 1);
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(({ status, data }) => [status, data.quota5h, data.quota7d]), [[200, 88, 66], [200, 33, 11]]);
  const saved = (await app.saved()).children[0];
  assert.equal(saved.quota5h, 88);
  assert.equal(saved.workspaceHistory[0].quota5h, 88);
  assert.equal(saved.workspaceHistory[1].quota5h, 33);
});

test('a member kicked during an in-flight quota request stays kicked and the late response is discarded', async (t) => {
  const entered = deferred();
  const release = deferred();
  const app = await fixture(t, {
    onUsage: async () => { entered.resolve(); await release.promise; return { payload: usage(1, 2) }; },
    onOther: (entry) => {
      if (entry.pathname === '/backend-api/accounts/team-a/users') return { payload: { items: [
        { id: 'owner-user', email: 'owner@example.test', role: 'account-owner' },
        { id: 'member-user', email, role: 'standard-user' },
      ], total: 2 } };
      if (entry.pathname === '/backend-api/accounts/team-a/users/member-user' && entry.method === 'DELETE') return { payload: { success: true } };
      return null;
    },
  });
  const pending = app.request();
  await entered.promise;
  const kicked = await app.request('/api/children/member/kick', { body: { reason: 'manual' } });
  assert.equal(kicked.status, 200);
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'team_membership_changed');
  const saved = (await app.saved()).children[0];
  assert.equal(saved.workspaceHistory[0].status, 'kicked');
  assert.equal(saved.workspaceHistory[0].quotaUpdatedAt, previousAt);
  assert.equal(saved.workspaceHistory[0].quota5h, 75);
  assert.equal(saved.workspaceHistory.filter((entry) => entry.team === 'team-a' && entry.status === 'active').length, 0);
});

test('late quota or RT response cannot update changed identity or restore removed Team membership', async (t) => {
  for (const scenario of ['email-during-quota', 'team-removed-during-quota', 'team-removed-during-refresh']) {
    await t.test(scenario, async (t) => {
      const entered = deferred();
      const release = deferred();
      const member = child();
      const refresh = scenario.endsWith('refresh');
      if (refresh) member.workspaceTokens['team-a'] = credentials('team-a', { expiresIn: -100 });
      const app = await fixture(t, { children: [member],
        onUsage: async () => { entered.resolve(); await release.promise; return { payload: usage(1, 2) }; },
        onRefresh: async () => { entered.resolve(); await release.promise; return { payload: { access_token: token('team-a'), refresh_token: 'private-new-rt' } }; },
      });
      const pending = app.request();
      await entered.promise;
      const mutated = scenario.startsWith('email')
        ? await app.request('/api/children/member', { method: 'PATCH', body: { email: 'changed@example.test' } })
        : await app.request('/api/mothers/mother-a', { method: 'DELETE', body: {} });
      assert.equal(mutated.status, 200);
      release.resolve();
      const result = await pending;
      assert.equal(result.status, 409);
      assert.equal(result.data.ok, false);
      const stored = (await app.saved()).children[0];
      assert.equal(stored.workspaceHistory[0].quotaUpdatedAt, previousAt);
      assert.deepEqual(stored.workspaceHistory[0].quotaSnapshot, member.workspaceHistory[0].quotaSnapshot);
      if (!scenario.startsWith('email')) {
        assert.equal(stored.workspaceHistory[0].status, 'team_removed');
        assert.equal(stored.workspaceTokens['team-a'], undefined);
      }
      assert.equal(app.requests.length, 1);
    });
  }
});
