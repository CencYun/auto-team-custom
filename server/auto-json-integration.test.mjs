import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverScript = fileURLToPath(new URL('./index.mjs', import.meta.url));
const puppeteerModule = import.meta.resolve('puppeteer-core');
const dataKey = 'isolated-auto-json-test-key';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function unusedPort() {
  const socket = createServer();
  const port = await listen(socket);
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function token(email, id, { workspaceId = `personal-${id}`, plan = 'free', expiresIn = 3600 } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    sub: id, exp: Math.floor(Date.now() / 1000) + expiresIn,
    'https://api.openai.com/auth': { chatgpt_account_id: workspaceId, chatgpt_plan_type: plan },
    'https://api.openai.com/profile': { email },
  })).toString('base64url');
  return { access_token: `${header}.${claims}.private-fixture-signature`, refresh_token: `private-fixture-new-rt-${id}`, expires_in: expiresIn };
}

function assertPublicAutoJsonLogs(job, children) {
  assert.ok(Array.isArray(job.logs), 'job polling must expose its safe execution logs');
  assert.equal(job.logsTruncated, false);
  const allowedKeys = new Set(['sequence', 'time', 'childId', 'email', 'stage', 'status', 'message', 'code', 'httpStatus']);
  const accounts = new Map(children.map((child) => [child.id, child.email]));
  for (const [index, entry] of job.logs.entries()) {
    assert.equal(entry.sequence, index + 1);
    assert.ok(Number.isFinite(Date.parse(entry.time)));
    for (const key of ['stage', 'status', 'message']) assert.equal(typeof entry[key], 'string');
    assert.ok(entry.stage && entry.status && entry.message);
    assert.ok(Object.keys(entry).every((key) => allowedKeys.has(key)), 'logs must not expose auth URLs or raw OAuth fields');
    assert.equal(entry.email, entry.childId === null ? '' : accounts.get(entry.childId));
    if (entry.code !== undefined) assert.equal(typeof entry.code, 'string');
    if (entry.httpStatus !== undefined) assert.ok(Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599);
  }
  assert.doesNotMatch(JSON.stringify(job.logs), /private-|fixture-automatic-code|manual-team-code|JBSWY3DPEHPK3PXP|upstream-private-message|quota_forbidden_private_upstream_error|proxy-private-|auth\.openai\.com|https?:\/\//);
}

async function appFixture(t, children, { responses = {}, tokenStatuses = {}, holdTokens = false, credentialChild = null, challenge = false, mothers = [], teamScenario = null, roxyEnabled = false, concurrency = 2 } = {}) {
  const grants = [];
  const paths = [];
  const selectedWorkspaces = [];
  const requests = [];
  const teamWorkspaceId = mothers[0]?.accountId || 'fixture-team-workspace';
  const members = teamScenario?.members || [];
  const invitations = teamScenario?.invitations || [];
  let active = 0;
  let maxActive = 0;
  let authState = credentialChild?.authSession?.state || '';
  let releaseTokens;
  const tokenRequests = new EventEmitter();
  const tokenGate = holdTokens ? new Promise((resolve) => { releaseTokens = resolve; }) : Promise.resolve();
  const upstream = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    paths.push(pathname);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    requests.push({ path: pathname, method: req.method, body: raw, authorization: req.headers.authorization, accountId: req.headers['chatgpt-account-id'] });
    const json = (payload, status = 200, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    if (pathname === '/token') {
      const form = new URLSearchParams(raw);
      const key = form.get('refresh_token') || form.get('code');
      grants.push({ key, type: form.get('grant_type'), verifier: form.get('code_verifier') });
      active += 1;
      maxActive = Math.max(maxActive, active);
      tokenRequests.emit('request');
      await tokenGate;
      const selected = selectedWorkspaces[selectedWorkspaces.length - 1];
      const response = key === 'fixture-automatic-code' && teamScenario
        ? (selected === teamWorkspaceId ? teamScenario.teamToken || token(credentialChild.email, credentialChild.id, { workspaceId: teamWorkspaceId, plan: 'team' }) : token(credentialChild.email, credentialChild.id))
        : responses[key];
      active -= 1;
      return json(response || { error: 'invalid_grant', message: `upstream-private-message-${key} http://proxy-private-user:proxy-private-password@proxy.private.fixture:8888` }, tokenStatuses[key] || (response ? 200 : 400));
    }
    if (pathname === '/sentinel') return json({ token: 'isolated-sentinel-fixture-token' });
    if (pathname === '/oauth/authorize') {
      authState = new URL(req.url, 'http://127.0.0.1').searchParams.get('state');
      return json({}, 302, { location: 'https://auth.openai.com/log-in' });
    }
    if (pathname === '/log-in' || pathname === '/workspace') return json({});
    if (pathname === '/api/accounts/authorize/continue') {
      assert.equal(JSON.parse(raw).username.value, credentialChild.email);
      const teamChallenge = teamScenario?.challengeTeam && members.some((member) => member.email === credentialChild.email);
      return challenge || teamChallenge ? json({ error: 'turnstile_required' }, 403) : json({ continue_url: 'https://auth.openai.com/log-in/password' });
    }
    if (pathname === '/api/accounts/password/verify') {
      assert.equal(JSON.parse(raw).password, credentialChild.password);
      return json({ continue_url: teamScenario?.noMfa ? 'https://auth.openai.com/workspace' : 'https://auth.openai.com/mfa-challenge/fixture-challenge' });
    }
    if (pathname === '/api/accounts/mfa/verify') {
      assert.match(JSON.parse(raw).code, /^\d{6}$/);
      return json({ continue_url: 'https://auth.openai.com/workspace' });
    }
    if (pathname === '/sign-in-with-chatgpt/codex/consent') {
      const workspaces = Buffer.from(JSON.stringify({ workspaces: [
        { id: teamWorkspaceId, kind: 'team' },
        { id: `personal-${credentialChild.id}`, kind: 'personal' },
      ] })).toString('base64url');
      return json({}, 200, { 'set-cookie': `oai-client-auth-session=${workspaces}.signature; Path=/; Secure; HttpOnly` });
    }
    if (pathname === '/api/accounts/workspace/select') {
      selectedWorkspaces.push(JSON.parse(raw).workspace_id);
      return json({ continue_url: `http://localhost:1455/auth/callback?code=fixture-automatic-code&state=${authState}` });
    }
    if (teamScenario && pathname === '/backend-api/subscriptions') {
      return json(teamScenario.subscription || { seats_in_use: members.length, seats_entitled: 2, seat_capacity: [{ type: 'default', paid: 2, held: 0 }], assigned: { default: members.length } });
    }
    if (teamScenario && pathname === `/backend-api/accounts/${teamWorkspaceId}/users` && req.method === 'GET') return json({ items: members, total: members.length });
    if (teamScenario && pathname === `/backend-api/accounts/${teamWorkspaceId}/invites` && req.method === 'GET') return json({ items: invitations, total: invitations.length });
    if (teamScenario && pathname === `/backend-api/accounts/${teamWorkspaceId}/invites` && req.method === 'POST') {
      const body = JSON.parse(raw);
      const invitation = { id: `private-invite-${invitations.length + 1}`, email_address: body.email_addresses[0], role: body.role };
      invitations.push(invitation);
      return json({ account_invites: [invitation] });
    }
    if (teamScenario && pathname === `/backend-api/accounts/${teamWorkspaceId}/invites/accept` && req.method === 'POST') {
      if (!teamScenario.membershipPending) {
        members.push({ id: credentialChild.id, email: credentialChild.email, role: 'standard-user', seat_type: teamScenario.acceptedSeatType || 'default' });
        const index = invitations.findIndex((invite) => invite.email_address === credentialChild.email);
        if (index >= 0) invitations.splice(index, 1);
      }
      return json({ success: true });
    }
    if (teamScenario && pathname === '/backend-api/wham/usage') {
      return teamScenario.quotaFailure ? json({ error: 'quota_forbidden_private_upstream_error' }, 403)
        : teamScenario.malformedQuota ? json({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 1e100 } } })
        : json({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 }, secondary_window: { used_percent: 10, limit_window_seconds: 604800 } } });
    }
    return json({ error: `unexpected-isolated-request-${pathname}` }, 503);
  });
  const upstreamPort = await listen(upstream);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'auto-json-integration-'));
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 1, settings: { concurrency, autoRefill: false,
    ...(roxyEnabled ? { integrations: { roxy: { enabled: true, baseUrl: 'http://127.0.0.1:50000', apiKey: 'fixture-private-roxy', workspaceId: 'fixture-roxy-workspace', profiles: children.map((child) => ({ childId: child.id, dirId: `fixture-${child.id}` })) } } } : {}),
  }, children, mothers, history: [] }));
  const port = await unusedPort();
  // The fixture replaces network I/O and disables Chromium in this child
  // process. No user browser, account, proxy, or official service is contacted.
  const preload = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === './openai-browser-login.mjs') return { url: 'fixture:auto-json-browser', shortCircuit: true };
      return nextResolve(specifier, context);
    }, load(url, context, nextLoad) {
      if (url === 'fixture:auto-json-browser') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
        export async function completeBrowserOAuth(options) {
          const { authUrl, expectedState, email, password, workspaceId, workspaceMode, getTotpCode, onProgress } = options;
          const authorization = new URL(authUrl);
          if (authorization.searchParams.get('state') !== expectedState) throw new Error('fixture_state_mismatch');
          const request = async (url, body) => {
            const response = await fetch(url, { redirect: 'manual', ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
            if (response.status === 403) throw Object.assign(new Error('fixture verification required'), { code: 'protocol_verification_required', status: 403, browserRequired: true, needsInput: true });
            return response;
          };
          onProgress('browser_start', 'fixture');
          await request(authUrl);
          onProgress('browser_email', 'fixture');
          await request('https://auth.openai.com/api/accounts/authorize/continue', { username: { value: email } });
          onProgress('browser_password', 'fixture');
          const verified = await (await request('https://auth.openai.com/api/accounts/password/verify', { password })).json();
          if (verified.continue_url.includes('/mfa')) {
            let code;
            try { code = getTotpCode(); } catch { throw Object.assign(new Error('fixture TOTP invalid'), { code: 'totp_invalid', status: 202, needsInput: true }); }
            if (!code) throw Object.assign(new Error('fixture TOTP required'), { code: 'totp_required', status: 202, needsInput: true });
            onProgress('browser_totp', 'fixture');
            await request('https://auth.openai.com/api/accounts/mfa/verify', { code });
          }
          const consent = await request('https://auth.openai.com/sign-in-with-chatgpt/codex/consent');
          const cookie = consent.headers.get('set-cookie').split('=', 2)[1].split('.', 1)[0];
          const entries = JSON.parse(Buffer.from(cookie, 'base64url')).workspaces;
          const selected = entries.find((item) => workspaceMode === 'team' ? item.id === workspaceId && item.kind === 'team' : item.kind === 'personal');
          if (!selected) throw Object.assign(new Error('fixture workspace unavailable'), { code: 'workspace_list_unavailable', status: 202, browserRequired: true, needsInput: true });
          onProgress('browser_workspace', 'fixture');
          const callback = await (await request('https://auth.openai.com/api/accounts/workspace/select', { workspace_id: selected.id })).json();
          onProgress('browser_callback', 'fixture');
          return { callbackUrl: callback.continue_url };
        }
      `)} };
      return nextLoad(url, context);
    } });
    import puppeteer from ${JSON.stringify(puppeteerModule)};
    puppeteer.launch = async () => { throw new Error('isolated_test_browser_disabled'); };
    puppeteer.connect = async () => { throw new Error('isolated_test_roxy_browser_disabled'); };
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.port === '50000') {
        // Existing bindings are now checked against the remote inventory before
        // login. Only provide this read-only fixture; real Roxy stays disabled.
        if (url.hostname === '127.0.0.1' && url.pathname === '/browser/list_v3') {
          const rows = ${JSON.stringify(children.map((child) => ({ dirId: `fixture-${child.id}`, windowRemark: `auto-team:child:${child.id}` })))};
          return new Response(JSON.stringify({ code: 0, data: { total: rows.length, rows } }), { headers: { 'content-type': 'application/json' } });
        }
        throw new Error('isolated_test_roxy_api_disabled');
      }
      if (url.hostname === 'auth.openai.com') {
        const pathname = ['/api/oauth/oauth2/token', '/oauth/token'].includes(url.pathname) ? '/token' : url.pathname;
        return nativeFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}`)} + pathname + url.search, options);
      }
      if (url.hostname === 'sentinel.openai.com') return nativeFetch(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/sentinel`)}, options);
      if (url.hostname !== '127.0.0.1') throw new Error('isolated_test_external_network_disabled');
      return nativeFetch(input, options);
    };
  `;
  const app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`, TEAM_ROTATION_DATA_DIR: dataDir,
      TEAM_ROTATION_DATA_KEY: dataKey, TEAM_ROTATION_API_TOKEN: '', TEAM_ROTATION_LOGIN_PASSWORD: 'isolated-auto-json-password',
      DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: 'false', OPENAI_REQUEST_TIMEOUT_MS: holdTokens ? '10000' : '2000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk; });
  app.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    releaseTokens?.();
    if (app.exitCode === null && app.signalCode === null) {
      const stopped = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await stopped;
    }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`fixture server exited: ${output}`);
    try {
      if ((await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(500) })).ok) break;
    } catch { /* Wait for isolated server readiness. */ }
    await delay(25);
  }
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'isolated-auto-json-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  async function request(route, { method = 'GET', body, authenticated = true } = {}) {
    const response = await fetch(`${baseUrl}${route}`, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2500) });
    return { status: response.status, data: await response.json() };
  }
  async function start(body = {}) {
    const result = await request('/api/children/auto-json', { method: 'POST', body });
    assert.equal(result.status, 202, JSON.stringify(result.data));
    assertPublicAutoJsonLogs(result.data.job, children);
    return result.data;
  }
  async function finish(jobId) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await request(`/api/children/auto-json/${jobId}`);
      assert.equal(result.status, 200);
      assertPublicAutoJsonLogs(result.data.job, children);
      if (result.data.job.status === 'complete') return result.data.job;
      await delay(20);
    }
    throw new Error('automatic JSON fixture job did not finish');
  }
  async function saved() {
    const encrypted = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
    if (!encrypted.encrypted) return encrypted;
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(dataKey).digest(), Buffer.from(encrypted.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString());
  }
  async function waitForTokenRequests(count) {
    const signal = AbortSignal.timeout(5000);
    while (grants.length < count) await once(tokenRequests, 'request', { signal });
  }
  return { request, start, finish, saved, grants, paths, selectedWorkspaces, requests, waitForTokenRequests, release: () => releaseTokens?.(), maxActive: () => maxActive };
}

test('background JSON jobs return immediately, share duplicate work, obey concurrency, and leave state reads responsive', async (t) => {
  const children = ['one', 'two'].map((id) => ({ id, email: `${id}@example.test`, refreshToken: `private-original-rt-${id}` }));
  const responses = Object.fromEntries(children.map((child) => [child.refreshToken, token(child.email, child.id)]));
  const app = await appFixture(t, children, { responses, holdTokens: true });
  const started = await app.start({ ids: children.map((child) => child.id) });
  assert.equal(started.job.status, 'queued');
  const duplicate = await app.start({ ids: ['two', 'one'] });
  assert.equal(duplicate.job.id, started.job.id);
  assert.equal(duplicate.reused, true);
  const overlap = await app.start({ ids: ['one'] });
  assert.notEqual(overlap.job.id, started.job.id);
  // Hold both upstream responses until both configured worker slots have
  // actually arrived; reading progress alone does not establish that barrier.
  await app.waitForTokenRequests(2);
  assert.equal((await app.request('/api/state')).status, 200);
  const progress = (await app.request(`/api/children/auto-json/${started.job.id}`)).data.job;
  assert.equal(progress.status, 'running');
  assert.equal(progress.completed, 0);
  assertPublicAutoJsonLogs(progress, children);
  for (const child of children) assert.ok(progress.logs.some((entry) => entry.childId === child.id && entry.stage === 'free_auth' && entry.status === 'running'));
  app.release();
  const completed = await app.finish(started.job.id);
  assert.equal(completed.succeeded, 2);
  assert.equal(completed.completed, 2);
  assert.equal((await app.finish(overlap.job.id)).succeeded, 1);
  assert.equal(app.grants.length, 2);
  assert.equal(app.maxActive(), 2);
  assert.doesNotMatch(JSON.stringify(completed), /private-original-rt|private-fixture-new-rt|private-fixture-signature/);
  const saved = await app.saved();
  assert.ok(saved.children.every((child) => child.refreshToken.startsWith('private-fixture-new-rt')));
});

test('background credential login selects the personal workspace and saves JSON without manual callback input', async (t) => {
  const child = { id: 'automatic-login', email: 'automatic-login@example.test', password: 'private-login-password', totp: 'JBSWY3DPEHPK3PXP' };
  const credentials = token(child.email, child.id);
  const app = await appFixture(t, [child], { credentialChild: child, responses: { 'fixture-automatic-code': credentials } });
  const job = await app.finish((await app.start({ ids: [child.id] })).job.id);
  assert.equal(job.succeeded, 1);
  assert.equal(job.needsAttention, 0);
  assert.equal(job.results[0].scope, 'free');
  assert.equal(job.results[0].source, 'email_password_2fa');
  assert.deepEqual(app.selectedWorkspaces, [`personal-${child.id}`]);
  assert.deepEqual(app.grants.map((grant) => grant.type), ['authorization_code']);
  const saved = (await app.saved()).children[0];
  assert.equal(saved.accessToken, credentials.access_token);
  assert.equal(saved.refreshToken, credentials.refresh_token);
  assert.equal(saved.authSession, null);
  assert.doesNotMatch(JSON.stringify(job), /private-login-password|JBSWY3DPEHPK3PXP|fixture-automatic-code|private-fixture-signature/);
});

test('official browser challenge reports needs attention and retains the exact manual OAuth session', async (t) => {
  const child = { id: 'challenge', email: 'challenge@example.test', password: 'private-challenge-password', totp: 'JBSWY3DPEHPK3PXP' };
  const app = await appFixture(t, [child], { credentialChild: child, challenge: true, roxyEnabled: true });
  const first = await app.finish((await app.start({ ids: [child.id] })).job.id);
  assert.equal(first.succeeded, 0);
  assert.equal(first.failed, 0);
  assert.equal(first.needsAttention, 1);
  assert.equal(first.results[0].browserRequired, true);
  assert.match(first.results[0].authUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  const session = (await app.saved()).children[0].authSession;
  assert.equal(new URL(first.results[0].authUrl).searchParams.get('state'), session.state);
  const requestCount = app.paths.length;
  const next = await app.finish((await app.start({ ids: [child.id] })).job.id);
  assert.equal(next.needsAttention, 1);
  assert.equal(app.paths.length, requestCount);
  assert.deepEqual((await app.saved()).children[0].authSession, session);
  assert.doesNotMatch(JSON.stringify(first), /private-challenge-password|JBSWY3DPEHPK3PXP/);
});

test('default jobs include AT-only and expired accounts, omit banned and complete accounts, and do not change Team membership', async (t) => {
  const atOnly = { id: 'at-only', email: 'at-only@example.test', accessToken: token('at-only@example.test', 'at-only').access_token };
  const expired = { id: 'expired', email: 'expired@example.test', accessToken: token('expired@example.test', 'expired', { expiresIn: -60 }).access_token, refreshToken: 'private-expired-rt',
    team: 'fixture-team-workspace', status: 'active', workspaceHistory: [{ team: 'fixture-team-workspace', status: 'active', role: 'member' }],
    workspaceTokens: { 'fixture-team-workspace': { accessToken: token('expired@example.test', 'expired', { workspaceId: 'fixture-team-workspace', plan: 'team' }).access_token, refreshToken: 'private-team-rt' } },
    teamAuthSessions: { 'fixture-team-workspace': { state: 'existing-team-state', codeVerifier: 'private-team-verifier' } } };
  const ready = { id: 'ready', email: 'ready@example.test', accessToken: token('ready@example.test', 'ready').access_token, refreshToken: 'private-ready-rt' };
  const banned = { id: 'banned', email: 'banned@example.test', status: 'banned', banStatus: 'banned' };
  const mother = { id: 'mother', email: 'owner@example.test', accountId: 'fixture-team-workspace', accessToken: 'private-owner-at' };
  const app = await appFixture(t, [atOnly, expired, ready, banned], { mothers: [mother], responses: { [expired.refreshToken]: token(expired.email, expired.id) } });
  const started = await app.start();
  assert.equal(started.job.total, 2);
  const job = await app.finish(started.job.id);
  const results = new Map(job.results.map((item) => [item.id, item]));
  assert.equal(results.get(atOnly.id).status, 'needs_attention');
  assert.equal(results.get(atOnly.id).code, 'credentials_required');
  assert.equal(results.get(expired.id).status, 'ready');
  const saved = (await app.saved()).children.find((item) => item.id === expired.id);
  assert.deepEqual(saved.workspaceHistory, expired.workspaceHistory);
  assert.deepEqual(saved.workspaceTokens, expired.workspaceTokens);
  assert.deepEqual(saved.teamAuthSessions, expired.teamAuthSessions);
  assert.equal(saved.team, expired.team);
  assert.deepEqual(app.paths, ['/token']);
  const reused = await app.finish((await app.start({ ids: [ready.id] })).job.id);
  assert.equal(reused.succeeded, 1);
  assert.equal(reused.results[0].source, 'access_token');
  assert.equal(app.grants.length, 1);
});

test('arrived matching callback is exchanged automatically before manual-input classification', async (t) => {
  const child = { id: 'callback', email: 'callback@example.test', status: 'login_pending', loginStatus: 'verification_required', loginBrowserRequired: true,
    authSession: { state: 'private-callback-state', codeVerifier: 'private-callback-verifier', callbackReceivedAt: new Date().toISOString(),
      callbackUrl: 'http://localhost:1455/auth/callback?code=private-returned-code&state=private-callback-state' } };
  const app = await appFixture(t, [child], { responses: { 'private-returned-code': token(child.email, child.id) } });
  const job = await app.finish((await app.start()).job.id);
  assert.equal(job.succeeded, 1);
  assert.equal(job.needsAttention, 0);
  assert.deepEqual(app.grants, [{ key: 'private-returned-code', type: 'authorization_code', verifier: 'private-callback-verifier' }]);
  assert.equal((await app.saved()).children[0].authSession, null);
  assert.doesNotMatch(JSON.stringify(job), /private-returned-code|private-callback-verifier|private-fixture-signature/);
});

test('manual phone and OTP states are preserved without login retries or exposing stored secrets', async (t) => {
  const children = ['phone_verification_required', 'waiting_code'].map((status) => ({ id: status, email: `${status}@example.test`, loginStatus: status, status: 'login_pending',
    password: 'private-stored-password', totp: 'private-stored-totp', authSession: { state: `saved-${status}`, codeVerifier: 'private-stored-verifier' } }));
  const app = await appFixture(t, children);
  const job = await app.finish((await app.start()).job.id);
  assert.equal(job.needsAttention, 2);
  assert.equal(job.failed, 0);
  assert.ok(job.results.every((result) => result.authUrl === null));
  assert.equal(app.paths.length, 0);
  assert.doesNotMatch(JSON.stringify(job), /private-stored-/);
  assert.deepEqual((await app.saved()).children.map((child) => child.authSession), children.map((child) => child.authSession));
});

test('adding missing 2FA input releases the waiting state so automatic acquisition can complete', async (t) => {
  const child = { id: 'add-totp', email: 'add-totp@example.test', password: 'private-add-totp-password' };
  const app = await appFixture(t, [child], { credentialChild: child, roxyEnabled: true, responses: { 'fixture-automatic-code': token(child.email, child.id) } });
  const initial = await app.finish((await app.start({ ids: [child.id] })).job.id);
  assert.equal(initial.needsAttention, 1);
  assert.equal(initial.results[0].code, 'totp_required');
  assert.ok(app.paths.includes('/api/accounts/password/verify'));
  assert.ok(!app.paths.includes('/api/accounts/mfa/verify'));
  const originalSession = (await app.saved()).children[0].authSession;
  assert.ok(originalSession.state && originalSession.codeVerifier);
  assert.equal(originalSession.phase, 'browser_password');
  const patched = await app.request(`/api/children/${child.id}`, { method: 'PATCH', body: { totp: 'JBSWY3DPEHPK3PXP' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.login.status, 'login_required');
  assert.deepEqual((await app.saved()).children[0].authSession, originalSession);
  const retried = await app.finish((await app.start({ ids: [child.id] })).job.id);
  assert.equal(retried.succeeded, 1);
  assert.equal((await app.saved()).children[0].refreshToken, `private-fixture-new-rt-${child.id}`);
});

test('correcting a TOTP secret reopens isolated browser login with original PKCE without replacing Team authorizations', async (t) => {
  const child = { id: 'correct-totp', email: 'correct-totp@example.test', password: 'private-correct-totp-password', totp: 'private-old-invalid-secret',
    status: 'login_pending', loginStatus: 'waiting_code', loginBrowserRequired: false,
    authSession: { state: 'original-mfa-state', codeVerifier: 'private-original-mfa-verifier', currentUrl: 'https://auth.openai.com/mfa-challenge/fixture-challenge', cookies: { 'oai-did': 'original-device-id' } },
    teamAuthSessions: { 'fixture-team-workspace': { state: 'original-team-state', codeVerifier: 'private-original-team-verifier' } } };
  const app = await appFixture(t, [child], { credentialChild: child, roxyEnabled: true, responses: { 'fixture-automatic-code': token(child.email, child.id) } });
  const skipped = await app.finish((await app.start({ ids: [child.id] })).job.id);
  assert.equal(skipped.needsAttention, 1);
  assert.equal(app.paths.length, 0);
  await app.request(`/api/children/${child.id}`, { method: 'PATCH', body: { totp: 'JBSWY3DPEHPK3PXP' } });
  const beforeRetry = (await app.saved()).children[0];
  assert.deepEqual(beforeRetry.authSession, child.authSession);
  assert.deepEqual(beforeRetry.teamAuthSessions, child.teamAuthSessions);
  const retried = await app.finish((await app.start({ ids: [child.id] })).job.id);
  assert.equal(retried.succeeded, 1);
  assert.ok(app.paths.includes('/oauth/authorize'));
  assert.ok(app.paths.includes('/api/accounts/password/verify'));
  assert.deepEqual(app.grants, [{ key: 'fixture-automatic-code', type: 'authorization_code', verifier: child.authSession.codeVerifier }]);
  assert.deepEqual((await app.saved()).children[0].teamAuthSessions, child.teamAuthSessions);
});

test('editing credentials cannot clear an official browser or phone verification requirement', async (t) => {
  const children = [
    { id: 'browser-edited', email: 'browser-edited@example.test', status: 'login_pending', loginStatus: 'verification_required', loginBrowserRequired: true,
      loginUrl: 'https://auth.openai.com/oauth/authorize?state=original-browser-state', authSession: { state: 'original-browser-state', codeVerifier: 'private-browser-verifier' } },
    { id: 'phone-edited', email: 'phone-edited@example.test', status: 'phone_verification_required', loginStatus: 'phone_verification_required',
      authSession: { state: 'original-phone-state', codeVerifier: 'private-phone-verifier' } },
  ];
  const app = await appFixture(t, children);
  for (const child of children) {
    const updated = await app.request(`/api/children/${child.id}`, { method: 'PATCH', body: { password: 'private-corrected-password', totp: 'JBSWY3DPEHPK3PXP' } });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.login.status, child.loginStatus);
  }
  const job = await app.finish((await app.start()).job.id);
  assert.equal(job.needsAttention, 2);
  assert.equal(app.paths.length, 0);
  assert.deepEqual((await app.saved()).children.map((child) => child.authSession), children.map((child) => child.authSession));
});

test('an expired token response is never reported as a completed JSON and raw upstream errors stay private', async (t) => {
  const expired = { id: 'expired-result', email: 'expired-result@example.test', refreshToken: 'private-expired-result-rt' };
  const failed = { id: 'bad-refresh', email: 'bad-refresh@example.test', refreshToken: 'private-bad-refresh-rt' };
  const app = await appFixture(t, [expired, failed], { responses: { [expired.refreshToken]: token(expired.email, expired.id, { expiresIn: -60 }) } });
  const job = await app.finish((await app.start()).job.id);
  assert.equal(job.succeeded, 0);
  const results = new Map(job.results.map((item) => [item.id, item]));
  assert.equal(results.get(expired.id).status, 'failed');
  assert.equal(results.get(expired.id).code, 'json_incomplete');
  assert.equal(results.get(failed.id).status, 'needs_attention');
  assert.equal(results.get(failed.id).code, 'credentials_required');
  assert.doesNotMatch(JSON.stringify(job), /private-bad-refresh-rt|private-expired-result-rt|upstream-private-message|private-fixture-signature/);
});

test('automatic callback exchange rejects a different account identity and preserves original credentials', async (t) => {
  const original = token('identity@example.test', 'identity');
  const child = { id: 'identity', email: 'identity@example.test', status: 'login_pending', loginStatus: 'verification_required', loginBrowserRequired: true,
    accessToken: original.access_token, refreshToken: 'private-original-identity-rt', chatgptUserId: 'identity', accountId: 'personal-identity',
    authSession: { state: 'private-identity-state', codeVerifier: 'private-identity-verifier', callbackReceivedAt: new Date().toISOString(),
      callbackUrl: 'http://localhost:1455/auth/callback?code=private-wrong-identity-code&state=private-identity-state' } };
  const app = await appFixture(t, [child], { responses: { 'private-wrong-identity-code': token('different@example.test', 'different') } });
  const job = await app.finish((await app.start({ ids: [child.id] })).job.id);
  assert.equal(job.succeeded, 0);
  assert.equal(job.failed, 1);
  assert.equal(job.results[0].code, 'token_identity_mismatch');
  const saved = (await app.saved()).children[0];
  for (const key of ['email', 'accessToken', 'refreshToken', 'accountId', 'chatgptUserId']) assert.equal(saved[key], child[key]);
  assert.deepEqual(app.grants.map((grant) => grant.key), ['private-wrong-identity-code']);
  assert.doesNotMatch(JSON.stringify(job), /private-original-identity-rt|private-identity-verifier|private-wrong-identity-code|private-fixture-signature/);
});

test('background task routes require dashboard authentication and validate explicit account selection', async (t) => {
  const app = await appFixture(t, []);
  assert.equal((await app.request('/api/children/auto-json', { method: 'POST', body: {}, authenticated: false })).status, 401);
  assert.equal((await app.request('/api/children/auto-json/unknown', { authenticated: false })).status, 401);
  assert.equal((await app.request('/api/children/auto-json/unknown')).status, 404);
  for (const ids of [[], 'not-an-array', [null]]) {
    assert.equal((await app.request('/api/children/auto-json', { method: 'POST', body: { ids } })).status, 400);
  }
  assert.equal((await app.request('/api/children/auto-json', { method: 'POST', body: { ids: ['missing'] } })).status, 404);
  const empty = await app.finish((await app.start()).job.id);
  assert.equal(empty.total, 0);
  assert.equal(empty.completed, 0);
});

function teamOwner(workspaceId = 'fixture-team-workspace') {
  return { id: 'fixture-mother', accountId: workspaceId, email: 'owner@example.test', teamName: 'Fixture Team', accessToken: token('owner@example.test', 'owner', { workspaceId, plan: 'team' }).access_token };
}

function ownerMember() { return { id: 'owner', email: 'owner@example.test', role: 'account-owner', seat_type: 'default' }; }

test('selected child invitations need no Free JSON, reuse pending invites, enforce paid capacity and cooldown, and use standard member role', async (t) => {
  const children = [{ id: 'invite-one', email: 'invite-one@example.test' }, { id: 'invite-two', email: 'invite-two@example.test' },
    { id: 'cooling', email: 'cooling@example.test', workspaceHistory: [{ team: 'fixture-team-workspace', status: 'cooldown', retryAfter: new Date(Date.now() + 60_000).toISOString() }] }];
  const app = await appFixture(t, children, { mothers: [teamOwner()], teamScenario: { members: [ownerMember()] } });
  const invite = (childIds) => app.request('/api/mothers/fixture-mother/invitations', { method: 'POST', body: { childIds } });
  const first = await invite(['invite-one']);
  assert.equal(first.status, 200);
  assert.equal(first.data.invited, 1);
  assert.equal(first.data.results[0].status, 'invited');
  const duplicate = await invite(['invite-one']);
  assert.equal(duplicate.data.results[0].code, 'invitation_reused');
  const blocked = await invite(['invite-two', 'cooling']);
  assert.equal(blocked.status, 207);
  assert.equal(blocked.data.results[0].code, 'seat_capacity_exhausted');
  assert.equal(blocked.data.results[1].code, 'account_team_cooldown');
  const writes = app.requests.filter((request) => request.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].body), { email_addresses: ['invite-one@example.test'], role: 'standard-user', resend_emails: false });
  assert.equal(app.grants.length, 0);
  const state = (await app.request('/api/state')).data;
  const child = state.children.find((item) => item.id === 'invite-one');
  assert.deepEqual(child.teamInvitations, [{ motherId: 'fixture-mother', workspaceId: 'fixture-team-workspace', teamName: 'Fixture Team', status: 'invited', invitedAt: child.teamInvitations[0].invitedAt }]);
  assert.equal(child.team, undefined);
  assert.doesNotMatch(JSON.stringify(first.data), /private-invite-/);
  assert.doesNotMatch(JSON.stringify(child.teamInvitations), /inviteId|email_address/);
  const mismatch = await app.request('/api/mothers/fixture-mother/invitations', { method: 'POST', body: { childIds: ['invite-two'], workspaceId: 'other-workspace' } });
  assert.equal(mismatch.status, 409);
});

test('selected invitation workflow logs in, accepts and confirms membership, saves target Team JSON, and measures real quota', async (t) => {
  const child = { id: 'team-flow', email: 'team-flow@example.test', password: 'private-team-flow-password', totp: 'JBSWY3DPEHPK3PXP' };
  const app = await appFixture(t, [child, { id: 'unrelated', email: 'unrelated@example.test' }], { credentialChild: child, roxyEnabled: true, mothers: [teamOwner()], teamScenario: { members: [ownerMember()] } });
  await app.request('/api/mothers/fixture-mother/invitations', { method: 'POST', body: { childIds: [child.id] } });
  const started = await app.start({ scope: 'team', motherId: 'fixture-mother' });
  assert.equal(started.job.scope, 'team');
  assert.equal(started.job.workspaceId, 'fixture-team-workspace');
  assert.equal(started.job.total, 1);
  const job = await app.finish(started.job.id);
  assert.equal(job.succeeded, 1);
  assert.equal(job.results[0].authScope, 'team');
  assert.equal(job.results[0].quotaChecked, true);
  assert.equal(job.results[0].quota5h, 75);
  assert.equal(job.results[0].quota7d, 90);
  const accountStages = new Set(job.logs.filter((entry) => entry.childId === child.id).map((entry) => entry.stage));
  for (const stage of ['member_check', 'accept_invitation', 'team_auth', 'team_json', 'quota', 'completed']) assert.ok(accountStages.has(stage), `Team success log must include ${stage}`);
  assert.ok(job.logs.some((entry) => entry.childId === child.id && entry.stage === 'completed' && entry.status === 'ready'));
  assert.deepEqual(app.selectedWorkspaces, [`personal-${child.id}`, 'fixture-team-workspace']);
  const saved = (await app.saved()).children.find((item) => item.id === child.id);
  assert.equal(saved.accountId, `personal-${child.id}`);
  assert.equal(saved.workspaceHistory[0].role, 'standard-user');
  assert.equal(saved.workspaceHistory[0].quota5h, 75);
  assert.equal(saved.workspaceTokens['fixture-team-workspace'].refreshToken, `private-fixture-new-rt-${child.id}`);
  for (const message of ['正在提交账号邮箱', '正在提交账号密码', '正在提交当前六位 2FA 验证码', '正在选择目标授权工作空间', '已收到授权回调，正在兑换并保存 JSON']) {
    assert.ok(job.logs.some((entry) => entry.message === message), `automatic login should expose its safe stage: ${message}`);
  }
  assert.equal(saved.teamInvitations[0].status, 'joined');
  const quotaRequest = app.requests.find((request) => request.path === '/backend-api/wham/usage');
  assert.equal(quotaRequest.accountId, 'fixture-team-workspace');
  assert.equal(quotaRequest.authorization, `Bearer ${saved.workspaceTokens['fixture-team-workspace'].accessToken}`);
  assert.ok(!app.requests.some((request) => ['PATCH', 'DELETE'].includes(request.method)));
  const projected = (await app.request('/api/state')).data.children.find((item) => item.id === child.id);
  assert.equal(projected.teamAuthorizations[0].ready, true);
  assert.equal(projected.teamAuthorizations[0].hasRefreshToken, true);
  assert.ok(Date.parse(projected.teamAuthorizations[0].expiresAt) > Date.now());
  assert.doesNotMatch(JSON.stringify(job), /private-team-flow-password|private-fixture-signature|private-fixture-new-rt|JBSWY3DPEHPK3PXP/);
});

test('Team execution logs expose reached stages during token exchange before any result completes', async (t) => {
  const child = { id: 'live-team-logs', email: 'live-team-logs@example.test', password: 'private-live-team-password', totp: 'JBSWY3DPEHPK3PXP',
    team: 'fixture-team-workspace', workspaceHistory: [{ team: 'fixture-team-workspace', status: 'active', role: 'standard-user' }] };
  const app = await appFixture(t, [child], { credentialChild: child, holdTokens: true, mothers: [teamOwner()],
    teamScenario: { members: [ownerMember(), { id: child.id, email: child.email, role: 'standard-user', seat_type: 'default' }] } });
  const started = await app.start({ scope: 'team', motherId: 'fixture-mother', ids: [child.id] });
  await app.waitForTokenRequests(1);
  const duplicate = await app.start({ scope: 'team', motherId: 'fixture-mother', ids: [child.id, child.id] });
  assert.equal(duplicate.job.id, started.job.id);
  assert.equal(duplicate.reused, true);
  const polled = await app.request(`/api/children/auto-json/${started.job.id}`);
  assert.equal(polled.status, 200);
  const progress = polled.data.job;
  assertPublicAutoJsonLogs(progress, [child]);
  assert.equal(progress.status, 'running');
  assert.equal(progress.completed, 0);
  const reached = progress.logs.filter((entry) => entry.childId === child.id);
  assert.ok(reached.some((entry) => entry.stage === 'member_check' && entry.status === 'ready'));
  assert.ok(reached.some((entry) => entry.stage === 'team_auth' && entry.status === 'running'));
  assert.ok(!reached.some((entry) => ['team_json', 'quota', 'completed'].includes(entry.stage)));
  app.release();
  const completed = await app.finish(started.job.id);
  assert.equal(completed.succeeded, 1);
  assert.equal(completed.completed, 1);
  assert.equal(app.grants.length, 1);
  assert.deepEqual(completed.logs.slice(0, progress.logs.length), progress.logs, 'completed logs must preserve the real progress already returned by polling');
  assert.ok(completed.logs.some((entry) => entry.childId === child.id && entry.stage === 'team_json' && entry.status === 'ready'));
  assert.ok(completed.logs.some((entry) => entry.childId === child.id && entry.stage === 'quota' && entry.status === 'ready'));
});

test('Team browser challenge keeps its independent callback session and resumes after manual Team authorization', async (t) => {
  const child = { id: 'team-challenge', email: 'team-challenge@example.test', password: 'private-team-challenge-password', totp: 'JBSWY3DPEHPK3PXP' };
  const teamToken = token(child.email, child.id, { workspaceId: 'fixture-team-workspace', plan: 'team' });
  const app = await appFixture(t, [child], { credentialChild: child, roxyEnabled: true, mothers: [teamOwner()], responses: { 'manual-team-code': teamToken }, teamScenario: { members: [ownerMember()], challengeTeam: true } });
  await app.request('/api/mothers/fixture-mother/invitations', { method: 'POST', body: { childIds: [child.id] } });
  const body = { scope: 'team', motherId: 'fixture-mother', ids: [child.id] };
  const first = await app.finish((await app.start(body)).job.id);
  assert.equal(first.needsAttention, 1);
  assert.equal(first.results[0].phase, 'team_auth');
  assert.equal(first.results[0].authScope, 'team');
  assert.equal(first.results[0].quotaChecked, false);
  assert.ok(first.logs.some((entry) => entry.childId === child.id && entry.stage === 'team_auth' && entry.status === 'needs_attention'));
  assert.ok(!first.logs.some((entry) => entry.childId === child.id && ['team_json', 'quota', 'completed'].includes(entry.stage)));
  let saved = (await app.saved()).children[0];
  const freeToken = saved.accessToken;
  const original = saved.teamAuthSessions['fixture-team-workspace'];
  assert.ok(original.state);
  assert.equal(new URL(first.results[0].authUrl).searchParams.get('state'), original.state);
  const authorizeCount = app.paths.filter((pathname) => pathname === '/oauth/authorize').length;
  const retry = await app.finish((await app.start(body)).job.id);
  assert.equal(retry.needsAttention, 1);
  assert.equal(app.paths.filter((pathname) => pathname === '/oauth/authorize').length, authorizeCount);
  assert.deepEqual((await app.saved()).children[0].teamAuthSessions['fixture-team-workspace'], original);
  const callbackUrl = `http://localhost:1455/auth/callback?code=manual-team-code&state=${original.state}`;
  const manual = await app.request(`/api/children/${child.id}/team-auth`, { method: 'POST', body: { motherId: 'fixture-mother', callbackUrl } });
  assert.equal(manual.status, 200);
  const requestsBeforeReuse = app.requests.length;
  const finished = await app.finish((await app.start(body)).job.id);
  assert.equal(finished.succeeded, 1);
  assert.equal(finished.results[0].reused, true);
  assert.equal(finished.results[0].quotaChecked, false);
  assert.equal(app.requests.length, requestsBeforeReuse);
  saved = (await app.saved()).children[0];
  assert.equal(saved.accessToken, freeToken);
  assert.equal(saved.teamAuthSessions['fixture-team-workspace'], undefined);
});

