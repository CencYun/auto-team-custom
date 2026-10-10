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
const dataKey = 'isolated-child-delete-key';
const email = 'removed-child@example.test';
const owner = { id: 'owner-user', email: 'owner@example.test', role: 'account-owner', seat_type: 'default' };

function token(accountId, identity = 'owner-user', tokenEmail = owner.email) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600, sub: identity,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'team', chatgpt_user_id: identity },
    'https://api.openai.com/profile': { email: tokenEmail },
  })).toString('base64url');
  return `${header}.${payload}.private-fixture-signature`;
}

function child(fields = {}) {
  return { id: 'child-delete', email, status: 'ready', plan: 'free', workspaceHistory: [], ...fields };
}

function mother(workspaceId = 'delete-team', fields = {}) {
  return { id: `mother-${workspaceId}`, team: workspaceId, accountId: workspaceId, email: owner.email,
    primaryOwnerEmail: owner.email, rotationMode: 'fixed', rotationEnabled: false,
    accessToken: token(workspaceId), members: [owner], ...fields };
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

async function fixture(t, { children = [child()], mothers = [mother()], remote = {}, holdRefresh = false, callback = false, onMembers, concurrency = 1 } = {}) {
  const requests = [];
  let releaseRefresh;
  let refreshStarted;
  const refreshObserved = new Promise((resolve) => { refreshStarted = resolve; });
  const refreshGate = holdRefresh ? new Promise((resolve) => { releaseRefresh = resolve; }) : Promise.resolve();
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, offset: Number(url.searchParams.get('offset') || 0), query: url.searchParams.get('query') });
    const json = (payload, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (url.pathname === '/mock-token') {
      refreshStarted();
      await refreshGate;
      return json({ access_token: token('personal-child-delete', 'child-user', email), refresh_token: 'private-fixture-new-refresh-token' });
    }
    if (req.method !== 'GET') return json({ error: 'unexpected_fixture_mutation' }, 503);
    const match = url.pathname.match(/^\/backend-api\/accounts\/([^/]+)\/(users|invites)$/);
    if (match) {
      let entry = remote[match[1]] || {};
      if (entry.byIdentity) {
        const payload = String(req.headers.authorization || '').split('.')[1];
        const identity = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sub;
        entry = { ...entry, ...(entry.byIdentity[identity] || {}) };
      }
      if (match[2] === 'users') {
        await onMembers?.(match[1]);
        const offset = Number(url.searchParams.get('offset') || 0);
        const pageStatus = entry.pageStatuses?.[offset];
        if (pageStatus && pageStatus !== 200) return json({ error: 'private-upstream-page-error-token' }, pageStatus);
        if (entry.status && entry.status !== 200) return json({ error: 'private-upstream-error-token' }, entry.status);
        if (entry.payload !== undefined) return json(entry.payload);
        const members = entry.members || [owner];
        return json(entry.pages?.[offset] ?? { items: members.slice(offset, offset + 100), total: members.length, offset, limit: 100 });
      }
      if (entry.inviteStatus && entry.inviteStatus !== 200) return json({ error: 'private-invite-error-token' }, entry.inviteStatus);
      if (entry.invitePayload !== undefined) return json(entry.invitePayload);
      const invitations = (entry.invites || []).filter((invite) => !url.searchParams.get('query')
        || String(invite.email_address || invite.email).toLowerCase() === url.searchParams.get('query'));
      return json({ items: invitations, total: invitations.length, offset: 0, limit: 100 });
    }
    if (url.pathname === '/backend-api/subscriptions') return json({ seats_in_use: 1, seats_entitled: 2,
      seat_capacity: [{ type: 'default', paid: 2, held: 0 }], assigned: { default: 1 } });
    return json({ error: 'unexpected_fixture_read' }, 503);
  });
  const upstreamPort = await listen(upstream);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'child-delete-integration-'));
  const port = await unusedPort();
  const callbackPort = await unusedPort();
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 1, settings: { autoRefill: false, concurrency }, mothers, children, history: [] }));
  const preload = `
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.hostname === 'auth.openai.com' && url.pathname.endsWith('/token')) return nativeFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/mock-token`)}, options);
      if (url.hostname !== '127.0.0.1') throw new Error('isolated_external_network_disabled');
      return nativeFetch(input, options);
    };
  `;
  const app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      TEAM_ROTATION_DATA_DIR: dataDir, TEAM_ROTATION_DATA_KEY: dataKey, TEAM_ROTATION_API_TOKEN: '', TEAM_ROTATION_LOGIN_PASSWORD: 'isolated-delete-password',
      DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: String(callback), OPENAI_CALLBACK_PORT: String(callbackPort), OPENAI_REQUEST_TIMEOUT_MS: '10000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk; });
  app.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    releaseRefresh?.();
    if (app.exitCode === null && app.signalCode === null) { const exited = new Promise((resolve) => app.once('exit', resolve)); app.kill(); await exited; }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`fixture server exited: ${output}`);
    try { if ((await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Listener starting. */ }
    await delay(25);
  }
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'isolated-delete-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  return {
    requests, remote, refreshObserved, releaseRefresh: () => releaseRefresh?.(),
    async request(route, { method = 'GET', body } = {}) {
      const response = await fetch(`${baseUrl}${route}`, { method, headers: { cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, data: await response.json() };
    },
    async saved() {
      const saved = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
      if (!saved.encrypted) return saved;
      const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(dataKey).digest(), Buffer.from(saved.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'base64')), decipher.final()]).toString());
    },
    async callback(state) {
      return fetch(`http://127.0.0.1:${callbackPort}/auth/callback?code=private-fixture-code&state=${state}`);
    },
  };
}

