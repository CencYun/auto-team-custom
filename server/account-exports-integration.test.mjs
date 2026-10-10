import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { OPENAI_OAUTH_CLIENT_ID } from './openai-auth.mjs';

const serverScript = fileURLToPath(new URL('./index.mjs', import.meta.url));
function token(email, userId, workspaceId, plan = 'free', fields = {}) {
  return `fixture.${Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600, sub: userId, client_id: OPENAI_OAUTH_CLIENT_ID,
    'https://api.openai.com/profile': { email },
    'https://api.openai.com/auth': { chatgpt_account_id: workspaceId, chatgpt_plan_type: plan, chatgpt_user_id: userId },
    ...fields,
  })).toString('base64url')}.private-fixture-signature`;
}
function credential(email, userId, workspaceId, plan = 'free', fields = {}) {
  return { email, chatgptUserId: userId, accountId: workspaceId, accessToken: token(email, userId, workspaceId, plan), refreshToken: `private-rt-${userId}-${workspaceId}`, ...fields };
}

async function fixture(t, state) {
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'account-export-integration-'));
  const stateFile = path.join(dataDir, 'state.json');
  await writeFile(stateFile, JSON.stringify({ version: 1, settings: { autoRefill: false }, history: [], ...state }));
  const preload = `globalThis.fetch = async () => { process.stderr.write('UNEXPECTED_EXPORT_NETWORK_REQUEST'); throw new Error('isolated_external_network_disabled'); };`;
  const app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), TEAM_ROTATION_DATA_DIR: dataDir,
      TEAM_ROTATION_DATA_KEY: 'isolated-export-key', TEAM_ROTATION_API_TOKEN: '', TEAM_ROTATION_LOGIN_PASSWORD: 'isolated-export-password',
      DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk; });
  app.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (app.exitCode === null && app.signalCode === null) { const exited = new Promise((resolve) => app.once('exit', resolve)); app.kill(); await exited; }
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`fixture server exited: ${output}`);
    try { if ((await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Listener starting. */ }
    await delay(25);
  }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'isolated-export-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  return {
    async request(route, { method = 'GET', body, authenticated = true } = {}) {
      const response = await fetch(`${base}${route}`, { method,
        headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, data: await response.json() };
    },
    saved: () => readFile(stateFile, 'utf8'),
    output: () => output,
  };
}

