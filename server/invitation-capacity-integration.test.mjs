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
import { teamInviteCandidateState } from '../shared/team-workflow-ui.mjs';

const serverScript = fileURLToPath(new URL('./index.mjs', import.meta.url));
const workspaceId = 'capacity-team';
const motherId = 'mother-capacity-team';
const removedEmail = 'removed-child@example.test';
const newEmail = 'new-child@example.test';
const owner = { id: 'owner-user', email: 'owner@example.test', role: 'account-owner', seat_type: 'default' };
const subscription = { seats_in_use: 1, seats_entitled: 2,
  seat_capacity: [{ type: 'default', paid: 2, held: 0 }], assigned: { default: 1 } };

function token(accountId, marker = 'private-capacity-fixture-token') {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'team' },
    'https://api.openai.com/profile': { email: owner.email } })).toString('base64url');
  return `${header}.${payload}.${marker}`;
}

function claim(fields = {}) {
  return { id: 'old-claim', workspaceId, childId: null, email: removedEmail,
    inviteId: 'old-invite', seatType: 'default', phase: 'detached_invitation', ...fields };
}

function mother(fields = {}) {
  return { id: motherId, team: workspaceId, accountId: workspaceId, email: owner.email,
    accessToken: token(workspaceId), rotationEnabled: false, defaultSeatType: 'default',
    members: [owner], seats: 2, used: 2,
    subscription: { seatsInUse: 1, seatsEntitled: 2, seatCapacity: subscription.seat_capacity, assigned: subscription.assigned },
    seatClaims: [claim()], ...fields };
}