function assertReadOnly(requests) { assert.ok(requests.every((request) => request.method === 'GET'), JSON.stringify(requests)); }

function confirmedDeparture(fields = {}) {
  return { team: 'delete-team', status: 'kicked', reason: 'manual', source: 'member_sync',
    joinedAt: '2025-01-01T00:00:00.000Z', removedAt: '2025-01-01T01:00:00.000Z', ...fields };
}

for (const mode of ['single', 'bulk']) {
  test(`${mode} local deletion accepts a confirmed legacy departure when the Team API returns 403 and retains its pending invitation`, async (t) => {
    const invite = { id: 'pending-invite', email_address: email, role: 'standard-user' };
    const app = await fixture(t, {
      children: [child({ status: 'login_pending', team: null, chatgptUserId: 'removed-child-user',
        workspaceHistory: [confirmedDeparture()],
        memberSnapshot: { id: 'removed-child-user', email },
        teamInvitations: [{ workspaceId: 'delete-team', status: 'invited' }] })],
      mothers: [mother('delete-team', { seatClaims: [{ id: 'local-claim', childId: 'child-delete', email,
        workspaceId: 'delete-team', inviteId: invite.id, seatType: 'default', phase: 'invited' }] })],
      remote: { 'delete-team': { status: 403, invites: [invite] } },
    });
    const result = mode === 'single' ? await app.request('/api/children/child-delete', { method: 'DELETE' })
      : await app.request('/api/children/batch-delete', { method: 'POST', body: { ids: ['child-delete'], bannedOnly: false } });
    assert.equal(result.status, 200);
    if (mode === 'bulk') {
      assert.deepEqual(result.data.deleted.map((entry) => entry.id), ['child-delete']);
      assert.deepEqual(result.data.skipped, []);
    }
    const saved = await app.saved();
    assert.equal(saved.children.length, 0);
    const claim = saved.mothers[0].seatClaims[0];
    assert.equal(claim.childId, null);
    assert.equal(claim.phase, 'detached_invitation');
    assert.equal(claim.email, email);
    assert.equal(claim.inviteId, invite.id);
    assert.equal(claim.seatType, 'default');
    assert.deepEqual(app.remote['delete-team'].invites, [invite]);
    assert.equal(app.requests.length, 1);
    assertReadOnly(app.requests);
  });
}

for (const [label, departure] of [
  ['missing removal time', confirmedDeparture({ removedAt: null })],
  ['invalid removal time', confirmedDeparture({ removedAt: 'invalid-date' })],
  ['future removal time', confirmedDeparture({ removedAt: '2999-01-01T01:00:00.000Z' })],
  ['removal predating the join', confirmedDeparture({ joinedAt: '2025-01-01T02:00:00.000Z' })],
  ['missing removal reason', confirmedDeparture({ reason: null })],
  ['a locally deleted Team', confirmedDeparture({ status: 'team_removed', reason: 'team_deleted_local' })],
]) {
  test(`a Team API 403 does not authorize local deletion with ${label}`, async (t) => {
    const app = await fixture(t, { children: [child({ team: null, workspaceHistory: [departure] })],
      remote: { 'delete-team': { status: 403 } } });
    const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
    assert.equal(result.status, 409);
    assert.equal(result.data.message, 'membership_verification_failed');
    assert.equal((await app.saved()).children.length, 1);
    assertReadOnly(app.requests);
  });
}