test('Free prerequisite challenge reports its own auth scope and cannot accept the invitation prematurely', async (t) => {
  const child = { id: 'free-prerequisite', email: 'free-prerequisite@example.test', password: 'private-prerequisite-password', totp: 'JBSWY3DPEHPK3PXP' };
  const app = await appFixture(t, [child], { credentialChild: child, roxyEnabled: true, mothers: [teamOwner()], challenge: true, teamScenario: { members: [ownerMember()] } });
  await app.request('/api/mothers/fixture-mother/invitations', { method: 'POST', body: { childIds: [child.id] } });
  const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother', ids: [child.id] })).job.id);
  assert.equal(job.needsAttention, 1);
  assert.equal(job.results[0].authScope, 'free');
  assert.equal(job.results[0].phase, 'free_auth');
  assert.equal(job.results[0].scope, 'team');
  assert.ok(!app.paths.some((pathname) => pathname.endsWith('/invites/accept')));
  const saved = (await app.saved()).children[0];
  assert.ok(saved.authSession.state);
  assert.equal(saved.teamAuthSessions['fixture-team-workspace'], undefined);
  assert.equal(saved.workspaceHistory, undefined);
});

test('unconfirmed invitation acceptance does not create membership, Team JSON, or quota', async (t) => {
  const child = { id: 'unconfirmed', email: 'unconfirmed@example.test', password: 'private-unconfirmed-password', totp: 'JBSWY3DPEHPK3PXP' };
  const app = await appFixture(t, [child], { credentialChild: child, mothers: [teamOwner()], teamScenario: { members: [ownerMember()], membershipPending: true } });
  await app.request('/api/mothers/fixture-mother/invitations', { method: 'POST', body: { childIds: [child.id] } });
  const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother' })).job.id);
  assert.equal(job.succeeded, 0);
  assert.equal(job.results[0].code, 'membership_pending');
  assert.equal(job.results[0].quotaChecked, false);
  assert.deepEqual(app.selectedWorkspaces, [`personal-${child.id}`]);
  const saved = (await app.saved()).children[0];
  assert.equal(saved.workspaceHistory, undefined);
  assert.equal(saved.workspaceTokens['fixture-team-workspace'], undefined);
});