function child(fields = {}) {
  return { id: 'child-old', email: removedEmail, status: 'ready', workspaceHistory: [],
    teamInvitations: [{ motherId, workspaceId, inviteId: 'old-invite', email: removedEmail, status: 'invited' }],
    pendingWorkspaceId: workspaceId, pendingInviteId: 'old-invite', ...fields };
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

async function fixture(t, { mothers = [mother()], children = [], remote = {}, recoverInvalidToken = false } = {}) {
  const requests = [];
  const unexpected = [];
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')
      ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text) : null;
    const entry = { method: req.method, path: url.pathname, query: url.searchParams.get('query'), body };
    requests.push(entry);
    const json = (payload, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.method === 'POST' && url.pathname === '/mock-token') {
      assert.equal(body.grant_type, 'refresh_token');
      return json({ access_token: token(workspaceId, 'private-refreshed-fixture-token'), refresh_token: 'private-refreshed-fixture-rt' });
    }
    const match = url.pathname.match(/^\/backend-api\/accounts\/([^/]+)\/(users|invites)$/);
    const configuration = remote[match?.[1] || url.searchParams.get('account_id')] || {};
    if (req.method === 'GET' && match?.[2] === 'users') {
      if (recoverInvalidToken && req.headers.authorization !== `Bearer ${token(workspaceId, 'private-refreshed-fixture-token')}`) {
        return json({ error: { code: 'invalid_token', message: 'private_fixture_token_invalid' } }, 403);
      }
      if (configuration.membersStatus) return json({ error: 'private-members-error' }, configuration.membersStatus);
      if (configuration.membersPayload !== undefined) return json(configuration.membersPayload);
      const offset = Number(url.searchParams.get('offset') || 0);
      const items = configuration.members || [owner];
      return json(configuration.memberPages?.[offset] || { items: items.slice(offset, offset + 100), total: items.length, offset, limit: 100 });
    }
    if (req.method === 'GET' && url.pathname === '/backend-api/subscriptions') {
      if (configuration.subscriptionStatus) return json({ error: 'private-subscription-error' }, configuration.subscriptionStatus);
      return json(configuration.subscriptionPayload ?? subscription);
    }
    if (req.method === 'GET' && match?.[2] === 'invites') {
      if (configuration.invitationStatus) return json({ error: 'private-invitation-error' }, configuration.invitationStatus);
      if (configuration.invitationPayload !== undefined) return json(configuration.invitationPayload);
      const offset = Number(url.searchParams.get('offset') || 0);
      const invites = (configuration.invites || []).filter((invite) => !entry.query
        || String(invite.email_address || invite.email).toLowerCase() === entry.query);
      return json({ items: invites.slice(offset, offset + 100), total: invites.length, offset, limit: 100 });
    }
    if (req.method === 'POST' && match?.[2] === 'invites') {
      const invite = { id: `new-invite-${requests.length}`, email_address: body.email_addresses[0] };
      if (!Array.isArray(configuration.invites)) configuration.invites = [];
      configuration.invites.push(invite);
      return json({ account_invites: [invite] });
    }
    if (req.method === 'DELETE' && match?.[2] === 'invites') {
      assert.match(String(req.headers['content-type'] || ''), /^application\/json(?:;|$)/);
      if (configuration.cancelStatus) return json({ error: 'private-cancel-error' }, configuration.cancelStatus);
      if (configuration.cancelPayload !== undefined) return json(configuration.cancelPayload);
      if (!configuration.cancelKeepInvite) configuration.invites = (configuration.invites || [])
        .filter((invite) => String(invite.email_address || invite.email).toLowerCase() !== body?.email_address);
      if (configuration.afterCancel) Object.assign(configuration, configuration.afterCancel);
      return json({ success: true });
    }
    unexpected.push(entry);
    return json({ error: 'unexpected_fixture_request' }, 503);
  });
  const upstreamPort = await listen(upstream);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'invitation-capacity-integration-'));
  const port = await unusedPort();
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 1,
    settings: { autoRefill: false, concurrency: 1 }, mothers, children, history: [] }));
  const preload = `const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.hostname === 'auth.openai.com' && url.pathname.endsWith('/token')) return originalFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/mock-token`)}, options);
      if (url.hostname !== '127.0.0.1') throw new Error('isolated_external_network_disabled');
      return originalFetch(input, options);
    };`;
  const app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      TEAM_ROTATION_DATA_DIR: dataDir, TEAM_ROTATION_DATA_KEY: 'isolated-capacity-key', TEAM_ROTATION_API_TOKEN: '',
      TEAM_ROTATION_LOGIN_PASSWORD: 'isolated-capacity-password', DISABLE_MAINTENANCE: 'true',
      OPENAI_CALLBACK_ENABLED: 'false', OPENAI_REQUEST_TIMEOUT_MS: '2000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk; });
  app.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once('exit', resolve)); app.kill(); await exited;
    }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(dataDir), path.resolve(tmpdir()));
    assert.match(path.basename(dataDir), /^invitation-capacity-integration-/);
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`fixture exited: ${output}`);
    try { if ((await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Starting. */ }
    await delay(25);
  }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'isolated-capacity-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  return { remote, requests, unexpected,
    async saved() {
      const saved = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
      if (!saved.encrypted) return saved;
      const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update('isolated-capacity-key').digest(), Buffer.from(saved.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'base64')), decipher.final()]).toString());
    },
    async request(route = `/api/mothers/${motherId}/invitation-capacity`, { method = 'GET', body } = {}) {
      const response = await fetch(`${base}${route}`, { method, headers: { cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, data: await response.json() };
    },
  };
}

function assertReadOnly(app) {
  assert.deepEqual(app.unexpected, []);
  assert.ok(app.requests.every((entry) => entry.method === 'GET'));
}

test('capacity refresh releases a vanished detached invitation and recalculates two purchased seats without mutating upstream', async (t) => {
  const app = await fixture(t);
  const { status, data } = await app.request();
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.fresh, true);
  assert.equal(data.released, 1);
  assert.deepEqual(data.reservations, []);
  assert.equal(data.state.mothers[0].seatClaimsCount, 0);
  assert.equal(data.state.mothers[0].seatsInUse, 1);
  assert.equal(data.state.mothers[0].used, 1);
  assert.equal(data.state.mothers[0].seatsOpen, 1);
  const readback = await app.request('/api/state');
  assert.equal(readback.data.mothers[0].seatsOpen, 1);
  assertReadOnly(app);
});

test('confirmed absent bound invitations expire and become selectable while another workspace pending link stays intact', async (t) => {
  const oldChild = child({ pendingWorkspaceId: 'other-team', pendingInviteId: 'other-invite',
    teamInvitations: [...child().teamInvitations, { motherId: 'mother-other-team', workspaceId: 'other-team', inviteId: 'other-invite', email: removedEmail, status: 'invited' }] });
  const app = await fixture(t, { mothers: [mother({ seatClaims: [claim({ childId: oldChild.id, phase: 'invited' })] })], children: [oldChild] });
  const { data } = await app.request();
  const account = data.state.children[0];
  const savedChild = (await app.saved()).children[0];
  assert.equal(data.released, 1);
  assert.equal(savedChild.teamInvitations.find((entry) => entry.workspaceId === workspaceId).status, 'expired');
  assert.equal(savedChild.teamInvitations.find((entry) => entry.workspaceId === 'other-team').status, 'invited');
  assert.equal(account.pendingWorkspaceId, 'other-team');
  assert.equal(savedChild.pendingInviteId, 'other-invite');
  assert.equal(account.teamInvitations.some((entry) => entry.workspaceId === workspaceId), false);
  assert.equal(Object.hasOwn(account, 'pendingInviteId'), false);
  assert.equal(teamInviteCandidateState(account, data.state.mothers[0]).selectable, true);
  assertReadOnly(app);
});

test('confirmed absent invitation clears only its exact pending workspace and invitation link', async (t) => {
  const oldChild = child();
  const app = await fixture(t, { mothers: [mother({ seatClaims: [claim({ childId: oldChild.id, phase: 'invited' })] })], children: [oldChild] });
  const { data } = await app.request();
  assert.equal(data.state.children[0].pendingWorkspaceId, null);
  assert.equal((await app.saved()).children[0].pendingInviteId, null);
  assertReadOnly(app);
});

test('real pending invitation remains reserved and reports its email without disclosing invitation identifiers', async (t) => {
  const invite = { id: 'private-upstream-invite-id', email_address: removedEmail };
  const app = await fixture(t, { remote: { [workspaceId]: { invites: [invite] } } });
  const { data } = await app.request();
  assert.equal(data.fresh, true);
  assert.equal(data.released, 0);
  assert.equal(data.reservations[0].email, removedEmail);
  assert.equal(data.reservations[0].status, 'invited');
  assert.equal(data.state.mothers[0].seatsOpen, 0);
  assert.doesNotMatch(JSON.stringify(data), /private-upstream-invite-id|private-capacity-fixture-token/);
  assert.deepEqual(app.remote[workspaceId].invites, [invite]);
  assertReadOnly(app);
});

test('403 checks retain the departed account invitation instead of manufacturing available capacity or starting login', async (t) => {
  const app = await fixture(t, { remote: { [workspaceId]: { membersStatus: 403, invitationStatus: 403, subscriptionStatus: 403 } } });
  const { data } = await app.request();
  assert.equal(data.fresh, false);
  assert.equal(data.ok, false);
  assert.equal(data.released, 0);
  for (const check of Object.values(data.checks)) { assert.equal(check.ok, false); assert.equal(check.status, 403); }
  assert.equal(data.reservations[0].status, 'unverified');
  assert.equal(data.state.mothers[0].seatsOpen, 0);
  assert.doesNotMatch(JSON.stringify(data), /private-members-error|private-subscription-error|private-invitation-error/);
  assertReadOnly(app);
});

test('an empty invitation result alone cannot release an invitation when the member list is unavailable', async (t) => {
  const app = await fixture(t, { remote: { [workspaceId]: { membersStatus: 403 } } });
  const { data } = await app.request();
  assert.equal(data.checks.invitations.ok, true);
  assert.equal(data.checks.members.ok, false);
  assert.equal(data.fresh, false);
  assert.equal(data.released, 0);
  assert.equal(data.reservations[0].status, 'unverified');
  assert.equal(data.state.mothers[0].seatsOpen, 0);
  assertReadOnly(app);
});

test('an accepted member consumes visible capacity when the subscription still reports one member', async (t) => {
  const app = await fixture(t, { remote: { [workspaceId]: { members: [owner,
    { id: 'accepted-user', email: removedEmail, role: 'standard-user', seat_type: 'default' }] } } });
  const { data } = await app.request();
  assert.equal(data.fresh, true);
  assert.deepEqual(data.reservations, []);
  assert.equal(data.state.mothers[0].seatsInUse, 2);
  assert.equal(data.state.mothers[0].used, 2);
  assert.equal(data.state.mothers[0].seatsOpen, 0);
  assertReadOnly(app);
});

test('a current member verified email prevents its accepted invitation being mistaken for a vanished reservation', async (t) => {
  const app = await fixture(t, { remote: { [workspaceId]: { members: [owner,
    { id: 'accepted-user', verified_email: removedEmail, role: 'standard-user', seat_type: 'default' }] } } });
  const { data } = await app.request();
  assert.equal(data.fresh, true);
  assert.deepEqual(data.reservations, []);
  assert.equal(data.released, 0);
  assert.equal(data.state.mothers[0].seatsInUse, 2);
  assert.equal(data.state.mothers[0].seatsOpen, 0);
  assertReadOnly(app);
});

for (const phase of ['approval_unknown', 'accepted_pending_sync', 'approval_pending']) {
  test(`absence does not release the uncertain ${phase} seat operation`, async (t) => {
    const app = await fixture(t, { mothers: [mother({ seatClaims: [claim({ phase })] })] });
    const { data } = await app.request();
    assert.equal(data.released, 0);
    assert.equal(data.reservations[0].status, 'approval_pending');
    assert.equal(data.state.mothers[0].seatsOpen, 0);
    assert.equal(app.requests.some((entry) => entry.path.endsWith('/invites')), false);
    assertReadOnly(app);
  });
}

test('incomplete and explicitly failed invitation success payloads cannot release capacity', async (t) => {
  const remote = { [workspaceId]: {} };
  const app = await fixture(t, { remote });
  for (const payload of [{ items: [], total: 1 }, { items: [], total: -1 }, { items: [], total: 0, offset: 1 },
    { items: [], ok: false }, { items: [], success: false }, { items: [], error: 'private-invalid-response' },
    { items: [], errors: ['private-invalid-response'] }, { items: [{}] },
    { items: [{ id: 'private-upstream-invite-id', email_address: removedEmail }], total: 0 }]) {
    remote[workspaceId].invitationPayload = payload;
    const { data } = await app.request();
    assert.equal(data.fresh, false, JSON.stringify(payload));
    assert.equal(data.checks.invitations.ok, false, JSON.stringify(payload));
    assert.equal(data.released, 0);
    assert.equal(data.reservations.length, 1);
    assert.doesNotMatch(JSON.stringify(data), /private-invalid-response|private-upstream-invite-id/);
  }
  assertReadOnly(app);
});

test('invalid subscription success payloads remain unverified even when ghost invitation cleanup succeeds', async (t) => {
  const remote = { [workspaceId]: {} };
  const app = await fixture(t, { remote });
  for (const payload of [{}, { ...subscription, success: false }, { ...subscription, error: 'private-invalid-response' },
    { ...subscription, seats_entitled: null }, { ...subscription, seat_capacity: [{ type: 'default', paid: 2, held: 'invalid' }] }]) {
    remote[workspaceId].subscriptionPayload = payload;
    const { data } = await app.request();
    assert.equal(data.fresh, false, JSON.stringify(payload));
    assert.equal(data.checks.subscription.ok, false);
    assert.equal(data.checks.subscription.code, 'invalid_seat_capacity');
    assert.doesNotMatch(JSON.stringify(data), /private-invalid-response/);
  }
  assertReadOnly(app);
});

test('failed member success payloads cannot prove absence for releasing an invitation', async (t) => {
  const remote = { [workspaceId]: {} };
  const app = await fixture(t, { remote });
  for (const payload of [{ items: [], total: 1 }, { items: [], success: false }, { items: [], error: 'private-invalid-response' }, {}]) {
    remote[workspaceId].membersPayload = payload;
    const { data } = await app.request();
    assert.equal(data.fresh, false);
    assert.equal(data.checks.members.ok, false);
    assert.equal(data.released, 0);
    assert.equal(data.reservations.length, 1);
  }
  assertReadOnly(app);
});

test('refreshing one Team never releases another workspace reservation even when stored in the same mother record', async (t) => {
  const app = await fixture(t, { mothers: [mother({ seatClaims: [claim(), claim({ id: 'other-claim', workspaceId: 'other-team' })] })] });
  const { data } = await app.request();
  assert.equal(data.released, 1);
  assert.equal(data.state.mothers[0].seatsOpen, 1);
  const otherMother = mother({ id: 'other-mother', team: 'other-team', accountId: 'other-team', accessToken: token('other-team'), seatClaims: [] });
  const app2 = await fixture(t, { mothers: [mother(), otherMother] });
  const other = await app2.request('/api/mothers/other-mother/invitation-capacity');
  assert.equal(other.data.released, 0);
  assert.equal(other.data.state.mothers.find((entry) => entry.id === motherId).seatClaimsCount, 1);
  assert.equal(app2.requests.some((entry) => entry.path.includes(`/accounts/${workspaceId}/`)), false);
  assertReadOnly(app);
  assertReadOnly(app2);
});

test('selected invitation action refreshes an unrelated stale reservation before admitting its new recipient', async (t) => {
  const remote = { [workspaceId]: {} };
  const app = await fixture(t, { remote, children: [{ id: 'new-child', email: newEmail, status: 'ready', workspaceHistory: [] }] });
  const { status, data } = await app.request(`/api/mothers/${motherId}/invitations`, { method: 'POST', body: { childIds: ['new-child'] } });
  assert.equal(status, 200);
  assert.equal(data.results[0].status, 'invited');
  assert.equal(data.results[0].code, 'invitation_sent');
  const mutations = app.requests.filter((entry) => entry.method !== 'GET');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].path, `/backend-api/accounts/${workspaceId}/invites`);
  assert.deepEqual(mutations[0].body.email_addresses, [newEmail]);
  const { data: state } = await app.request('/api/state');
  assert.equal(state.mothers[0].seatClaimsCount, 1);
  assert.equal(state.children[0].teamInvitations[0].status, 'invited');
  assert.deepEqual(app.unexpected, []);
});

test('selected invitation action retains a real unrelated pending invitation and never exceeds purchased capacity', async (t) => {
  const app = await fixture(t, { remote: { [workspaceId]: { invites: [{ id: 'old-invite', email_address: removedEmail }] } },
    children: [{ id: 'new-child', email: newEmail, status: 'ready', workspaceHistory: [] }] });
  const { status, data } = await app.request(`/api/mothers/${motherId}/invitations`, { method: 'POST', body: { childIds: ['new-child'] } });
  assert.equal(status, 207);
  assert.equal(data.results[0].code, 'seat_capacity_exhausted');
  assertReadOnly(app);
});

test('regular Team sync reconciles a vanished bound invitation as well as detached invitations', async (t) => {
  const oldChild = child();
  const app = await fixture(t, { mothers: [mother({ seatClaims: [claim({ childId: oldChild.id, phase: 'invited' })] })], children: [oldChild] });
  const result = await app.request(`/api/mothers/${motherId}/sync`, { method: 'POST', body: {} });
  assert.equal(result.data.ok, true);
  const { data } = await app.request('/api/state');
  assert.equal(data.mothers[0].seatsOpen, 1);
  assert.equal(data.children[0].teamInvitations.length, 0);
  assert.equal((await app.saved()).children[0].teamInvitations[0].status, 'expired');
  assertReadOnly(app);
});

test('capacity GET never refreshes a revoked manager token but regular sync retains its stored-RT recovery', async (t) => {
  const app = await fixture(t, { recoverInvalidToken: true,
    mothers: [mother({ refreshToken: 'private-fixture-refresh-token' })] });
  const capacity = await app.request();
  assert.equal(capacity.data.fresh, false);
  assert.equal(capacity.data.checks.members.status, 403);
  assert.equal(capacity.data.released, 0);
  assert.doesNotMatch(JSON.stringify(capacity.data.checks), /private_fixture_token_invalid|authFailure/);
  assertReadOnly(app);
  const sync = await app.request(`/api/mothers/${motherId}/sync`, { method: 'POST', body: {} });
  assert.equal(sync.data.ok, true);
  assert.equal(sync.data.membersResult.ok, true);
  const refreshRequests = app.requests.filter((entry) => entry.path === '/mock-token');
  assert.equal(refreshRequests.length, 1);
  assert.equal(refreshRequests[0].body.grant_type, 'refresh_token');
  assert.equal(app.requests.filter((entry) => entry.path.endsWith('/users')).length, 3);
  const saved = await app.saved();
  assert.equal(saved.mothers[0].seatClaims.length, 0);
  assert.equal(saved.mothers[0].refreshToken, 'private-refreshed-fixture-rt');
  assert.deepEqual(app.unexpected, []);
});

const cancellationRoute = `/api/mothers/${motherId}/invitations/old-claim`;

function cancellationRequests(app) {
  assert.deepEqual(app.unexpected, []);
  return app.requests.filter((entry) => entry.method === 'DELETE');
}

test('cancelling a detached invitation deletes its exact remote email and releases a verified purchased seat', async (t) => {
  const app = await fixture(t, { remote: { [workspaceId]: { invites: [{ id: 'old-invite', email_address: removedEmail }] } } });
  const result = await app.request(cancellationRoute, { method: 'DELETE' });
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.code, 'invitation_cancelled');
  assert.equal(result.data.fresh, true);
  assert.equal(result.data.state.mothers[0].seatClaimsCount, 0);
  assert.equal(result.data.state.mothers[0].seatsOpen, 1);
  assert.deepEqual(result.data.reservations, []);
  assert.deepEqual(cancellationRequests(app), [{ method: 'DELETE', path: `/backend-api/accounts/${workspaceId}/invites`,
    query: null, body: { email_address: removedEmail } }]);
  assert.equal(app.remote[workspaceId].invites.length, 0);
  const deletionIndex = app.requests.findIndex((entry) => entry.method === 'DELETE');
  assert.ok(app.requests.slice(0, deletionIndex).some((entry) => entry.path.endsWith('/users')));
  assert.ok(app.requests.slice(deletionIndex + 1).some((entry) => entry.path.endsWith('/users')));
  assert.ok(app.requests.slice(deletionIndex + 1).some((entry) => entry.path.endsWith('/invites')));
  assert.doesNotMatch(JSON.stringify(result.data), /private-capacity-fixture-token|old-invite/);
});

test('successful cancellation clears target child invitation links and preserves another Team invitation', async (t) => {
  const oldChild = child({ teamInvitations: [...child().teamInvitations,
    { motherId: 'other-mother', workspaceId: 'other-team', email: removedEmail, inviteId: 'other-invite', status: 'invited' }] });
  const app = await fixture(t, { mothers: [mother({ seatClaims: [claim({ childId: oldChild.id, phase: 'invited' })] })],
    children: [oldChild], remote: { [workspaceId]: { invites: [{ id: 'old-invite', email_address: removedEmail }] } } });
  const result = await app.request(cancellationRoute, { method: 'DELETE' });
  assert.equal(result.status, 200);
  const saved = await app.saved();
  const account = saved.children[0];
  assert.equal(account.pendingWorkspaceId, null);
  assert.equal(account.pendingInviteId, null);
  assert.notEqual(account.teamInvitations.find((entry) => entry.workspaceId === workspaceId).status, 'invited');
  assert.equal(account.teamInvitations.find((entry) => entry.workspaceId === 'other-team').status, 'invited');
  assert.equal(saved.mothers[0].seatClaims.length, 0);
  assert.equal(cancellationRequests(app).length, 1);
});

test('cancellation refuses an invitation already accepted by an active member without deleting any user', async (t) => {
  const app = await fixture(t, { remote: { [workspaceId]: { invites: [{ id: 'old-invite', email_address: removedEmail }],
    members: [owner, { id: 'accepted-user', verified_email: removedEmail, role: 'standard-user', seat_type: 'default' }] } } });
  const result = await app.request(cancellationRoute, { method: 'DELETE' });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'already_workspace_member');
  assert.equal(cancellationRequests(app).length, 0);
  assertReadOnly(app);
});

test('approval reservations and reservations belonging to another workspace cannot be cancelled', async (t) => {
  for (const phase of ['approval_unknown', 'accepted_pending_sync', 'approval_pending']) {
    const app = await fixture(t, { mothers: [mother({ seatClaims: [claim({ phase })] })] });
    const result = await app.request(cancellationRoute, { method: 'DELETE' });
    assert.equal(result.status, 409, phase);
    assert.equal(result.data.code, 'invitation_not_cancellable', phase);
    assert.equal((await app.saved()).mothers[0].seatClaims.length, 1);
    assertReadOnly(app);
  }
  const app = await fixture(t, { mothers: [mother({ seatClaims: [claim({ workspaceId: 'other-team' })] })] });
  const result = await app.request(cancellationRoute, { method: 'DELETE' });
  assert.equal(result.status, 404);
  assert.equal(result.data.code, 'invalid_invitation_reservation');
  assert.equal((await app.saved()).mothers[0].seatClaims.length, 1);
  assertReadOnly(app);
});

test('upstream cancellation denial and false success payload keep the claim and pending child links', async (t) => {
  const oldChild = child();
  const remote = { [workspaceId]: { invites: [{ id: 'old-invite', email_address: removedEmail }], cancelStatus: 403 } };
  const app = await fixture(t, { mothers: [mother({ seatClaims: [claim({ childId: oldChild.id, phase: 'invited' })] })], children: [oldChild], remote });
  for (const kind of ['denied', 'false-success']) {
    if (kind === 'false-success') { delete remote[workspaceId].cancelStatus; remote[workspaceId].cancelPayload = { success: false }; }
    const result = await app.request(cancellationRoute, { method: 'DELETE' });
    assert.equal(result.status, kind === 'denied' ? 403 : 502);
    assert.equal(result.data.code, 'invitation_cancel_failed');
    const saved = await app.saved();
    assert.equal(saved.mothers[0].seatClaims.length, 1);
    assert.equal(saved.children[0].pendingWorkspaceId, workspaceId);
    assert.equal(saved.children[0].pendingInviteId, 'old-invite');
    assert.equal(saved.children[0].teamInvitations[0].status, 'invited');
    assert.doesNotMatch(JSON.stringify(result.data), /private-cancel-error/);
  }
  assert.equal(cancellationRequests(app).length, 2);
});

test('a successful DELETE response cannot release a seat while the invitation is still listed upstream', async (t) => {
  const app = await fixture(t, { remote: { [workspaceId]: { invites: [{ id: 'old-invite', email_address: removedEmail }], cancelKeepInvite: true } } });
  const result = await app.request(cancellationRoute, { method: 'DELETE' });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'invitation_cancellation_unconfirmed');
  assert.equal((await app.saved()).mothers[0].seatClaims.length, 1);
  const readback = await app.request('/api/state');
  assert.equal(readback.data.mothers[0].seatsOpen, 0);
  assert.equal(cancellationRequests(app).length, 1);
});

test('absent invitation cancellation clears stale local reservation only after complete member verification', async (t) => {
  const oldChild = child();
  const remote = { [workspaceId]: { membersPayload: { items: [owner], total: 2 } } };
  const app = await fixture(t, { mothers: [mother({ seatClaims: [claim({ childId: oldChild.id, phase: 'invited' })] })], children: [oldChild], remote });
  const failed = await app.request(cancellationRoute, { method: 'DELETE' });
  assert.ok(failed.status >= 400);
  assert.equal(failed.data.code, 'invitation_verification_failed');
  assert.equal((await app.saved()).mothers[0].seatClaims.length, 1);
  delete remote[workspaceId].membersPayload;
  const success = await app.request(cancellationRoute, { method: 'DELETE' });
  assert.equal(success.status, 200);
  assert.equal(success.data.ok, true);
  assert.equal(success.data.state.mothers[0].seatsOpen, 1);
  assert.equal((await app.saved()).children[0].pendingInviteId, null);
  assert.equal(cancellationRequests(app).length, 0);
  assertReadOnly(app);
});

test('an unavailable member check after DELETE keeps local capacity reserved until absence can be verified', async (t) => {
  const app = await fixture(t, { remote: { [workspaceId]: { invites: [{ id: 'old-invite', email_address: removedEmail }],
    afterCancel: { membersStatus: 403 } } } });
  const result = await app.request(cancellationRoute, { method: 'DELETE' });
  assert.ok(result.status >= 400);
  assert.equal(result.data.code, 'invitation_cancellation_unconfirmed');
  assert.equal((await app.saved()).mothers[0].seatClaims.length, 1);
  assert.equal(cancellationRequests(app).length, 1);
});

test('subscription permission failure does not prevent verified invitation cancellation or claim release', async (t) => {
  const app = await fixture(t, { remote: { [workspaceId]: { invites: [{ id: 'old-invite', email_address: removedEmail }], subscriptionStatus: 403 } } });
  const result = await app.request(cancellationRoute, { method: 'DELETE' });
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.code, 'invitation_cancelled');
  assert.equal(result.data.fresh, false);
  assert.equal(result.data.checks.subscription.ok, false);
  assert.equal(result.data.checks.subscription.status, 403);
  assert.equal((await app.saved()).mothers[0].seatClaims.length, 0);
  assert.equal(cancellationRequests(app).length, 1);
});

test('an invitation accepted during cancellation remains an occupied member seat instead of falsely becoming available', async (t) => {
  const app = await fixture(t, { remote: { [workspaceId]: { invites: [{ id: 'old-invite', email_address: removedEmail }],
    afterCancel: { members: [owner, { id: 'accepted-user', email: removedEmail, role: 'standard-user', seat_type: 'default' }] } } } });
  const result = await app.request(cancellationRoute, { method: 'DELETE' });
  assert.equal(result.status, 200);
  assert.equal(result.data.code, 'already_workspace_member');
  assert.equal(result.data.state.mothers[0].seatsInUse, 2);
  assert.equal(result.data.state.mothers[0].seatsOpen, 0);
  assert.equal(cancellationRequests(app).length, 1);
});