for (const [label, fields] of [
  ['a later active membership', { team: null, workspaceHistory: [confirmedDeparture(),
    { team: 'delete-team', status: 'active', joinedAt: '2025-01-01T02:00:00.000Z' }] }],
  ['a current Team link', { team: 'delete-team', workspaceHistory: [confirmedDeparture()] }],
]) {
  test(`a past departure cannot authorize deletion during a Team API 403 when the account has ${label}`, async (t) => {
    const app = await fixture(t, { children: [child(fields)], remote: { 'delete-team': { status: 403 } } });
    const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
    assert.equal(result.status, 409);
    assert.equal(result.data.message, 'membership_verification_failed');
    assert.equal((await app.saved()).children.length, 1);
    assertReadOnly(app.requests);
  });
}

test('a conflicting cached member keeps a departed account during a Team API 403 even after a failed sync', async (t) => {
  const app = await fixture(t, { children: [child({ team: null, workspaceHistory: [confirmedDeparture()] })],
    mothers: [mother('delete-team', { members: [owner, { id: 'cached-child', email }],
      lastMembersProbe: { ok: false, status: 403 }, lastWorkspaceSyncAt: '2025-01-01T02:00:00.000Z' })],
    remote: { 'delete-team': { status: 403 } } });
  const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(result.status, 409);
  assert.equal(result.data.message, 'membership_verification_failed');
  assert.equal((await app.saved()).children.length, 1);
  assertReadOnly(app.requests);
});

test('an official current member overrides an old confirmed departure', async (t) => {
  const app = await fixture(t, { children: [child({ team: null, workspaceHistory: [confirmedDeparture()] })],
    remote: { 'delete-team': { members: [owner, { id: 'rejoined-child', email }] } } });
  const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(result.status, 409);
  assert.equal(result.data.message, 'child_has_active_team_memberships');
  assert.equal((await app.saved()).children.length, 1);
  assertReadOnly(app.requests);
});

test('a confirmed departure in one Team cannot authorize deletion when another Team returns 403 without departure evidence', async (t) => {
  const app = await fixture(t, { children: [child({ team: null, workspaceHistory: [confirmedDeparture()] })],
    mothers: [mother('delete-team'), mother('other-team')],
    remote: { 'delete-team': { status: 403 }, 'other-team': { status: 403 } } });
  const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(result.status, 409);
  assert.equal(result.data.message, 'membership_verification_failed');
  assert.deepEqual(result.data.verificationTeams.map((entry) => entry.workspaceId), ['other-team']);
  assert.equal((await app.saved()).children.length, 1);
  assert.equal(app.requests.length, 2);
  assertReadOnly(app.requests);
});

test('a confirmed departure cannot excuse an incomplete or explicitly failed official list inside HTTP 200', async (t) => {
  const app = await fixture(t, { children: [child({ team: null, workspaceHistory: [confirmedDeparture()] })],
    remote: { 'delete-team': {} } });
  for (const payload of [{}, { items: [], total: 2 }, { success: false, items: [], total: 0 }]) {
    app.remote['delete-team'].payload = payload;
    const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
    assert.equal(result.status, 409, JSON.stringify(payload));
    assert.equal(result.data.message, 'membership_verification_failed');
    assert.equal((await app.saved()).children.length, 1);
  }
  assertReadOnly(app.requests);
});

test('a confirmed departure cannot excuse a 403 on a later member page after an actual member was returned', async (t) => {
  const first = [{ id: 'rejoined-child', email },
    ...Array.from({ length: 99 }, (_, index) => ({ id: `unrelated-${index}`, email: `unrelated-${index}@example.test` }))];
  const app = await fixture(t, { children: [child({ team: null, workspaceHistory: [confirmedDeparture()] })],
    remote: { 'delete-team': { pages: { 0: { items: first, total: 101, offset: 0 } }, pageStatuses: { 100: 403 } } } });
  const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(result.status, 409);
  assert.equal(result.data.message, 'membership_verification_failed');
  assert.equal(result.data.verificationTeams[0].reason, 'members_list_incomplete');
  assert.equal((await app.saved()).children.length, 1);
  assert.deepEqual(app.requests.map((request) => request.offset), [0, 100]);
  assertReadOnly(app.requests);
});