test('Team JSON success keeps failed quota explicitly unknown and never fabricates percentages', async (t) => {
  const child = { id: 'quota-fails', email: 'quota-fails@example.test', password: 'private-quota-password', team: 'fixture-team-workspace', chatgptUserId: 'quota-fails',
    workspaceHistory: [{ team: 'fixture-team-workspace', status: 'active', role: 'standard-user' }] };
  const app = await appFixture(t, [child], { credentialChild: child, mothers: [teamOwner()], teamScenario: { noMfa: true, members: [ownerMember(), { id: child.id, email: child.email, role: 'standard-user' }], quotaFailure: true } });
  const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother' })).job.id);
  assert.equal(job.succeeded, 1);
  assert.equal(job.results[0].quotaChecked, false);
  assert.equal(job.results[0].quotaStatus, 'unknown');
  assert.equal(job.results[0].quota5h, null);
  assert.equal(job.results[0].quota7d, null);
  assert.equal(job.results[0].quotaHttpStatus, 403);
  assert.ok(job.logs.some((entry) => entry.childId === child.id && entry.stage === 'quota' && entry.status === 'warning' && entry.httpStatus === 403));
  assert.ok(job.logs.some((entry) => entry.childId === child.id && entry.stage === 'team_json' && entry.status === 'ready'));
  assert.doesNotMatch(JSON.stringify(job), /quota_forbidden_private_upstream_error|private-quota-team-rt/);
  const requestsBeforeReuse = app.requests.length;
  const repeated = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother', ids: [child.id] })).job.id);
  assert.equal(repeated.succeeded, 1);
  assert.equal(repeated.results[0].reused, true);
  assert.equal(repeated.results[0].quota5h, null);
  assert.equal(repeated.results[0].quota7d, null);
  assert.equal(app.requests.length, requestsBeforeReuse);
  const rejected = await app.request('/api/children/auto-json', { method: 'POST', body: { scope: 'team', motherId: 'fixture-mother', ids: [child.id], retryFailed: true, retryJobId: job.id } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.message, 'retry_failed_accounts_only');
});

test('Team authorization readiness rejects wrong plans, expired or missing expiry, foreign identities, and other workspaces', async (t) => {
  function noExpiry(value) {
    const [header, raw] = value.split('.');
    const claims = JSON.parse(Buffer.from(raw, 'base64url'));
    delete claims.exp;
    return `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.private-fixture-signature`;
  }
  const invalid = [
    token('checks@example.test', 'checks', { workspaceId: 'fixture-team-workspace', plan: 'free' }).access_token,
    token('checks@example.test', 'checks', { workspaceId: 'fixture-team-workspace', plan: 'plus' }).access_token,
    token('checks@example.test', 'checks', { workspaceId: 'fixture-team-workspace', plan: 'team', expiresIn: -60 }).access_token,
    noExpiry(token('checks@example.test', 'checks', { workspaceId: 'fixture-team-workspace', plan: 'team' }).access_token),
    token('other@example.test', 'other', { workspaceId: 'fixture-team-workspace', plan: 'team' }).access_token,
    token('checks@example.test', 'checks', { workspaceId: 'other-team', plan: 'team' }).access_token,
  ];
  const children = invalid.map((accessToken, index) => ({ id: `checks-${index}`, email: 'checks@example.test', chatgptUserId: 'checks', team: 'fixture-team-workspace', workspaceTokens: { 'fixture-team-workspace': { accessToken, refreshToken: 'private-invalid-team-rt' } } }));
  const valid = { id: 'checks-valid', email: 'checks@example.test', chatgptUserId: 'checks', team: 'fixture-team-workspace', workspaceTokens: { 'fixture-team-workspace': { accessToken: token('checks@example.test', 'checks', { workspaceId: 'fixture-team-workspace', plan: 'business' }).access_token, refreshToken: 'private-valid-team-rt' } } };
  const app = await appFixture(t, [...children, valid], { mothers: [teamOwner()] });
  const projected = (await app.request('/api/state')).data.children;
  assert.ok(projected.filter((child) => child.id !== valid.id).every((child) => child.teamAuthorizations[0].ready === false));
  assert.equal(projected.find((child) => child.id === valid.id).teamAuthorizations[0].ready, true);
  assert.doesNotMatch(JSON.stringify(projected.map((child) => child.teamAuthorizations)), /private-invalid-team-rt|private-valid-team-rt|private-fixture-signature/);
  const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother', ids: [...children, valid].map((child) => child.id) })).job.id);
  assert.equal(job.results.find((result) => result.id === valid.id).reused, true);
  assert.ok(job.results.filter((result) => result.id !== valid.id).every((result) => result.status !== 'ready' && result.reused === false));
});

test('malformed quota processing cannot downgrade an already saved Team JSON or repeat its login', async (t) => {
  const child = { id: 'quota-processing-fails', email: 'quota-processing-fails@example.test', password: 'private-quota-password', team: 'fixture-team-workspace' };
  const app = await appFixture(t, [child], { credentialChild: child, mothers: [teamOwner()], teamScenario: { noMfa: true, malformedQuota: true,
    members: [ownerMember(), { id: child.id, email: child.email, role: 'standard-user' }] } });
  const body = { scope: 'team', motherId: 'fixture-mother', ids: [child.id] };
  const job = await app.finish((await app.start(body)).job.id);
  assert.equal(job.succeeded, 1);
  assert.equal(job.failed, 0);
  assert.equal(job.completed, 1);
  assert.equal(job.results[0].quotaChecked, false);
  assert.equal(job.results[0].quotaStatus, 'unknown');
  assert.equal(job.results[0].quota5h, null);
  assert.equal(job.results[0].quota7d, null);
  assert.equal(job.results[0].quotaCode, 'quota_save_failed');
  assert.ok(job.logs.some((entry) => entry.childId === child.id && entry.stage === 'quota' && entry.status === 'warning'));
  const saved = (await app.saved()).children[0];
  assert.ok(saved.workspaceTokens['fixture-team-workspace'].refreshToken);
  assert.equal(app.grants.length, 1);
  const requestCount = app.requests.length;
  const repeated = await app.finish((await app.start(body)).job.id);
  assert.equal(repeated.succeeded, 1);
  assert.equal(repeated.results[0].reused, true);
  assert.equal(app.requests.length, requestCount);
});

test('saved exact Team JSON skips all network, pending callbacks and login while preserving actual cached quota', async (t) => {
  const workspaceId = 'fixture-team-workspace';
  const child = { id: 'saved-ready', email: 'saved-ready@example.test', chatgptUserId: 'saved-ready', team: workspaceId,
    refreshToken: 'private-unrelated-personal-rt', password: 'private-unused-password',
    workspaceHistory: [{ team: workspaceId, status: 'active', quota5h: 0, quota7d: 87, quotaStatus: 'exhausted', quotaUpdatedAt: '2026-01-01T00:00:00.000Z' }],
    workspaceTokens: { [workspaceId]: { accessToken: token('saved-ready@example.test', 'saved-ready', { workspaceId, plan: 'business' }).access_token, refreshToken: 'private-team-rt' } },
    teamAuthSessions: { [workspaceId]: { state: 'private-stale-state', codeVerifier: 'private-stale-verifier', callbackReceivedAt: new Date().toISOString(), callbackUrl: 'http://localhost:1455/auth/callback?code=private-stale-code&state=private-stale-state' } },
    teamLoginStates: { [workspaceId]: { needsInput: true, browserRequired: true, code: 'browser_verification_required' } } };
  const app = await appFixture(t, [child], { mothers: [teamOwner()], roxyEnabled: true });
  const body = { scope: 'team', motherId: 'fixture-mother', ids: [child.id, child.id] };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const job = await app.finish((await app.start(body)).job.id);
    assert.equal(job.total, 1);
    assert.equal(job.completed, 1);
    assert.equal(job.succeeded, 1);
    const result = job.results[0];
    assert.equal(result.source, 'stored_team_token');
    assert.equal(result.reused, true);
    assert.equal(result.quotaCached, true);
    assert.equal(result.quotaChecked, false);
    assert.equal(result.quota5h, 0);
    assert.equal(result.quota7d, 87);
    assert.equal(result.quotaUpdatedAt, child.workspaceHistory[0].quotaUpdatedAt);
    assert.match(result.message, /已跳过重复登录/);
    assert.deepEqual(job.logs.filter((entry) => entry.childId === child.id).map((entry) => entry.stage), ['queued', 'completed']);
    assert.equal(app.requests.length, 0);
  }
  const saved = (await app.saved()).children[0];
  assert.deepEqual(saved.workspaceTokens, child.workspaceTokens);
  assert.deepEqual(saved.teamAuthSessions, child.teamAuthSessions);
});