test('selective export API lists only complete saved JSON and exports exact identity/workspace selections offline', async (t) => {
  const email = 'member@example.test';
  const child = { id: 'member', ...credential(email, 'member-user', 'personal-member'), status: 'active', team: 'team-a',
    workspaceHistory: [
      { team: 'team-a', status: 'active', role: 'standard-user', quota5h: 20 },
      { team: 'team-b', status: 'active', role: 'standard-user', quota5h: 90 },
    ],
    workspaceTokens: {
      'team-a': credential(email, 'member-user', 'team-a', 'team'),
      'team-b': credential(email, 'member-user', 'team-b', 'business'),
    } };
  const mothers = [
    { id: 'mother-a', team: 'team-a', teamName: 'Team A', syncOwnerToSub2api: false, rotationEnabled: false, ...credential('owner@example.test', 'owner-user', 'team-a', 'team') },
    { id: 'mother-b', team: 'team-b', teamName: 'Team B', rotationEnabled: false, ...credential('manager@example.test', 'manager-user', 'team-b', 'team', { refreshToken: '' }) },
    { id: 'mother-web', team: 'team-web', teamName: 'Web manager', rotationEnabled: false, ...credential('web@example.test', 'web-user', 'team-web', 'team', { accessToken: token('web@example.test', 'web-user', 'team-web', 'team', { client_id: 'chatgpt-web-client' }) }) },
  ];
  const children = [child,
    { id: 'expired', ...credential('expired@example.test', 'expired-user', 'personal-expired', 'free', { accessToken: token('expired@example.test', 'expired-user', 'personal-expired', 'free', { exp: Math.floor(Date.now() / 1000) - 60 }) }) },
    { id: 'partial', ...credential('partial@example.test', 'partial-user', 'personal-partial', 'free', { refreshToken: '' }) },
    { id: 'not-authorized', email: 'invited@example.test', teamInvitations: [{ workspaceId: 'team-a', status: 'invited' }] },
    { id: 'mismatched', ...credential('saved@example.test', 'saved-user', 'personal-saved'), email: 'changed@example.test' },
    { id: 'bad-workspace', email: 'workspace@example.test', chatgptUserId: 'workspace-user', team: 'team-a', workspaceTokens: { 'team-a': credential('workspace@example.test', 'workspace-user', 'wrong-team', 'team') } },
  ];
  const app = await fixture(t, { mothers, children });
  const before = await app.saved();
  const listed = await app.request('/api/account-exports');
  assert.equal(listed.status, 200);
  const rows = listed.data.accounts;
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map((row) => row.id)).size, 5);
  assert.doesNotMatch(JSON.stringify(listed.data), /private-|access_token|refresh_token|password|credentials/);
  const owner = rows.find((row) => row.email === 'owner@example.test');
  assert.equal(owner.scope, 'team');
  assert.equal(owner.role, 'account-owner');
  assert.equal(owner.motherId, 'mother-a');
  assert.equal(rows.find((row) => row.email === 'expired@example.test').accessTokenExpired, true);
  const personal = rows.find((row) => row.childId === child.id && row.scope === 'free');
  const teamA = rows.find((row) => row.childId === child.id && row.workspaceId === 'team-a');
  const teamB = rows.find((row) => row.childId === child.id && row.workspaceId === 'team-b');
  assert.equal(teamA.teamName, 'Team A');
  assert.equal(teamB.plan, 'business');
  assert.notEqual(teamA.id, teamB.id);
  assert.equal(personal.motherId, null);

  const exported = await app.request('/api/account-exports', { method: 'POST', body: { ids: [teamB.id, personal.id] } });
  assert.equal(exported.status, 200);
  assert.equal(exported.data.accounts.length, 2);
  assert.deepEqual(exported.data.accounts.map((row) => row.credentials.chatgpt_account_id), ['team-b', 'personal-member']);
  assert.deepEqual(exported.data.accounts.map((row) => row.credentials.plan_type), ['business', 'free']);
  assert.deepEqual(exported.data.accounts.map((row) => row.credentials.refresh_token), ['private-rt-member-user-team-b', 'private-rt-member-user-personal-member']);
  assert.equal(exported.data.accounts[0].extra.codex_5h_used_percent, 10);
  assert.equal(exported.data.accounts[1].extra.codex_5h_used_percent, undefined);
  assert.equal(exported.data.accounts[1].team, undefined);
  assert.deepEqual(exported.data.proxies, []);
  assert.equal(exported.data.exported_at, exported.data.exportedAt);

  for (const ids of [undefined, [], [personal.id, personal.id], [1], ['']]) {
    const rejected = await app.request('/api/account-exports', { method: 'POST', body: { ids } });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.accounts, undefined);
  }
  const stale = await app.request('/api/account-exports', { method: 'POST', body: { ids: [personal.id, 'removed-account-id'] } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.accounts, undefined);
  assert.equal((await app.request('/api/account-exports', { authenticated: false })).status, 401);
  assert.equal((await app.request('/api/account-exports', { method: 'POST', body: { ids: [personal.id] }, authenticated: false })).status, 401);
  assert.equal(await app.saved(), before, 'export endpoints must not change persisted state');
  assert.doesNotMatch(app.output(), /UNEXPECTED_EXPORT_NETWORK_REQUEST/);
});

test('empty export pool cannot fall back to an unfiltered export', async (t) => {
  const app = await fixture(t, { mothers: [], children: [] });
  assert.deepEqual((await app.request('/api/account-exports')).data, { accounts: [] });
  assert.equal((await app.request('/api/account-exports', { method: 'POST', body: {} })).status, 400);
  assert.equal((await app.request('/api/account-exports', { method: 'POST', body: { ids: ['previous-selection'] } })).status, 409);
});