test('another manager failing on its first page cannot erase an incomplete member list for the same Team', async (t) => {
  const first = [{ id: 'rejoined-child', email },
    ...Array.from({ length: 99 }, (_, index) => ({ id: `unrelated-${index}`, email: `unrelated-${index}@example.test` }))];
  const app = await fixture(t, { children: [child({ team: null, workspaceHistory: [confirmedDeparture()] })],
    mothers: [mother('delete-team', { id: 'mother-first', accessToken: token('delete-team', 'first-manager') }),
      mother('delete-team', { id: 'mother-second', accessToken: token('delete-team', 'second-manager') })],
    remote: { 'delete-team': { byIdentity: {
      'first-manager': { pages: { 0: { items: first, total: 101, offset: 0 } }, pageStatuses: { 100: 403 } },
      'second-manager': { status: 403 },
    } } } });
  const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(result.status, 409);
  assert.equal(result.data.message, 'membership_verification_failed');
  assert.equal(result.data.verificationTeams[0].workspaceId, 'delete-team');
  assert.equal(result.data.verificationTeams[0].reason, 'members_list_incomplete');
  assert.equal((await app.saved()).children.length, 1);
  assert.deepEqual(app.requests.map((request) => request.offset), [0, 100, 0]);
  assertReadOnly(app.requests);
});

test('a removed child with a pending invitation can be deleted locally while its external seat reservation stays counted', async (t) => {
  const invite = { id: 'pending-invite', email_address: email, role: 'standard-user' };
  const app = await fixture(t, {
    children: [child({ status: 'login_pending', team: null, joinStatus: 'member_confirmed',
      workspaceHistory: [{ team: 'delete-team', status: 'kicked', reason: 'manual', removedAt: new Date().toISOString() }],
      teamInvitations: [{ workspaceId: 'delete-team', status: 'invited' }] })],
    mothers: [mother('delete-team', { seatClaims: [{ id: 'local-claim', childId: 'child-delete', email, workspaceId: 'delete-team', inviteId: invite.id, seatType: 'default', phase: 'invited' }] })],
    remote: { 'delete-team': { invites: [invite] } },
  });
  const deleted = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  let saved = await app.saved();
  assert.equal(saved.children.length, 0);
  const claim = saved.mothers[0].seatClaims[0];
  assert.equal(claim.childId, null);
  assert.equal(claim.email, email);
  assert.equal(claim.inviteId, invite.id);
  assert.equal(claim.phase, 'detached_invitation');
  assert.deepEqual(app.remote['delete-team'].invites, [invite]);
  await app.request('/api/mothers/mother-delete-team/sync', { method: 'POST' });
  saved = await app.saved();
  assert.equal(saved.mothers[0].seatClaims.length, 1);
  app.remote['delete-team'].inviteStatus = 403;
  await app.request('/api/mothers/mother-delete-team/sync', { method: 'POST' });
  assert.equal((await app.saved()).mothers[0].seatClaims.length, 1, 'failed invitation verification cannot release capacity');
  app.remote['delete-team'].inviteStatus = 200;
  app.remote['delete-team'].invites = [];
  await app.request('/api/mothers/mother-delete-team/sync', { method: 'POST' });
  assert.equal((await app.saved()).mothers[0].seatClaims.length, 0, 'confirmed vanished invitation releases the detached reservation');
  assertReadOnly(app.requests);
});

test('an incomplete empty invitation page cannot release a detached reservation', async (t) => {
  const app = await fixture(t, { children: [],
    mothers: [mother('delete-team', { seatClaims: [{ id: 'detached-claim', email, workspaceId: 'delete-team', inviteId: 'pending-invite', phase: 'detached_invitation' }] })],
    remote: { 'delete-team': {} },
  });
  for (const payload of [{ items: [], total: 1 }, { items: [], total: -1 }, { items: [], total: 0.5 }, { items: [], total: 0, offset: 1 }]) {
    app.remote['delete-team'].invitePayload = payload;
    await app.request('/api/mothers/mother-delete-team/sync', { method: 'POST' });
    assert.equal((await app.saved()).mothers[0].seatClaims.length, 1, JSON.stringify(payload));
  }
  app.remote['delete-team'].invitePayload = { items: [], total: 0, offset: 0 };
  await app.request('/api/mothers/mother-delete-team/sync', { method: 'POST' });
  assert.equal((await app.saved()).mothers[0].seatClaims.length, 0);
  assertReadOnly(app.requests);
});