test('default Team batch excludes saved successful JSON and an explicit ready account remains a harmless skip', async (t) => {
  const workspaceId = 'fixture-team-workspace';
  const ready = { id: 'batch-ready', email: 'batch-ready@example.test', team: workspaceId, chatgptUserId: 'batch-ready',
    workspaceTokens: { [workspaceId]: { accessToken: token('batch-ready@example.test', 'batch-ready', { workspaceId, plan: 'team' }).access_token, refreshToken: 'private-batch-ready-rt' } } };
  const pending = { id: 'batch-pending', email: 'batch-pending@example.test', team: workspaceId };
  const unrelated = { id: 'batch-unrelated', email: 'batch-unrelated@example.test' };
  const app = await appFixture(t, [ready, pending, unrelated], { mothers: [teamOwner()], teamScenario: {
    members: [ownerMember(), { id: pending.id, email: pending.email, role: 'standard-user', seat_type: 'default' }],
  } });
  const batch = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother' })).job.id);
  assert.equal(batch.total, 1);
  assert.deepEqual(batch.results.map((result) => result.id), [pending.id]);
  assert.ok(batch.logs.every((entry) => entry.childId !== ready.id && entry.childId !== unrelated.id));
  assert.deepEqual((await app.saved()).children.find((child) => child.id === ready.id).workspaceTokens, ready.workspaceTokens);
  const requestCount = app.requests.length;
  const single = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother', ids: [ready.id], retryAccount: true })).job.id);
  assert.equal(single.total, 1);
  assert.equal(single.succeeded, 1);
  assert.equal(single.results[0].id, ready.id);
  assert.equal(single.results[0].reused, true);
  assert.equal(app.requests.length, requestCount);
});