test('an explicit invitation API failure inside HTTP 200 keeps the detached reservation', async (t) => {
  const app = await fixture(t, { children: [],
    mothers: [mother('delete-team', { seatClaims: [{ id: 'detached-claim', email, workspaceId: 'delete-team', inviteId: 'pending-invite', phase: 'detached_invitation' }] })],
    remote: { 'delete-team': {} },
  });
  for (const payload of [{ success: false, items: [] }, { ok: false, items: [] },
    { error: 'private-upstream-error-token', items: [] }, { errors: ['private-upstream-error-token'], items: [] }]) {
    app.remote['delete-team'].invitePayload = payload;
    await app.request('/api/mothers/mother-delete-team/sync', { method: 'POST' });
    assert.equal((await app.saved()).mothers[0].seatClaims.length, 1, JSON.stringify(payload));
  }
  assertReadOnly(app.requests);
});

for (const mode of ['single', 'bulk']) {
  test(`${mode} deletion ignores stale active history and member snapshots after complete official absence`, async (t) => {
    const stale = child({ team: 'delete-team', status: 'active', memberSnapshot: { id: 'old-member', email },
      workspaceHistory: [{ team: 'delete-team', status: 'active', memberId: 'old-member', manualKickEnabled: true, manualKickAt: new Date().toISOString() }] });
    const app = await fixture(t, { children: [stale], mothers: [mother('delete-team', { members: [owner, stale.memberSnapshot] })] });
    const result = mode === 'single' ? await app.request('/api/children/child-delete', { method: 'DELETE' })
      : await app.request('/api/children/batch-delete', { method: 'POST', body: { ids: ['child-delete'], bannedOnly: false } });
    assert.equal(result.status, 200);
    assert.equal((await app.saved()).children.length, 0);
    if (mode === 'bulk') assert.deepEqual(result.data.deleted.map((entry) => entry.id), ['child-delete']);
    assertReadOnly(app.requests);
  });
}

test('a real active member in another current Team blocks single and bulk deletion even when no membership was stored locally', async (t) => {
  const app = await fixture(t, { mothers: [mother('team-a'), mother('team-b')],
    remote: { 'team-b': { members: [owner, { id: 'actual-member', email: email.toUpperCase(), role: 'standard-user' }] } } });
  const single = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(single.status, 409);
  assert.equal(single.data.message, 'child_has_active_team_memberships');
  const bulk = await app.request('/api/children/batch-delete', { method: 'POST', body: { ids: ['child-delete'], bannedOnly: false } });
  assert.equal(bulk.data.deleted.length, 0);
  assert.equal(bulk.data.skipped[0].reason, single.data.message);
  assert.equal((await app.saved()).children.length, 1);
  assert.ok(app.requests.some((request) => request.path.includes('/team-a/users')));
  assert.ok(app.requests.some((request) => request.path.includes('/team-b/users')));
  assertReadOnly(app.requests);
});

test('an active member without email still blocks deletion through its recorded exact user identity', async (t) => {
  const app = await fixture(t, { children: [child({ chatgptUserId: 'child-user' })],
    remote: { 'delete-team': { members: [owner, { id: 'child-user', role: 'standard-user' }] } } });
  const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(result.status, 409);
  assert.equal(result.data.message, 'child_has_active_team_memberships');
  assertReadOnly(app.requests);
});

for (const failure of [{ status: 403 }, { payload: {} }, { payload: { items: [], total: 2 } },
  { payload: { success: false, items: [], total: 0 } }, { payload: { ok: false, items: [] } },
  { payload: { error: 'private-upstream-error-token', items: [] } }, { payload: { errors: ['private-upstream-error-token'], items: [] } }]) {
  test(`unknown official membership (${JSON.stringify(failure)}) keeps the child, credentials, and reservations`, async (t) => {
    const record = child({ password: 'private-fixture-password', workspaceHistory: [{ team: 'delete-team', status: 'kicked' }] });
    const app = await fixture(t, { children: [record], mothers: [mother('delete-team', { seatClaims: [{ id: 'private-claim', childId: record.id, email, phase: 'invited' }] })],
      remote: { 'delete-team': failure } });
    const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
    assert.equal(result.status, 409);
    assert.equal(result.data.message, 'membership_verification_failed');
    const saved = await app.saved();
    assert.equal(saved.children[0].password, record.password);
    assert.equal(saved.mothers[0].seatClaims[0].childId, record.id);
    assert.doesNotMatch(JSON.stringify(result.data), /private-fixture-password|private-upstream-error-token|accessToken|refreshToken/);
    assertReadOnly(app.requests);
  });
}

test('complete member pagination sees an active member after the first hundred records', async (t) => {
  const first = Array.from({ length: 100 }, (_, index) => ({ id: `unrelated-${index}`, email: `unrelated-${index}@example.test` }));
  const app = await fixture(t, { remote: { 'delete-team': { pages: { 0: { items: first, total: 101 }, 100: { items: [{ id: 'late-member', email }], total: 101 } } } } });
  const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(result.status, 409);
  assert.equal(result.data.message, 'child_has_active_team_memberships');
  assert.deepEqual(app.requests.map((request) => request.offset), [0, 100]);
  assertReadOnly(app.requests);
});

test('bulk deletion shares official reads while retaining active and unverifiable records', async (t) => {
  const app = await fixture(t, { children: [child({ id: 'stale-a', email: 'stale-a@example.test', team: 'delete-team' }),
    child({ id: 'stale-b', email: 'stale-b@example.test', workspaceHistory: [{ team: 'delete-team', status: 'active' }] }),
    child({ id: 'active', email: 'active@example.test' }),
    child({ id: 'unknown', workspaceHistory: [{ workspaceId: 'unconfigured-team', status: 'active' }] })],
    remote: { 'delete-team': { members: [owner, { id: 'active', email: 'active@example.test' }] } } });
  const result = await app.request('/api/children/batch-delete', { method: 'POST', body: { ids: ['stale-a', 'stale-b', 'active', 'unknown'], bannedOnly: false } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.deleted.map((entry) => entry.id), ['stale-a', 'stale-b']);
  assert.deepEqual(result.data.skipped.map((entry) => entry.reason), ['child_has_active_team_memberships', 'membership_verification_failed']);
  assert.equal(app.requests.length, 1, 'bulk uses one complete current list per Team');
  assert.deepEqual((await app.saved()).children.map((entry) => entry.id), ['active', 'unknown']);
  assertReadOnly(app.requests);
});

test('active history whose Team is not configured remains unverifiable rather than presumed removed', async (t) => {
  const app = await fixture(t, { mothers: [], children: [child({ team: 'external-team', workspaceHistory: [{ team: 'external-team', status: 'active' }] })] });
  const result = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(result.status, 409);
  assert.equal(result.data.message, 'membership_verification_failed');
  assert.equal(result.data.verificationTeams[0].reason, 'workspace_not_configured');
  assert.equal(app.requests.length, 0);
});

test('a departed account with no current Teams can be deleted and its saved OAuth callback cannot revive it', async (t) => {
  const state = 'fixture-deleted-state';
  const app = await fixture(t, { mothers: [], callback: true, children: [child({
    workspaceHistory: [{ team: 'old-team', status: 'kicked' }],
    authSession: { state, codeVerifier: 'private-fixture-verifier' },
  })] });
  assert.equal((await app.callback(state)).status, 200);
  assert.equal((await app.request('/api/children/child-delete', { method: 'DELETE' })).status, 200);
  assert.equal((await app.callback(state)).status, 400);
  assert.equal((await app.saved()).children.length, 0);
  assert.equal(app.requests.length, 0);
});

test('an ongoing refresh and its completed Free authorization both protect an account without departure history', async (t) => {
  const app = await fixture(t, { mothers: [], holdRefresh: true, children: [child({ refreshToken: 'private-fixture-old-refresh-token' })] });
  const started = await app.request('/api/children/auto-json', { method: 'POST', body: { scope: 'free', ids: ['child-delete'] } });
  assert.equal(started.status, 202);
  await app.refreshObserved;
  const single = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(single.status, 409);
  assert.equal(single.data.message, 'account_operation_in_progress');
  const bulk = await app.request('/api/children/batch-delete', { method: 'POST', body: { ids: ['child-delete'], bannedOnly: false } });
  assert.equal(bulk.data.deleted.length, 0);
  assert.equal(bulk.data.skipped[0].reason, 'account_operation_in_progress');
  app.releaseRefresh();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const polled = await app.request(`/api/children/auto-json/${started.data.job.id}`);
    if (polled.data.job.status === 'complete') break;
    await delay(20);
  }
  assert.equal((await app.saved()).children.length, 1);
  const deleted = await app.request('/api/children/child-delete', { method: 'DELETE' });
  assert.equal(deleted.status, 409);
  assert.equal(deleted.data.message, 'authorized_free_account');
  assert.equal((await app.saved()).children.length, 1);
});