test('single account retry requires an explicit Team account and cannot expand or mix retry scopes', async (t) => {
  const children = ['retry-target', 'retry-other'].map((id) => ({ id, email: `${id}@example.test` }));
  const app = await appFixture(t, children, { mothers: [teamOwner()] });
  const base = { scope: 'team', motherId: 'fixture-mother', retryAccount: true };
  for (const body of [
    base,
    { ...base, ids: [] },
    { ...base, ids: [''] },
    { ...base, ids: children.map((child) => child.id) },
    { ...base, ids: [children[0].id], scope: 'free' },
    { ...base, ids: [children[0].id], retryFailed: true },
    { ...base, ids: [children[0].id], retryFailed: false },
    { ...base, ids: [children[0].id], retryJobId: 'previous-job' },
    { ...base, ids: [children[0].id], retryAccount: 'true' },
  ]) {
    const result = await app.request('/api/children/auto-json', { method: 'POST', body });
    assert.equal(result.status, 400);
    const emptySelection = Array.isArray(body.ids) && !body.ids.some((id) => String(id || '').trim());
    assert.equal(result.data.message, emptySelection ? 'child_ids_required' : 'invalid_retry_request', JSON.stringify(body));
  }
  assert.equal(app.requests.length, 0);
});

test('single account retry reopens only its paused Team login without an old job ID', async (t) => {
  const workspaceId = 'fixture-team-workspace';
  const child = { id: 'single-paused', email: 'single-paused@example.test', password: 'private-single-paused-password', team: workspaceId };
  const ready = { id: 'single-ready-other', email: 'single-ready-other@example.test', team: workspaceId, chatgptUserId: 'single-ready-other',
    workspaceTokens: { [workspaceId]: { accessToken: token('single-ready-other@example.test', 'single-ready-other', { workspaceId, plan: 'team' }).access_token, refreshToken: 'private-single-ready-rt' } } };
  const scenario = { noMfa: true, challengeTeam: true,
    members: [ownerMember(), { id: child.id, email: child.email, role: 'standard-user', seat_type: 'default' }] };
  const app = await appFixture(t, [child, ready], { credentialChild: child, mothers: [teamOwner()], roxyEnabled: true, teamScenario: scenario });
  const body = { scope: 'team', motherId: 'fixture-mother', ids: [child.id] };
  const first = await app.finish((await app.start(body)).job.id);
  assert.equal(first.needsAttention, 1);
  assert.equal(app.paths.filter((pathname) => pathname === '/oauth/authorize').length, 1);
  const ordinary = await app.finish((await app.start(body)).job.id);
  assert.equal(ordinary.needsAttention, 1);
  assert.equal(app.paths.filter((pathname) => pathname === '/oauth/authorize').length, 1);
  scenario.challengeTeam = false;
  const repeated = await app.finish((await app.start({ ...body, retryAccount: true })).job.id);
  assert.equal(repeated.total, 1);
  assert.equal(repeated.succeeded, 1);
  assert.equal(repeated.results[0].id, child.id);
  assert.equal(repeated.results[0].quotaChecked, true);
  assert.equal(app.paths.filter((pathname) => pathname === '/oauth/authorize').length, 2);
  assert.ok(repeated.logs.every((entry) => entry.childId === null || entry.childId === child.id));
  assert.deepEqual((await app.saved()).children.find((entry) => entry.id === ready.id).workspaceTokens, ready.workspaceTokens);
  const requests = app.requests.length;
  const finished = await app.finish((await app.start({ ...body, retryAccount: true })).job.id);
  assert.equal(finished.results[0].reused, true);
  assert.equal(app.requests.length, requests);
});