test('local deletion metadata is safe and classifies historical authorization independently of token validity', async (t) => {
  const fixtures = [
    ['fresh', { password: 'private-password', totp: 'private-totp' }, true, 'never_authorized'],
    ['pending', { authSession: { state: 'pending-state', codeVerifier: 'private-verifier' }, loginBrowserRequired: true }, true, 'never_authorized'],
    ['access', { accessToken: 'private-expired-access', expiresAt: '2001-01-01T00:00:00Z' }, false, 'authorized_free_account'],
    ['refresh', { refreshToken: 'private-expired-refresh' }, false, 'authorized_free_account'],
    ['id-token', { idToken: 'private-old-id-token' }, false, 'authorized_free_account'],
    ['legacy', { token: 'private...token' }, false, 'authorized_free_account'],
    ['nested', { credentials: { access_token: 'private-nested-access' } }, false, 'authorized_free_account'],
    ['workspace', { workspaceTokens: { 'old-team': { accessToken: 'private-old-team-token', expiresAt: '2001-01-01T00:00:00Z' } } }, false, 'authorized_free_account'],
    ['authorized-at', { authAt: '2001-01-01T00:00:00Z' }, false, 'authorized_free_account'],
    ['sub2api', { sub2apiImported: true }, false, 'authorized_free_account'],
    ['nested-sub2api', { sub2api: { imported: true } }, false, 'authorized_free_account'],
    ['departed', { accessToken: 'private-historical-access', workspaceHistory: [confirmedDeparture()] }, true, 'departed_account'],
    ['banned', { status: 'banned', accessToken: 'private-banned-access' }, true, 'banned_account'],
    ['banned-current', { status: 'banned', team: 'delete-team' }, false, 'child_has_active_team_memberships'],
    ['history-member', { status: 'banned', workspaceHistory: [{ team: 'delete-team', status: 'active' }] }, false, 'child_has_active_team_memberships'],
    ['cached-member', { status: 'banned' }, false, 'child_has_active_team_memberships'],
  ];
  const children = fixtures.map(([id, fields]) => child({ id, email: `${id}@example.test`, ...fields }));
  const app = await fixture(t, { children, mothers: [mother('delete-team', { members: [owner, { id: 'cached-user', email: 'cached-member@example.test' }] })] });
  const state = (await app.request('/api/state')).data;
  for (const [id, , eligible, reason] of fixtures) {
    const actual = state.children.find((record) => record.id === id).localDeletion;
    assert.equal(actual.eligible, eligible, id);
    assert.equal(actual.reason, reason, id);
    assert.deepEqual(Object.keys(actual).sort(), ['eligible', 'message', 'reason']);
    assert.equal(typeof actual.message, 'string');
    assert.doesNotMatch(JSON.stringify(actual), /private-|token|secret/i);
  }
  assert.equal(app.requests.length, 0, 'metadata must never query upstream');
});