test('expired saved Team JSON renews its own RT and cached quota without membership calls or browser login', async (t) => {
  const workspaceId = 'fixture-team-workspace';
  const child = { id: 'expired-team-refresh', email: 'expired-team-refresh@example.test', chatgptUserId: 'expired-team-refresh', team: workspaceId,
    workspaceHistory: [{ team: workspaceId, status: 'active', quota5h: 0, quota7d: 64, quotaStatus: 'exhausted', quotaUpdatedAt: '2026-01-01T00:00:00.000Z' }],
    workspaceTokens: { [workspaceId]: { accessToken: token('expired-team-refresh@example.test', 'expired-team-refresh', { workspaceId, plan: 'business', expiresIn: -60 }).access_token, refreshToken: 'private-expired-team-refresh-rt' } },
    teamLoginStates: { [workspaceId]: { workspaceId, status: 'browser_verification_required', code: 'browser_verification_required', needsInput: true, browserRequired: true } },
  };
  const refreshed = token(child.email, child.chatgptUserId, { workspaceId, plan: 'business' });
  const app = await appFixture(t, [child], { mothers: [teamOwner()], roxyEnabled: true,
    responses: { 'private-expired-team-refresh-rt': refreshed } });
  const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother', ids: [child.id], retryAccount: true })).job.id);
  assert.equal(job.succeeded, 1);
  assert.equal(job.results[0].reused, true);
  assert.equal(job.results[0].source, 'stored_team_token');
  assert.equal(job.results[0].quotaCached, true);
  assert.equal(job.results[0].quotaChecked, false);
  assert.equal(job.results[0].quota5h, 0);
  assert.equal(job.results[0].quota7d, 64);
  assert.deepEqual(app.paths, ['/token']);
  assert.equal(app.grants[0].type, 'refresh_token');
  const saved = (await app.saved()).children[0];
  assert.equal(saved.workspaceTokens[workspaceId].accessToken, refreshed.access_token);
  assert.equal(saved.workspaceTokens[workspaceId].refreshToken, refreshed.refresh_token);
  const repeated = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother' })).job.id);
  assert.equal(repeated.total, 0);
  assert.deepEqual(app.paths, ['/token']);
});

test('completed Team callback replaces an expired JSON before trying its invalid old RT', async (t) => {
  const workspaceId = 'fixture-team-workspace';
  const child = { id: 'team-callback-before-refresh', email: 'team-callback-before-refresh@example.test',
    chatgptUserId: 'team-callback-before-refresh', team: workspaceId,
    workspaceHistory: [{ team: workspaceId, status: 'active', role: 'standard-user' }],
    workspaceTokens: { [workspaceId]: { accessToken: token('team-callback-before-refresh@example.test', 'team-callback-before-refresh', { workspaceId, plan: 'team', expiresIn: -60 }).access_token, refreshToken: 'private-invalid-old-team-rt' } },
    teamAuthSessions: { [workspaceId]: { state: 'private-completed-team-state', codeVerifier: 'private-completed-team-verifier',
      callbackReceivedAt: new Date().toISOString(), callbackUrl: 'http://localhost:1455/auth/callback?code=private-completed-team-code&state=private-completed-team-state' } },
    teamLoginStates: { [workspaceId]: { workspaceId, status: 'browser_verification_required', code: 'browser_verification_required', needsInput: true, browserRequired: true } },
  };
  const credentials = token(child.email, child.chatgptUserId, { workspaceId, plan: 'team' });
  const app = await appFixture(t, [child], { mothers: [teamOwner()], roxyEnabled: true,
    responses: { 'private-completed-team-code': credentials },
    teamScenario: { members: [ownerMember(), { id: child.id, email: child.email, role: 'standard-user', seat_type: 'default' }] },
  });
  const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother', ids: [child.id] })).job.id);
  assert.equal(job.succeeded, 1);
  assert.equal(job.results[0].id, child.id);
  assert.equal(job.results[0].quotaChecked, true);
  assert.deepEqual(app.grants, [{ key: 'private-completed-team-code', type: 'authorization_code', verifier: 'private-completed-team-verifier' }]);
  assert.ok(app.paths.includes(`/backend-api/accounts/${workspaceId}/users`));
  assert.ok(!app.paths.some((pathname) => pathname === '/oauth/authorize' || pathname.startsWith('/api/accounts/')));
  assert.ok(!job.logs.some((entry) => /重复浏览器登录|正在启动独立浏览器|正在打开账号绑定/.test(entry.message)));
  const saved = (await app.saved()).children[0];
  assert.equal(saved.workspaceTokens[workspaceId].accessToken, credentials.access_token);
  assert.equal(saved.workspaceTokens[workspaceId].refreshToken, credentials.refresh_token);
  assert.equal(saved.teamAuthSessions[workspaceId], undefined);
  assert.doesNotMatch(JSON.stringify(job), /private-completed-team-code|private-completed-team-verifier|private-invalid-old-team-rt/);
});