test('explicit general batch deletion removes only unacquired, banned and departed accounts and retains actual members', async (t) => {
  const children = [
    child({ id: 'fresh', email: 'fresh@example.test', password: 'private-unacquired-password' }),
    child({ id: 'banned', email: 'banned@example.test', status: 'banned', accessToken: 'private-banned-token' }),
    child({ id: 'departed', email: 'departed@example.test', refreshToken: 'private-historical-rt', workspaceHistory: [confirmedDeparture()] }),
    child({ id: 'authorized-free', email: 'authorized-free@example.test', accessToken: 'private-free-token', expiresAt: '2000-01-01T00:00:00Z' }),
    child({ id: 'current-banned', email: 'current-banned@example.test', status: 'banned', team: 'delete-team' }),
    child({ id: 'remote-current', email: 'remote-current@example.test', status: 'banned', workspaceHistory: [confirmedDeparture()] }),
  ];
  const app = await fixture(t, { children, remote: { 'delete-team': { members: [owner,
    { id: 'actual-current-banned', email: 'current-banned@example.test' }, { id: 'actual-remote-current', email: 'remote-current@example.test' },
  ] } } });
  const single = await app.request('/api/children/authorized-free', { method: 'DELETE' });
  assert.equal(single.status, 409);
  assert.equal(single.data.message, 'authorized_free_account');
  assert.equal(app.requests.length, 0, 'ineligible standalone Free authorization needs no membership requests');
  const result = await app.request('/api/children/batch-delete', { method: 'POST', body: { ids: children.map((record) => record.id), bannedOnly: false } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.deleted.map((record) => record.id), ['fresh', 'banned', 'departed']);
  assert.deepEqual(result.data.skipped.map((record) => [record.id, record.reason]), [
    ['authorized-free', 'authorized_free_account'], ['current-banned', 'child_has_active_team_memberships'], ['remote-current', 'child_has_active_team_memberships'],
  ]);
  const saved = await app.saved();
  assert.deepEqual(saved.children.map((record) => record.id), ['authorized-free', 'current-banned', 'remote-current']);
  assert.equal(saved.children[0].accessToken, 'private-free-token');
  assert.equal(app.requests.length, 1);
  assertReadOnly(app.requests);
});

for (const bannedOnly of [true, undefined]) test(`legacy banned-only batch selection (${String(bannedOnly)}) never expands to other candidates`, async (t) => {
  const records = [child({ id: 'fresh', email: 'fresh@example.test' }),
    child({ id: 'banned', email: 'banned@example.test', banStatus: 'banned' }),
    child({ id: 'departed', email: 'departed@example.test', workspaceHistory: [confirmedDeparture()] })];
  const app = await fixture(t, { mothers: [], children: records });
  const result = await app.request('/api/children/batch-delete', { method: 'POST', body: { ids: records.map((record) => record.id), ...(bannedOnly === undefined ? {} : { bannedOnly }) } });
  assert.deepEqual(result.data.deleted.map((record) => record.id), ['banned']);
  assert.deepEqual(result.data.skipped.map((record) => record.reason), ['child_not_banned', 'child_not_banned']);
  assert.deepEqual((await app.saved()).children.map((record) => record.id), ['fresh', 'departed']);
});

for (const mode of ['single', 'bulk']) test(`${mode} deletion preserves a newly refreshed token even after the authorization queue completes`, async (t) => {
  let lookupEntered; let releaseLookup;
  const entered = new Promise((resolve) => { lookupEntered = resolve; });
  const gate = new Promise((resolve) => { releaseLookup = resolve; });
  t.after(() => releaseLookup());
  const app = await fixture(t, { concurrency: 2, children: [child({ refreshToken: 'private-old-rt', workspaceHistory: [confirmedDeparture()] })],
    onMembers: async () => { lookupEntered(); await gate; } });
  const deleting = mode === 'single' ? app.request('/api/children/child-delete', { method: 'DELETE' })
    : app.request('/api/children/batch-delete', { method: 'POST', body: { ids: ['child-delete'], bannedOnly: false } });
  await entered;
  const started = await app.request('/api/children/auto-json', { method: 'POST', body: { scope: 'free', ids: ['child-delete'] } });
  assert.equal(started.status, 202);
  let complete = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const polled = await app.request(`/api/children/auto-json/${started.data.job.id}`);
    if (polled.data.job.status === 'complete') { complete = true; break; }
    await delay(20);
  }
  assert.equal(complete, true);
  releaseLookup();
  const result = await deleting;
  if (mode === 'single') {
    assert.equal(result.status, 409);
    assert.equal(result.data.message, 'account_changed_during_deletion');
  } else {
    assert.deepEqual(result.data.deleted, []);
    assert.equal(result.data.skipped[0].reason, 'account_changed_during_deletion');
  }
  const saved = await app.saved();
  assert.equal(saved.children.length, 1);
  assert.equal(saved.children[0].refreshToken, 'private-fixture-new-refresh-token');
});