test('Team RT failure or a wrong refreshed token preserves prior JSON and never opens a browser', async (t) => {
  const workspaceId = 'fixture-team-workspace';
  for (const scenario of [
    { name: 'invalid-grant' },
    { name: 'upstream-unavailable', tokenStatus: 503 },
    { name: 'wrong-email', email: 'foreign@example.test' },
    { name: 'wrong-subject', subject: 'foreign-user' },
    { name: 'wrong-workspace', workspaceId: 'foreign-workspace' },
    { name: 'wrong-plan', plan: 'free' },
    { name: 'expired-response', expiresIn: -60 },
  ]) await t.test(scenario.name, async (subtest) => {
    const child = { id: 'expired-invalid-refresh', email: 'expired-invalid-refresh@example.test', password: 'private-unused-login-password',
      chatgptUserId: 'expired-invalid-refresh', team: workspaceId, workspaceHistory: [{ team: workspaceId, status: 'active' }],
      workspaceTokens: { [workspaceId]: { accessToken: token('expired-invalid-refresh@example.test', 'expired-invalid-refresh', { workspaceId, plan: 'team', expiresIn: -60 }).access_token, refreshToken: 'private-original-team-rt' } },
    };
    const response = scenario.name === 'invalid-grant' ? null : token(scenario.email || child.email, scenario.subject || child.chatgptUserId,
      { workspaceId: scenario.workspaceId || workspaceId, plan: scenario.plan || 'team', expiresIn: scenario.expiresIn ?? 3600 });
    const app = await appFixture(subtest, [child], { credentialChild: child, mothers: [teamOwner()], roxyEnabled: true,
      responses: { 'private-original-team-rt': response }, tokenStatuses: { 'private-original-team-rt': scenario.tokenStatus } });
    const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother', ids: [child.id] })).job.id);
    assert.equal(job.succeeded, 0);
    assert.equal(job.failed, 1);
    assert.ok(['team_token_refresh_failed', 'team_token_changed', 'token_identity_mismatch', 'team_workspace_mismatch'].includes(job.results[0].code), job.results[0].code);
    assert.deepEqual(app.paths, ['/token']);
    assert.equal(app.grants[0].type, 'refresh_token');
    assert.deepEqual((await app.saved()).children[0].workspaceTokens, child.workspaceTokens);
    assert.doesNotMatch(JSON.stringify(job), /private-original-team-rt|private-fixture-new-rt|private-fixture-signature|upstream-private-message/);
  });
});

test('serial Team batch settles failures once, continues to the next account and explicitly retries only selected failures', async (t) => {
  const workspaceId = 'fixture-team-workspace';
  const selected = { id: 'selected-failure', email: 'selected-failure@example.test', password: 'private-selected-password', team: workspaceId };
  const unrelated = { id: 'uninvited-failure', email: 'uninvited-failure@example.test' };
  const ready = { id: 'already-ready', email: 'already-ready@example.test', team: workspaceId, chatgptUserId: 'already-ready',
    workspaceTokens: { [workspaceId]: { accessToken: token('already-ready@example.test', 'already-ready', { workspaceId, plan: 'team' }).access_token, refreshToken: 'private-ready-rt' } } };
  const scenario = { noMfa: true, challengeTeam: true, members: [ownerMember(), { id: selected.id, email: selected.email, role: 'standard-user', seat_type: 'default' }] };
  const app = await appFixture(t, [selected, unrelated, ready], { credentialChild: selected, mothers: [teamOwner(), { ...teamOwner('other-team'), id: 'other-mother' }], concurrency: 1, roxyEnabled: true, teamScenario: scenario });
  const initial = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother', ids: [selected.id, unrelated.id, ready.id] })).job.id);
  assert.equal(initial.completed, 3);
  assert.equal(initial.needsAttention, 1);
  assert.equal(initial.failed, 1);
  assert.equal(initial.succeeded, 1);
  assert.deepEqual(initial.results.map((result) => result.id), [selected.id, unrelated.id, ready.id]);
  assert.equal(app.paths.filter((pathname) => pathname === '/oauth/authorize').length, 1);
  assert.equal(initial.results[2].reused, true);
  const oldSession = (await app.saved()).children.find((child) => child.id === selected.id).teamAuthSessions[workspaceId];
  assert.ok(oldSession?.state);
  const retryBody = { scope: 'team', motherId: 'fixture-mother', ids: [selected.id], retryFailed: true, retryJobId: initial.id };
  for (const [patch, status, message] of [
    [{ ids: [ready.id] }, 400, 'retry_failed_accounts_only'],
    [{ motherId: 'other-mother' }, 409, 'retry_team_mismatch'],
    [{ retryJobId: 'missing-job' }, 404, 'retry_job_not_found'],
    [{ retryJobId: '' }, 400, 'invalid_retry_request'],
  ]) {
    const rejected = await app.request('/api/children/auto-json', { method: 'POST', body: { ...retryBody, ...patch } });
    assert.equal(rejected.status, status);
    assert.equal(rejected.data.message, message);
  }
  scenario.challengeTeam = false;
  const started = await app.start(retryBody);
  const duplicate = await app.start(retryBody);
  assert.equal(duplicate.job.id, started.job.id);
  assert.equal(duplicate.reused, true);
  const retried = await app.finish(started.job.id);
  assert.equal(retried.retryJobId, initial.id);
  assert.equal(retried.total, 1);
  assert.equal(retried.completed, 1);
  assert.equal(retried.succeeded, 1);
  assert.equal(retried.results[0].id, selected.id);
  assert.equal(retried.results[0].reused, false);
  assert.equal(retried.results[0].quotaChecked, true);
  assert.equal(app.paths.filter((pathname) => pathname === '/oauth/authorize').length, 2);
  assert.equal(app.grants.length, 1);
  assert.equal(app.grants[0].verifier, oldSession.codeVerifier);
  const requestCount = app.requests.length;
  const submittedAgain = await app.start(retryBody);
  assert.equal(submittedAgain.job.id, started.job.id);
  assert.equal(submittedAgain.reused, true);
  assert.equal(app.requests.length, requestCount);
  const overlap = await app.request('/api/children/auto-json', { method: 'POST', body: { ...retryBody, ids: [selected.id, unrelated.id] } });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.data.message, 'retry_already_started');
  const nextFailure = await app.finish((await app.start({ ...retryBody, ids: [unrelated.id] })).job.id);
  assert.equal(nextFailure.completed, 1);
  assert.equal(nextFailure.failed, 1);
  assert.equal(nextFailure.results[0].id, unrelated.id);
  assert.equal(app.requests.length, requestCount);
  const original = (await app.request(`/api/children/auto-json/${initial.id}`)).data.job;
  assert.deepEqual(original.retriedIds.sort(), [selected.id, unrelated.id].sort());
});

test('removed members cannot reuse retained Team JSON and cached quota requires a genuine measured source', async (t) => {
  const workspaceId = 'fixture-team-workspace';
  const makeChild = (id, history) => ({ id, email: `${id}@example.test`, team: workspaceId, chatgptUserId: id,
    workspaceHistory: [{ team: workspaceId, status: 'active', ...history }],
    workspaceTokens: { [workspaceId]: { accessToken: token(`${id}@example.test`, id, { workspaceId, plan: 'team' }).access_token, refreshToken: `private-team-rt-${id}` } },
  });
  const removed = makeChild('removed', { status: 'kicked', removedAt: new Date().toISOString(), reason: 'manual_kick' });
  const defaultQuota = makeChild('default-quota', { quota5h: 100, quota7d: 100 });
  const partialQuota = makeChild('partial-quota', { quota5h: 100, quota7d: 100, quotaUpdatedAt: '2026-01-01T00:00:00.000Z',
    quotaSnapshot: { quotaWindowMapping: 'duration-v1', primary: null, secondary: { usedPercent: 28 }, updatedAt: '2026-01-01T00:00:00.000Z' } });
  const app = await appFixture(t, [removed, defaultQuota, partialQuota], { mothers: [teamOwner()] });
  const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother', ids: [removed.id, defaultQuota.id, partialQuota.id] })).job.id);
  const results = new Map(job.results.map((result) => [result.id, result]));
  assert.equal(results.get(removed.id).status, 'failed');
  assert.equal(results.get(removed.id).code, 'team_not_invited');
  assert.equal(results.get(removed.id).reused, false);
  assert.equal(results.get(defaultQuota.id).status, 'ready');
  assert.equal(results.get(defaultQuota.id).quota5h, null);
  assert.equal(results.get(defaultQuota.id).quota7d, null);
  assert.equal(results.get(defaultQuota.id).quotaStatus, 'unknown');
  assert.equal(results.get(partialQuota.id).status, 'ready');
  assert.equal(results.get(partialQuota.id).quota5h, null);
  assert.equal(results.get(partialQuota.id).quota7d, 72);
  assert.equal(app.requests.length, 0);
});

test('automatic Team jobs never invite unrelated children or accept an invitation for a changed email', async (t) => {
  const children = [{ id: 'unrelated', email: 'unrelated@example.test' }, { id: 'changed-email', email: 'changed@example.test',
    teamInvitations: [{ motherId: 'fixture-mother', workspaceId: 'fixture-team-workspace', status: 'invited', email: 'original@example.test', inviteId: 'private-original-invite' }] }];
  const app = await appFixture(t, children, { mothers: [teamOwner()], teamScenario: { members: [ownerMember()] } });
  const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother', ids: children.map((child) => child.id) })).job.id);
  assert.equal(job.failed, 2);
  assert.equal(job.results.find((item) => item.id === 'unrelated').code, 'team_not_invited');
  assert.equal(job.results.find((item) => item.id === 'changed-email').code, 'invitation_identity_mismatch');
  assert.ok(job.results.every((item) => item.scope === 'team'));
  assert.equal(app.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(job), /private-original-invite/);
});

test('invitations respect the mother configured purchased seat type and recognize existing members without sending', async (t) => {
  const child = { id: 'premium-invite', email: 'premium-invite@example.test' };
  const existing = { id: 'existing-member', email: 'existing-member@example.test' };
  const mother = { ...teamOwner(), defaultSeatType: 'prolite' };
  const app = await appFixture(t, [child, existing], { mothers: [mother], teamScenario: {
    members: [ownerMember(), { id: existing.id, email: existing.email, role: 'standard-user', seat_type: 'default' }],
    subscription: { seats_in_use: 2, seats_entitled: 3, seat_capacity: [{ type: 'default', paid: 2, held: 0 }, { type: 'prolite', paid: 1, held: 0 }], assigned: { default: 2, prolite: 0 } },
  } });
  const response = await app.request('/api/mothers/fixture-mother/invitations', { method: 'POST', body: { childIds: [child.id, existing.id] } });
  assert.equal(response.status, 200);
  assert.equal(response.data.invited, 1);
  assert.equal(response.data.alreadyMember, 1);
  assert.equal((await app.saved()).mothers[0].seatClaims[0].seatType, 'prolite');
  const writes = app.requests.filter((request) => request.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].body).role, 'standard-user');
});

test('Team OAuth cannot save a personal or wrong-workspace token as target Team JSON', async (t) => {
  for (const scenario of [{ workspaceId: 'fixture-team-workspace', plan: 'free' }, { workspaceId: 'other-team', plan: 'team' }]) {
    await t.test(`${scenario.plan}:${scenario.workspaceId}`, async (subtest) => {
      const child = { id: 'oauth-boundary', email: 'oauth-boundary@example.test', password: 'private-boundary-password', totp: 'JBSWY3DPEHPK3PXP', team: 'fixture-team-workspace' };
      const app = await appFixture(subtest, [child], { credentialChild: child, mothers: [teamOwner()], teamScenario: { members: [ownerMember(), { id: child.id, email: child.email, role: 'standard-user' }], teamToken: token(child.email, child.id, scenario) } });
      const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother' })).job.id);
      assert.equal(job.succeeded, 0);
      assert.equal(job.results[0].code, 'team_workspace_mismatch');
      assert.equal(job.results[0].quotaChecked, false);
      assert.equal((await app.saved()).children[0].workspaceTokens['fixture-team-workspace'], undefined);
      assert.ok(!app.paths.includes('/backend-api/wham/usage'));
    });
  }
});

test('newly invited password-only account completes both OAuth logins when the official flow does not require MFA', async (t) => {
  const child = { id: 'no-mfa', email: 'no-mfa@example.test', password: 'private-no-mfa-password' };
  const app = await appFixture(t, [child], { credentialChild: child, mothers: [teamOwner()], teamScenario: { noMfa: true, members: [ownerMember()] } });
  const invitation = await app.request('/api/mothers/fixture-mother/invitations', { method: 'POST', body: { childIds: [child.id] } });
  assert.equal(invitation.data.invited, 1);
  const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother' })).job.id);
  assert.equal(job.succeeded, 1);
  assert.equal(job.results[0].quotaChecked, true);
  assert.deepEqual(app.selectedWorkspaces, [`personal-${child.id}`, 'fixture-team-workspace']);
  assert.equal(app.paths.filter((pathname) => pathname === '/api/accounts/password/verify').length, 2);
  assert.ok(!app.paths.includes('/api/accounts/mfa/verify'));
});

test('Team MFA pauses then reopens browser with original state and PKCE after adding a TOTP secret', async (t) => {
  const child = { id: 'team-mfa-retry', email: 'team-mfa-retry@example.test', password: 'private-mfa-retry-password', team: 'fixture-team-workspace' };
  const app = await appFixture(t, [child], { credentialChild: child, roxyEnabled: true, mothers: [teamOwner()], teamScenario: { members: [ownerMember(), { id: child.id, email: child.email, role: 'standard-user', seat_type: 'default' }] } });
  const body = { scope: 'team', motherId: 'fixture-mother', ids: [child.id] };
  const initial = await app.finish((await app.start(body)).job.id);
  assert.equal(initial.needsAttention, 1);
  assert.equal(initial.results[0].code, 'totp_required');
  assert.equal(initial.results[0].authScope, 'team');
  const session = (await app.saved()).children[0].teamAuthSessions['fixture-team-workspace'];
  assert.ok(session.state && session.codeVerifier);
  assert.equal(session.phase, 'browser_password');
  const authorizeCount = app.paths.filter((pathname) => pathname === '/oauth/authorize').length;
  const paused = await app.finish((await app.start(body)).job.id);
  assert.equal(paused.needsAttention, 1);
  assert.equal(app.paths.filter((pathname) => pathname === '/oauth/authorize').length, authorizeCount);
  await app.request(`/api/children/${child.id}`, { method: 'PATCH', body: { totp: 'JBSWY3DPEHPK3PXP' } });
  const updated = (await app.saved()).children[0];
  assert.deepEqual(updated.teamAuthSessions['fixture-team-workspace'], session);
  assert.equal(updated.teamLoginStates['fixture-team-workspace'].needsInput, false);
  const completed = await app.finish((await app.start(body)).job.id);
  assert.equal(completed.succeeded, 1);
  assert.equal(completed.results[0].quotaChecked, true);
  assert.equal(app.paths.filter((pathname) => pathname === '/oauth/authorize').length, authorizeCount + 1);
  assert.equal(app.grants[0].verifier, session.codeVerifier);
});

test('premium invitation whose confirmed member is standard records a mismatch and stops before Team OAuth', async (t) => {
  const child = { id: 'seat-mismatch', email: 'seat-mismatch@example.test', password: 'private-seat-mismatch-password' };
  const mother = { ...teamOwner(), defaultSeatType: 'prolite' };
  const app = await appFixture(t, [child], { credentialChild: child, mothers: [mother], teamScenario: { noMfa: true, members: [ownerMember()], acceptedSeatType: 'default',
    subscription: { seats_in_use: 1, seats_entitled: 2, seat_capacity: [{ type: 'default', paid: 1, held: 0 }, { type: 'prolite', paid: 1, held: 0 }], assigned: { default: 1, prolite: 0 } } } });
  await app.request('/api/mothers/fixture-mother/invitations', { method: 'POST', body: { childIds: [child.id] } });
  const body = { scope: 'team', motherId: 'fixture-mother' };
  const job = await app.finish((await app.start(body)).job.id);
  assert.equal(job.succeeded, 0);
  assert.equal(job.results[0].code, 'seat_type_mismatch');
  assert.equal(job.results[0].quotaChecked, false);
  assert.deepEqual(app.selectedWorkspaces, [`personal-${child.id}`]);
  const saved = (await app.saved()).children[0];
  assert.equal(saved.workspaceHistory[0].status, 'active');
  assert.equal(saved.workspaceHistory[0].seatType, 'default');
  assert.equal(saved.workspaceHistory[0].requestedSeatType, 'prolite');
  assert.equal(saved.workspaceHistory[0].joinStatus, 'seat_type_mismatch');
  assert.equal(saved.workspaceTokens['fixture-team-workspace'], undefined);
  assert.ok(!app.paths.includes('/backend-api/wham/usage'));
  const retry = await app.finish((await app.start(body)).job.id);
  assert.equal(retry.results[0].code, 'seat_type_mismatch');
  assert.ok(!app.requests.some((request) => ['PATCH', 'DELETE'].includes(request.method) || request.path.includes('/subscriptions/update')));
});

test('invitation preflight does not fall back from a depleted official default seat to another purchased seat type', async (t) => {
  const child = { id: 'no-fallback', email: 'no-fallback@example.test' };
  const app = await appFixture(t, [child], { mothers: [teamOwner()], teamScenario: { members: [ownerMember()],
    subscription: { seats_in_use: 1, seats_entitled: 2, seat_capacity: [{ type: 'default', paid: 1, held: 0 }, { type: 'prolite', paid: 1, held: 0 }], assigned: { default: 1, prolite: 0 } } } });
  const response = await app.request('/api/mothers/fixture-mother/invitations', { method: 'POST', body: { childIds: [child.id] } });
  assert.equal(response.status, 207);
  assert.equal(response.data.results[0].code, 'seat_type_capacity_exhausted');
  assert.ok(!app.requests.some((request) => request.method === 'POST'));
});

test('official OAuth with email only in its ID token binds a consistent subject and rejects conflicting email or subject', async (t) => {
  for (const scenario of [{ name: 'matching', email: 'id-email@example.test', subject: 'id-email', ready: true }, { name: 'wrong-email', email: 'other@example.test', subject: 'id-email', ready: false }, { name: 'wrong-subject', email: 'id-email@example.test', subject: 'different-user', ready: false }]) {
    await t.test(scenario.name, async (subtest) => {
      const child = { id: 'id-email', email: 'id-email@example.test', password: 'private-id-email-password', team: 'fixture-team-workspace' };
      const response = token(child.email, child.id, { workspaceId: 'fixture-team-workspace', plan: 'team' });
      const [header, encoded] = response.access_token.split('.');
      const claims = JSON.parse(Buffer.from(encoded, 'base64url'));
      delete claims['https://api.openai.com/profile'];
      response.access_token = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.private-fixture-signature`;
      response.id_token = token(scenario.email, scenario.subject, { workspaceId: 'fixture-team-workspace', plan: 'team' }).access_token;
      const app = await appFixture(subtest, [child], { credentialChild: child, mothers: [teamOwner()], teamScenario: { noMfa: true, teamToken: response, members: [ownerMember(), { id: child.id, email: child.email, role: 'standard-user', seat_type: 'default' }] } });
      const job = await app.finish((await app.start({ scope: 'team', motherId: 'fixture-mother' })).job.id);
      assert.equal(job.succeeded, scenario.ready ? 1 : 0);
      const saved = (await app.saved()).children[0];
      if (scenario.ready) {
        assert.equal(saved.chatgptUserId, child.id);
        assert.equal(job.results[0].quotaChecked, true);
        assert.equal((await app.request('/api/state')).data.children[0].teamAuthorizations[0].ready, true);
      } else {
        assert.equal(job.results[0].code, 'token_identity_mismatch');
        assert.equal(saved.chatgptUserId, undefined);
        assert.equal(saved.workspaceTokens['fixture-team-workspace'], undefined);
        assert.ok(!app.paths.includes('/backend-api/wham/usage'));
      }
    });
  }
});
