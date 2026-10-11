import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { classifyChallenge, clearOAuthCallback, consumeOAuthCallback, loginFreeAccount, parseValidOAuthCallback, storeOAuthCallback } from './openai-login.mjs';
import { BrowserOAuthError } from './openai-browser-login.mjs';

test('classifies explicit account suspension before generic HTTP 403 verification', () => {
  assert.equal(classifyChallenge('', '{"error":{"code":"account_deactivated","message":"Your account has been deactivated"}}', 403), 'account_banned');
  assert.equal(classifyChallenge('', '{"detail":"account suspended"}', 400), 'account_banned');
  assert.equal(classifyChallenge('', '{"error":"turnstile_required"}', 403), 'protocol_verification_required');
});

function workspaceCookie(workspaces) {
  return `${Buffer.from(JSON.stringify({ workspaces })).toString('base64url')}.signature`;
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

for (const scenario of [
  { name: 'TOTP', page: '/mfa-challenge/fixture-challenge', verify: '/api/accounts/mfa/verify', phase: 'protocol_totp' },
  { name: 'email OTP', page: '/email-verification', verify: '/api/accounts/email-otp/validate', phase: 'waiting_code' },
]) {
  test(`protocol redirects dispatch a normal ${scenario.name} page to its automatic verifier`, async () => {
    const calls = [];
    const progress = [];
    const callback = 'http://localhost:1455/auth/callback?code=fixture-code&state=fixture-redirect-state';
    const result = await loginFreeAccount({
      email: 'member@example.test', password: 'fixture-password', totp: 'JBSWY3DPEHPK3PXP', verificationCode: '123456',
      protocolOnly: true, browserLogin: false,
      session: { state: 'fixture-redirect-state', codeVerifier: 'fixture-verifier', currentUrl: 'https://auth.openai.com/transition' },
      onProgress: (phase) => progress.push(phase),
      fetch: async (input, options = {}) => {
        const path = new URL(input).pathname;
        calls.push(path);
        if (path === '/transition') return new Response('', { status: 302, headers: { location: scenario.page } });
        if (path === scenario.page) return new Response('<html>Verification</html>', { status: 200 });
        if (path === scenario.verify) {
          assert.equal(options.method, 'POST');
          const submitted = JSON.parse(options.body);
          assert.match(submitted.code, /^\d{6}$/);
          if (scenario.name === 'TOTP') assert.deepEqual({ id: submitted.id, type: submitted.type }, { id: 'fixture-challenge', type: 'totp' });
          else assert.equal(submitted.code, '123456');
          return jsonResponse({ continue_url: callback });
        }
        if (path === '/oauth/token') return jsonResponse({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' });
        throw new Error(`Unexpected mock request: ${path}`);
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['/transition', scenario.page, scenario.verify, '/oauth/token']);
    assert.ok(progress.includes(scenario.phase));
  });
}

test('a successful verification-page redirect reaches its callback without demanding a second verification', async () => {
  const calls = [];
  const result = await loginFreeAccount({
    email: 'member@example.test', password: 'fixture-password', protocolOnly: true,
    session: { state: 'fixture-verified-state', codeVerifier: 'fixture-verifier', currentUrl: 'https://auth.openai.com/transition' },
    fetch: async (input) => {
      const path = new URL(input).pathname;
      calls.push(path);
      if (path === '/transition') return new Response('', { status: 302, headers: { location: '/mfa-challenge/already-verified' } });
      if (path === '/mfa-challenge/already-verified') return new Response('', { status: 302, headers: { location: 'http://localhost:1455/auth/callback?code=fixture-code&state=fixture-verified-state' } });
      if (path === '/oauth/token') return jsonResponse({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' });
      throw new Error(`Unexpected mock request: ${path}`);
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['/transition', '/mfa-challenge/already-verified', '/oauth/token']);
});

for (const scenario of [
  { name: 'authorization entry', currentUrl: '', failedPath: '/oauth/authorize' },
  { name: 'workspace page', currentUrl: '/workspace', failedPath: '/sign-in-with-chatgpt/codex/consent' },
  { name: 'workspace selection', currentUrl: '/workspace', failedPath: '/api/accounts/workspace/select' },
  { name: 'TOTP verification', currentUrl: '/mfa-challenge/fixture', failedPath: '/api/accounts/mfa/verify' },
  { name: 'email OTP verification', currentUrl: '/email-verification', failedPath: '/api/accounts/email-otp/validate' },
  { name: 'token exchange', currentUrl: '', failedPath: '/oauth/token', callback: true },
  { name: 'protocol requirements', currentUrl: '/log-in/password', failedPath: '/backend-api/sentinel/req' },
]) {
  test(`HTTP 403 during ${scenario.name} stops once and requests official verification`, async () => {
    const calls = [];
    const result = await loginFreeAccount({
      email: 'member@example.test', password: 'fixture-password', totp: 'JBSWY3DPEHPK3PXP', verificationCode: '123456',
      workspaceMode: 'team', workspaceId: 'fixture-team', protocolOnly: true,
      session: {
        state: 'fixture-forbidden-state', codeVerifier: 'fixture-verifier',
        currentUrl: scenario.currentUrl ? `https://auth.openai.com${scenario.currentUrl}` : '',
        ...(scenario.callback ? { callbackUrl: 'http://localhost:1455/auth/callback?code=fixture-code&state=fixture-forbidden-state' } : {}),
      },
      fetch: async (input) => {
        const path = new URL(input).pathname;
        calls.push(path);
        if (path === scenario.failedPath) return jsonResponse({ error: { code: 'forbidden', message: 'fixture upstream private detail' } }, 403);
        if (path === '/workspace') return new Response('', { status: 200 });
        if (scenario.name === 'workspace selection' && path === '/sign-in-with-chatgpt/codex/consent') return jsonResponse({ workspaces: [{ id: 'fixture-team', kind: 'team' }] });
        throw new Error(`Unexpected mock request: ${path}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.code, 'protocol_verification_required');
    assert.equal(result.browserRequired, true);
    assert.equal(result.needsInput, true);
    assert.equal(calls.filter((path) => path === scenario.failedPath).length, 1);
    assert.equal(calls.at(-1), scenario.failedPath);
    assert.doesNotMatch(result.message, /private detail/);
    if (scenario.name === 'protocol requirements') assert.equal(result.stage, 'protocol_sentinel');
  });
}

test('an explicit account suspension on an MFA endpoint remains an account error', async () => {
  assert.equal(classifyChallenge('https://auth.openai.com/mfa-challenge/fixture', 'account_deactivated', 403), 'account_banned');
  assert.equal(classifyChallenge('https://auth.openai.com/mfa-challenge/fixture', 'Forbidden', 403), 'protocol_verification_required');
  const result = await loginFreeAccount({
    email: 'member@example.test', password: 'fixture-password', totp: 'JBSWY3DPEHPK3PXP', protocolOnly: true,
    session: { state: 'fixture-banned-state', codeVerifier: 'fixture-verifier', currentUrl: 'https://auth.openai.com/mfa-challenge/fixture' },
    fetch: async () => jsonResponse({ error: { code: 'account_deactivated', message: 'Your account has been deactivated' } }, 403),
  });
  assert.equal(result.code, 'account_banned');
  assert.equal(result.browserRequired, false);
  assert.equal(result.needsInput, true);
});

for (const kind of ['JSON', 'embedded JSON']) {
  test(`workspace selection retains an exact Team list from the current workspace page (${kind})`, async () => {
    const selected = [];
    const state = 'fixture-workspace-page-state';
    const workspaces = [{ id: 'fixture-target-team', kind: 'team' }, { id: 'fixture-personal', kind: 'personal' }];
    const result = await loginFreeAccount({
      email: 'member@example.test', password: 'fixture-password', protocolOnly: true, workspaceMode: 'team', workspaceId: 'fixture-target-team',
      authorizationProvider: async () => ({ authUrl: `https://auth.openai.com/oauth/authorize?state=${state}`, state, sessionId: 'fixture-session' }),
      callbackHandler: async () => ({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', claims: { accountId: 'fixture-target-team', planType: 'team' } }),
      fetch: async (input, options = {}) => {
        const path = new URL(input).pathname;
        if (path === '/oauth/authorize') return new Response('', { status: 302, headers: { location: '/workspace' } });
        if (path === '/workspace') return kind === 'JSON'
          ? jsonResponse({ workspaces })
          : new Response(`<script type="application/json">${JSON.stringify({ workspaces })}</script>`, { status: 200 });
        if (path === '/sign-in-with-chatgpt/codex/consent') return new Response('<div id="root"></div>', { status: 200 });
        if (path === '/api/accounts/workspace/select') {
          selected.push(JSON.parse(options.body));
          return jsonResponse({ continue_url: `http://localhost:1455/auth/callback?code=fixture-code&state=${state}` });
        }
        throw new Error(`Unexpected mock request: ${path}`);
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(selected, [{ workspace_id: 'fixture-target-team' }]);
    assert.equal(Object.hasOwn(result.session, 'protocolWorkspaces'), false);
  });
}

test('a password response pointing to a workspace page reads its list before the consent shell', async () => {
  const calls = [];
  const state = 'fixture-password-workspace-state';
  const result = await loginFreeAccount({
    email: 'member@example.test', password: 'fixture-password', protocolOnly: true, workspaceMode: 'team', workspaceId: 'fixture-target',
    session: { state, codeVerifier: 'fixture-verifier', currentUrl: 'https://auth.openai.com/log-in/password' },
    sentinelTokenProvider: async () => 'fixture-sentinel',
    fetch: async (input, options = {}) => {
      const path = new URL(input).pathname;
      calls.push(path);
      if (path === '/api/accounts/password/verify') return jsonResponse({ continue_url: '/workspace' });
      if (path === '/workspace') return jsonResponse({ workspaces: [{ id: 'fixture-target', kind: 'team' }] });
      if (path === '/sign-in-with-chatgpt/codex/consent') return new Response('<div id="root"></div>', { status: 200 });
      if (path === '/api/accounts/workspace/select') {
        assert.deepEqual(JSON.parse(options.body), { workspace_id: 'fixture-target' });
        return jsonResponse({ continue_url: `http://localhost:1455/auth/callback?code=fixture-code&state=${state}` });
      }
      if (path === '/oauth/token') return jsonResponse({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' });
      throw new Error(`Unexpected mock request: ${path}`);
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['/api/accounts/password/verify', '/workspace', '/sign-in-with-chatgpt/codex/consent', '/api/accounts/workspace/select', '/oauth/token']);
});

for (const workspaces of [[{ id: 'fixture-target', kind: 'personal' }], []]) {
test(`a later explicit ${workspaces.length ? 'personal' : 'empty'} workspace list replaces an earlier Team list and stale Cookie`, async () => {
  let selectionCalls = 0;
  const result = await loginFreeAccount({
    email: 'member@example.test', password: 'fixture-password', protocolOnly: true, workspaceMode: 'team', workspaceId: 'fixture-target',
    fetch: async (input) => {
      const path = new URL(input).pathname;
      if (path === '/oauth/authorize') return new Response('', { status: 302, headers: { location: '/workspace', 'set-cookie': `oai-client-auth-session=${workspaceCookie([{ id: 'fixture-target', kind: 'team' }])}` } });
      if (path === '/workspace') return jsonResponse({ workspaces: [{ id: 'fixture-target', kind: 'team' }] });
      if (path === '/sign-in-with-chatgpt/codex/consent') return jsonResponse({ workspaces });
      if (path === '/api/accounts/workspace/select') selectionCalls += 1;
      throw new Error(`Unexpected mock request: ${path}`);
    },
  });
  assert.equal(result.code, 'workspace_list_unavailable');
  assert.equal(selectionCalls, 0);
});
}

test('a renewed OAuth session cannot reuse the previous session workspace page list', async () => {
  let entries = 0;
  let selectionCalls = 0;
  const result = await loginFreeAccount({
    email: 'member@example.test', password: 'fixture-password', protocolOnly: true, workspaceMode: 'team', workspaceId: 'fixture-target',
    sentinelTokenProvider: async () => 'fixture-sentinel',
    fetch: async (input) => {
      const path = new URL(input).pathname;
      if (path === '/oauth/authorize') { entries += 1; return new Response('', { status: 302, headers: { location: '/workspace' } }); }
      if (path === '/workspace') return entries === 1 ? jsonResponse({ workspaces: [{ id: 'fixture-target', kind: 'team' }] }) : new Response('', { status: 200 });
      if (path === '/sign-in-with-chatgpt/codex/consent') return entries === 1 ? new Response('', { status: 302, headers: { location: '/log-in' } }) : new Response('', { status: 200 });
      if (path === '/api/accounts/authorize/continue') return jsonResponse({ error: { code: 'invalid_state' } }, 409);
      if (path === '/api/accounts/workspace/select') selectionCalls += 1;
      throw new Error(`Unexpected mock request: ${path}`);
    },
  });
  assert.equal(entries, 2);
  assert.equal(result.code, 'workspace_list_unavailable');
  assert.equal(selectionCalls, 0);
});

for (const host of ['localhost', '127.0.0.1', '[::1]']) {
  test(`manual callback validation accepts the exact callback path on ${host}`, () => {
    const url = `http://${host}:1455/auth/callback?code=fixture-code&state=fixture-state`;
    assert.equal(parseValidOAuthCallback(`  ${url}  `, 'fixture-state').toString(), url);
  });
}

test('manual callback parsing can check the URL shape without an account session, but still requires callback state', () => {
  const url = 'http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state';
  assert.equal(parseValidOAuthCallback(url).toString(), url);
  assert.equal(parseValidOAuthCallback(url, '').toString(), url);
  assert.throws(() => parseValidOAuthCallback('http://localhost:1455/auth/callback?code=fixture-code'), { code: 'callback_state_mismatch' });
});

for (const scenario of [
  { name: 'malformed URL', url: 'not-a-url', code: 'callback_invalid' },
  { name: 'authorization link', url: 'https://auth.openai.com/oauth/authorize?code=fixture-code&state=fixture-state', code: 'callback_invalid' },
  { name: 'remote host', url: 'http://remote.example.test/auth/callback?code=fixture-code&state=fixture-state', code: 'callback_invalid' },
  { name: 'deceptive localhost prefix', url: 'http://localhost.example.test:1455/auth/callback?code=fixture-code&state=fixture-state', code: 'callback_invalid' },
  { name: 'non-HTTP protocol', url: 'ftp://localhost:1455/auth/callback?code=fixture-code&state=fixture-state', code: 'callback_invalid' },
  { name: 'HTTPS instead of the local HTTP callback', url: 'https://localhost:1455/auth/callback?code=fixture-code&state=fixture-state', code: 'callback_invalid' },
  { name: 'wrong callback path', url: 'http://localhost:1455/auth/callback/extra?code=fixture-code&state=fixture-state', code: 'callback_invalid' },
  { name: 'embedded credentials', url: 'http://user:password@localhost:1455/auth/callback?code=fixture-code&state=fixture-state', code: 'callback_invalid' },
  { name: 'URL fragment', url: 'http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state#fragment', code: 'callback_invalid' },
  { name: 'duplicate authorization codes', url: 'http://localhost:1455/auth/callback?code=fixture-code&code=other-code&state=fixture-state', code: 'callback_invalid' },
  { name: 'duplicate states', url: 'http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state&state=other-state', code: 'callback_invalid' },
  { name: 'missing code', url: 'http://localhost:1455/auth/callback?state=fixture-state', code: 'callback_code_missing' },
  { name: 'blank code', url: 'http://localhost:1455/auth/callback?code=%20&state=fixture-state', code: 'callback_code_missing' },
  { name: 'missing state', url: 'http://localhost:1455/auth/callback?code=fixture-code', code: 'callback_state_mismatch' },
  { name: 'another account state', url: 'http://localhost:1455/auth/callback?code=fixture-code&state=other-state', code: 'callback_state_mismatch' },
  { name: 'state with additional whitespace', url: 'http://localhost:1455/auth/callback?code=fixture-code&state=%20fixture-state%20', code: 'callback_state_mismatch' },
]) {
  test(`manual callback with ${scenario.name} is rejected without requests or replacing the original session`, async (t) => {
    const session = providerCallbackFixture(`invalid-${scenario.name}`);
    session.state = 'fixture-state';
    session.callbackUrl = 'http://localhost:1455/auth/callback?code=fixture-saved-code&state=fixture-state';
    session.currentUrl = session.callbackUrl;
    session.authorization.state = session.state;
    session.authorization.authUrl = 'https://auth.openai.com/oauth/authorize?state=fixture-state';
    const original = structuredClone(session);
    storeOAuthCallback(session.callbackUrl);
    const inboxState = new URL(session.callbackUrl).searchParams.get('state');
    t.after(() => clearOAuthCallback(inboxState));
    let requests = 0;
    let authorizations = 0;
    let exchanges = 0;
    assert.throws(() => parseValidOAuthCallback(scenario.url, session.state), { code: scenario.code });
    const result = await loginFreeAccount({
      session,
      callbackUrl: scenario.url,
      authorizationProvider: async () => { authorizations += 1; throw new Error('must not create a link'); },
      callbackHandler: async () => { exchanges += 1; throw new Error('must not exchange'); },
      fetch: async () => { requests += 1; throw new Error('must not send requests'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, scenario.code);
    assert.equal(result.status, 400);
    assert.equal(requests, 0);
    assert.equal(authorizations, 0);
    assert.equal(exchanges, 0);
    assert.equal(result.authUrl, original.authorization.authUrl);
    assert.deepEqual(result.session, original);
    assert.deepEqual(session, original);
    assert.equal(consumeOAuthCallback(inboxState), original.callbackUrl);
  });
}

test('manual callback without an original session does not create state, PKCE, or an authorization link', async () => {
  const callbackUrl = 'http://localhost:1455/auth/callback?code=fixture-no-session-code&state=fixture-no-session-state';
  let requests = 0;
  let authorizations = 0;
  const result = await loginFreeAccount({
    callbackUrl,
    authorizationProvider: async () => { authorizations += 1; throw new Error('must not create a link'); },
    fetch: async () => { requests += 1; throw new Error('must not send requests'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'callback_session_missing');
  assert.equal(result.status, 409);
  assert.equal(result.authUrl, null);
  assert.equal(result.session, null);
  assert.equal(requests, 0);
  assert.equal(authorizations, 0);
});

test('a stored invalid callback is rejected before updating its timestamp or sending a token request', async () => {
  const session = {
    state: 'stored-invalid-state', codeVerifier: 'fixture-original-verifier',
    callbackUrl: 'https://remote.example.test/auth/callback?code=fixture-code&state=stored-invalid-state',
    callbackReceivedAt: '2026-01-01T00:00:00.000Z',
  };
  const original = structuredClone(session);
  let requests = 0;
  const result = await loginFreeAccount({
    session,
    fetch: async () => { requests += 1; throw new Error('must not send requests'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'callback_invalid');
  assert.equal(result.session.callbackUrl, original.callbackUrl);
  assert.equal(result.session.callbackReceivedAt, original.callbackReceivedAt);
  assert.equal(requests, 0);
  assert.deepEqual(session, original);
});

for (const scenario of [
  {
    name: 'Sub2API OAuth selects the personal workspace for Free JSON',
    workspaceMode: 'free',
    workspaceId: '',
    expectedWorkspaceId: 'personal-account',
  },
  {
    name: 'Sub2API OAuth selects the requested Team workspace for Team JSON',
    workspaceMode: 'team',
    workspaceId: 'team-account',
    expectedWorkspaceId: 'team-account',
  },
]) {
  test(scenario.name, async () => {
    const oauthState = 'state-from-sub2api';
    const callbackUrl = `http://localhost:1455/auth/callback?code=authorization-code&state=${oauthState}`;
    const authUrl = `https://auth.openai.com/oauth/authorize?state=${oauthState}&redirect_uri=${encodeURIComponent('http://localhost:1455/auth/callback')}`;
    const selected = [];
    let providerCalls = 0;
    let callbackCalls = 0;

    const requestFetch = async (input, options = {}) => {
      const url = String(input);
      if (url === authUrl) {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://auth.openai.com/workspace',
            'set-cookie': `oai-client-auth-session=${workspaceCookie([
              { id: 'team-account', kind: 'team' },
              { id: 'personal-account', kind: 'personal' },
            ])}; Path=/; Secure; HttpOnly`,
          },
        });
      }
      if (url === 'https://auth.openai.com/workspace' || url === 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent') {
        return new Response('', { status: 200 });
      }
      if (url === 'https://auth.openai.com/api/accounts/workspace/select') {
        selected.push(JSON.parse(options.body));
        return jsonResponse({ continue_url: callbackUrl });
      }
      throw new Error(`unexpected request: ${options.method || 'GET'} ${url}`);
    };

    const result = await loginFreeAccount({
      email: 'member@example.com',
      password: 'password',
      totp: 'JBSWY3DPEHPK3PXP',
      workspaceMode: scenario.workspaceMode,
      workspaceId: scenario.workspaceId,
      fetch: requestFetch,
      authorizationProvider: async () => {
        providerCalls += 1;
        return {
          source: 'sub2api',
          providerId: 'sub2api-primary',
          authUrl,
          sessionId: 'sub2api-session',
          state: oauthState,
          redirectUri: 'http://localhost:1455/auth/callback',
        };
      },
      callbackHandler: async ({ code, state, authorization }) => {
        callbackCalls += 1;
        assert.equal(code, 'authorization-code');
        assert.equal(state, oauthState);
        assert.equal(authorization.sessionId, 'sub2api-session');
        return {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          idToken: 'id-token',
          claims: { accountId: scenario.expectedWorkspaceId, planType: scenario.workspaceMode },
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(providerCalls, 1);
    assert.equal(callbackCalls, 1);
    assert.deepEqual(selected, [{ workspace_id: scenario.expectedWorkspaceId }]);
    assert.equal(result.session.authorization.providerId, 'sub2api-primary');
  });
}

test('Sub2API callback completion reuses a persisted OAuth session', async () => {
  const result = await loginFreeAccount({
    email: 'member@example.com',
    password: 'password',
    callbackUrl: 'http://localhost:1455/auth/callback?code=authorization-code&state=persisted-state',
    session: {
      state: 'persisted-state',
      currentUrl: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
      authorization: {
        source: 'sub2api',
        providerId: 'sub2api-primary',
        authUrl: 'https://auth.openai.com/oauth/authorize?state=persisted-state',
        sessionId: 'persisted-session',
        state: 'persisted-state',
      },
    },
    callbackHandler: async ({ authorization }) => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      claims: { accountId: 'personal-account', planType: 'free' },
      sub2api: { synced: true, accountId: 42, integrationId: authorization.providerId },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.sub2api.accountId, 42);
  assert.equal(result.sub2api.integrationId, 'sub2api-primary');
});

test('a matching browser callback exchanges the original PKCE code without a stored password or TOTP', async () => {
  const state = 'browser-without-password-state';
  const callbackUrl = `http://localhost:1455/auth/callback?code=fixture-browser-code&state=${state}`;
  assert.equal(storeOAuthCallback(callbackUrl), true);
  assert.equal(consumeOAuthCallback(state), callbackUrl);
  assert.equal(consumeOAuthCallback(state), callbackUrl, 'reading a pending callback must not discard it');
  const requests = [];
  const result = await loginFreeAccount({
    email: 'browser-member@example.test',
    callbackUrl: consumeOAuthCallback(state),
    session: { state, codeVerifier: 'fixture-original-pkce' },
    fetch: async (input, options = {}) => {
      requests.push(String(input));
      assert.equal(options.body.get('grant_type'), 'authorization_code');
      assert.equal(options.body.get('code_verifier'), 'fixture-original-pkce');
      return jsonResponse({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' });
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, ['https://auth.openai.com/oauth/token']);
  assert.equal(consumeOAuthCallback(state), '', 'a successful exchange clears the callback inbox');
  assert.equal(result.session.callbackUrl, '');
});

test('a failed callback exchange remains available and resumes from the persisted session', async () => {
  const state = 'browser-retry-state';
  const callbackUrl = `http://localhost:1455/auth/callback?code=fixture-retry-code&state=${state}`;
  assert.equal(storeOAuthCallback(callbackUrl), true);
  const failed = await loginFreeAccount({
    callbackUrl: consumeOAuthCallback(state),
    session: { state, codeVerifier: 'fixture-retry-pkce' },
    fetch: async () => { throw new TypeError('fixture network failure'); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'network_error');
  assert.equal(consumeOAuthCallback(state), callbackUrl);
  assert.equal(failed.session.callbackUrl, callbackUrl);
  assert.equal(Number.isFinite(Date.parse(failed.session.callbackReceivedAt)), true);
  const callbackReceivedAt = failed.session.callbackReceivedAt;
  const failedAgain = await loginFreeAccount({
    session: failed.session,
    fetch: async () => { throw new TypeError('fixture network failure'); },
  });
  assert.equal(failedAgain.session.callbackReceivedAt, callbackReceivedAt, 'a retry must not extend the callback lifetime');
  clearOAuthCallback(state);
  const resumed = await loginFreeAccount({
    session: failed.session,
    fetch: async (input, options = {}) => {
      assert.equal(String(input), 'https://auth.openai.com/oauth/token');
      assert.equal(options.body.get('code'), 'fixture-retry-code');
      assert.equal(options.body.get('code_verifier'), 'fixture-retry-pkce');
      return jsonResponse({ access_token: 'fixture-retried-access', refresh_token: 'fixture-retried-refresh' });
    },
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.session.callbackUrl, '');
  assert.equal(resumed.session.callbackReceivedAt, '');
});

for (const scenario of [
  { name: 'another account state', state: 'different-account-state' },
  { name: 'a missing callback state', state: '' },
]) {
  test(`a browser callback with ${scenario.name} is rejected without exchanging or discarding the saved callback`, async () => {
    const state = `protected-callback-${scenario.state || 'missing'}`;
    const validCallbackUrl = `http://localhost:1455/auth/callback?code=fixture-protected-code&state=${state}`;
    assert.equal(storeOAuthCallback(validCallbackUrl), true);
    let requested = false;
    const result = await loginFreeAccount({
      callbackUrl: `http://localhost:1455/auth/callback?code=fixture-invalid-code&state=${scenario.state}`,
      session: { state, codeVerifier: 'fixture-protected-pkce' },
      fetch: async () => { requested = true; throw new Error('must not exchange'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'callback_state_mismatch');
    assert.equal(requested, false);
    assert.equal(result.session.callbackUrl, '');
    assert.equal(consumeOAuthCallback(state), validCallbackUrl);
    clearOAuthCallback(state);
  });
}

test('a browser callback without its original PKCE session is rejected before any exchange', async () => {
  let requested = false;
  const result = await loginFreeAccount({
    callbackUrl: 'http://localhost:1455/auth/callback?code=fixture-no-verifier-code&state=fixture-no-verifier-state',
    session: { state: 'fixture-no-verifier-state' },
    fetch: async () => { requested = true; throw new Error('must not exchange'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'callback_session_missing');
  assert.equal(requested, false);
});

test('a failed external callback is preserved rather than replaced by a fresh local authorization', async () => {
  const state = 'external-callback-retry-state';
  const callbackUrl = `http://localhost:1455/auth/callback?code=fixture-external-code&state=${state}`;
  assert.equal(storeOAuthCallback(callbackUrl), true);
  let authorizationCalls = 0;
  const result = await loginFreeAccount({
    callbackUrl,
    session: {
      state,
      authorization: {
        source: 'sub2api', providerId: 'fixture-provider', sessionId: 'fixture-session', state,
        authUrl: `https://auth.openai.com/oauth/authorize?state=${state}`,
      },
    },
    authorizationProvider: async () => { authorizationCalls += 1; throw new Error('must not recreate authorization'); },
    callbackHandler: async () => {
      const error = new Error('fixture exchange unavailable');
      error.code = 'sub2api_oauth_exchange_failed';
      error.status = 503;
      throw error;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'sub2api_oauth_exchange_failed');
  assert.equal(authorizationCalls, 0);
  assert.equal(result.session.callbackUrl, callbackUrl);
  assert.equal(consumeOAuthCallback(state), callbackUrl);
  clearOAuthCallback(state);
});

function providerCallbackFixture(name) {
  const state = `fixture-old-provider-state-${name}`;
  const callbackUrl = `http://localhost:1455/auth/callback?code=fixture-old-code-${name}&state=${state}`;
  return {
    state,
    callbackUrl,
    callbackReceivedAt: new Date(Date.now() - 60_000).toISOString(),
    currentUrl: callbackUrl,
    codeVerifier: `fixture-old-verifier-${name}`,
    deviceId: `fixture-old-device-${name}`,
    cookies: { 'fixture-old-cookie': `fixture-private-cookie-${name}` },
    baselineMailbox: { code: '123456', hash: 'fixture-old-mailbox-hash' },
    authorization: {
      source: 'sub2api', providerId: 'fixture-old-provider', sessionId: `fixture-old-session-${name}`, state,
      authUrl: `https://auth.openai.com/oauth/authorize?state=${state}`,
    },
  };
}

function freshProviderAuthorization(name) {
  const state = `fixture-new-provider-state-${name}`;
  return {
    source: 'sub2api', providerId: 'fixture-new-provider', sessionId: `fixture-new-session-${name}`, state,
    authUrl: `https://auth.openai.com/oauth/authorize?state=${state}`,
  };
}

for (const scenario of [
  { name: 'expired-explicit', code: 'sub2api_oauth_session_expired', input: 'explicit' },
  { name: 'invalid-persisted', code: 'sub2api_oauth_session_invalid', input: 'persisted' },
  { name: 'expired-current-url', code: 'sub2api_oauth_session_expired', input: 'current' },
]) {
  test(`confirmed provider ${scenario.name} discards only its old callback and prepares one fresh authorization without logging in`, async (t) => {
    const session = providerCallbackFixture(scenario.name);
    if (scenario.input !== 'persisted') session.callbackUrl = '';
    const original = structuredClone(session);
    const oldCallback = original.callbackUrl || original.currentUrl;
    const otherCallback = `http://localhost:1455/auth/callback?code=fixture-other-code&state=fixture-other-state-${scenario.name}`;
    const otherState = new URL(otherCallback).searchParams.get('state');
    storeOAuthCallback(oldCallback);
    storeOAuthCallback(otherCallback);
    t.after(() => { clearOAuthCallback(original.state); clearOAuthCallback(otherState); });
    let exchanges = 0;
    let linkCreations = 0;
    let loginRequests = 0;
    const fresh = freshProviderAuthorization(scenario.name);
    const result = await loginFreeAccount({
      email: 'fixture-member@example.test', password: 'fixture-password', totp: 'JBSWY3DPEHPK3PXP',
      session,
      ...(scenario.input === 'explicit' ? { callbackUrl: oldCallback } : {}),
      authorizationProvider: async () => { linkCreations += 1; return fresh; },
      callbackHandler: async ({ code, authorization }) => {
        exchanges += 1;
        assert.equal(code, `fixture-old-code-${scenario.name}`);
        assert.equal(authorization.sessionId, original.authorization.sessionId);
        throw Object.assign(new Error('session not found or expired'), { code: scenario.code, status: 409 });
      },
      fetch: async () => { loginRequests += 1; throw new Error('recovery must not log in'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 202);
    assert.equal(result.code, 'oauth_session_expired');
    assert.equal(result.browserRequired, true);
    assert.equal(result.needsInput, true);
    assert.equal(result.sessionRecovered, true);
    assert.equal(result.authUrl, fresh.authUrl);
    assert.equal(result.session.state, fresh.state);
    assert.equal(result.session.authorization.sessionId, fresh.sessionId);
    assert.deepEqual(result.session.cookies, {});
    assert.equal(result.session.codeVerifier, '');
    assert.equal(result.session.currentUrl, '');
    assert.equal(result.session.callbackUrl, '');
    assert.equal(result.session.callbackReceivedAt, '');
    assert.equal(result.session.baselineMailbox, null);
    assert.notEqual(result.session.deviceId, original.deviceId);
    assert.equal(exchanges, 1);
    assert.equal(linkCreations, 1);
    assert.equal(loginRequests, 0);
    assert.equal(consumeOAuthCallback(original.state), '');
    assert.equal(consumeOAuthCallback(otherState), otherCallback);
    assert.deepEqual(session, original, 'recovery must not mutate the original input session');
    assert.doesNotMatch(JSON.stringify(result), /fixture-old-code|fixture-old-session|fixture-old-verifier|fixture-private-cookie/);
  });
}

for (const scenario of [
  { name: 'timeout', code: 'network_timeout', status: 504 },
  { name: 'rate-limit', code: 'sub2api_oauth_exchange_failed', status: 429 },
  { name: 'server-error', code: 'sub2api_oauth_exchange_failed', status: 503 },
  { name: 'identity-conflict', code: 'token_identity_mismatch', status: 409 },
]) {
  test(`provider callback ${scenario.name} retains its original callback timestamp and never prepares a new link`, async (t) => {
    const session = providerCallbackFixture(scenario.name);
    const original = structuredClone(session);
    storeOAuthCallback(session.callbackUrl);
    t.after(() => clearOAuthCallback(session.state));
    let exchanges = 0;
    let linkCreations = 0;
    const result = await loginFreeAccount({
      session,
      authorizationProvider: async () => { linkCreations += 1; return freshProviderAuthorization(scenario.name); },
      callbackHandler: async () => {
        exchanges += 1;
        throw Object.assign(new Error(`fixture ${scenario.name}`), { code: scenario.code, status: scenario.status });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, scenario.code);
    assert.equal(result.status, scenario.status);
    assert.equal(result.session.callbackUrl, original.callbackUrl);
    assert.equal(result.session.callbackReceivedAt, original.callbackReceivedAt);
    assert.equal(result.session.authorization.sessionId, original.authorization.sessionId);
    assert.equal(consumeOAuthCallback(session.state), original.callbackUrl);
    assert.equal(exchanges, 1);
    assert.equal(linkCreations, 0);
    assert.deepEqual(session, original);
  });
}

test('a renewed provider authorization completes only its new matching callback without another link request', async (t) => {
  const session = providerCallbackFixture('renewed-success');
  const fresh = freshProviderAuthorization('renewed-success');
  storeOAuthCallback(session.callbackUrl);
  t.after(() => { clearOAuthCallback(session.state); clearOAuthCallback(fresh.state); });
  let exchanges = 0;
  let linkCreations = 0;
  const authorizationProvider = async () => { linkCreations += 1; return fresh; };
  const callbackHandler = async ({ code, authorization }) => {
    exchanges += 1;
    if (authorization.sessionId === session.authorization.sessionId) {
      throw Object.assign(new Error('session not found or expired'), { code: 'sub2api_oauth_session_expired', status: 409 });
    }
    assert.equal(authorization.sessionId, fresh.sessionId);
    assert.equal(code, 'fixture-new-success-code');
    return { accessToken: 'fixture-renewed-access', refreshToken: 'fixture-renewed-refresh' };
  };
  const renewed = await loginFreeAccount({ session, authorizationProvider, callbackHandler });
  const callbackUrl = `http://localhost:1455/auth/callback?code=fixture-new-success-code&state=${fresh.state}`;
  storeOAuthCallback(callbackUrl);
  const completed = await loginFreeAccount({
    session: renewed.session, callbackUrl: consumeOAuthCallback(fresh.state), authorizationProvider, callbackHandler,
    fetch: async () => { throw new Error('callback completion must not request password login'); },
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.accessToken, 'fixture-renewed-access');
  assert.equal(completed.session.callbackUrl, '');
  assert.equal(completed.session.callbackReceivedAt, '');
  assert.equal(exchanges, 2, 'one old exchange and one new exchange');
  assert.equal(linkCreations, 1);
  assert.equal(consumeOAuthCallback(session.state), '');
  assert.equal(consumeOAuthCallback(fresh.state), '');
});

test('a provider callback state mismatch never creates a fresh authorization or discards the account callback', async (t) => {
  const session = providerCallbackFixture('state-conflict');
  const original = structuredClone(session);
  storeOAuthCallback(session.callbackUrl);
  t.after(() => clearOAuthCallback(session.state));
  let exchanges = 0;
  let linkCreations = 0;
  const result = await loginFreeAccount({
    session,
    callbackUrl: 'http://localhost:1455/auth/callback?code=fixture-wrong-code&state=fixture-wrong-state',
    authorizationProvider: async () => { linkCreations += 1; return freshProviderAuthorization('state-conflict'); },
    callbackHandler: async () => { exchanges += 1; throw new Error('must not exchange'); },
  });
  assert.equal(result.code, 'callback_state_mismatch');
  assert.equal(exchanges, 0);
  assert.equal(linkCreations, 0);
  assert.equal(consumeOAuthCallback(session.state), original.callbackUrl);
  assert.deepEqual(session, original);
});

for (const scenario of [
  { name: 'provider-failed', code: 'sub2api_oauth_url_failed', status: 503 },
  { name: 'invalid-url', code: 'oauth_provider_response_invalid', status: 502 },
  { name: 'reused-session', code: 'oauth_provider_response_invalid', status: 502 },
]) {
  test(`expired provider recovery ${scenario.name} returns the real link failure with an empty session and cannot revive the old code`, async (t) => {
    const session = providerCallbackFixture(scenario.name);
    const original = structuredClone(session);
    storeOAuthCallback(session.callbackUrl);
    t.after(() => clearOAuthCallback(session.state));
    let exchanges = 0;
    let linkCreations = 0;
    const result = await loginFreeAccount({
      session,
      authorizationProvider: async () => {
        linkCreations += 1;
        if (scenario.name === 'provider-failed') throw Object.assign(new Error('fixture provider temporarily unavailable'), { code: scenario.code, status: scenario.status });
        if (scenario.name === 'reused-session') return original.authorization;
        return { ...freshProviderAuthorization(scenario.name), authUrl: 'https://untrusted.example.test/oauth/authorize?state=wrong' };
      },
      callbackHandler: async () => {
        exchanges += 1;
        throw Object.assign(new Error('session not found or expired'), { code: 'sub2api_oauth_session_expired', status: 409 });
      },
      fetch: async () => { throw new Error('must not restart password login'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, scenario.code);
    assert.equal(result.status, scenario.status);
    assert.equal(result.authUrl, null);
    assert.equal(result.browserRequired, false);
    assert.equal(result.sessionRecovered, false);
    assert.equal(result.session.state, '');
    assert.equal(result.session.codeVerifier, '');
    assert.equal(result.session.authorization, null);
    assert.equal(result.session.currentUrl, '');
    assert.equal(result.session.callbackUrl, '');
    assert.equal(result.session.callbackReceivedAt, '');
    assert.deepEqual(result.session.cookies, {});
    assert.equal(consumeOAuthCallback(session.state), '');
    assert.equal(exchanges, 1);
    assert.equal(linkCreations, 1);
    assert.deepEqual(session, original);
    assert.doesNotMatch(JSON.stringify(result), /fixture-old-code|fixture-old-session|fixture-old-verifier|fixture-private-cookie/);
  });
}

test('an expired external session without its provider cannot silently switch to local OAuth', async (t) => {
  const session = providerCallbackFixture('missing-provider');
  storeOAuthCallback(session.callbackUrl);
  t.after(() => clearOAuthCallback(session.state));
  let requests = 0;
  const result = await loginFreeAccount({
    session,
    callbackHandler: async () => {
      throw Object.assign(new Error('session not found or expired'), { code: 'sub2api_oauth_session_expired', status: 409 });
    },
    fetch: async () => { requests += 1; throw new Error('must not enter local OAuth'); },
  });
  assert.equal(result.code, 'oauth_provider_unavailable');
  assert.equal(result.status, 409);
  assert.equal(result.authUrl, null);
  assert.equal(result.session.state, '');
  assert.equal(result.session.codeVerifier, '');
  assert.equal(result.session.authorization, null);
  assert.equal(result.session.callbackUrl, '');
  assert.equal(consumeOAuthCallback(session.state), '');
  assert.equal(requests, 0);
});

test('stale persisted login session is discarded and retried from a fresh OAuth authorization', async () => {
  let passwordAttempts = 0;
  let authorizationAttempts = 0;
  let exchanged = false;
  const requestFetch = async (input) => {
    const url = String(input);
    if (url === 'https://auth.openai.com/api/accounts/password/verify') {
      passwordAttempts += 1;
      return jsonResponse({ error: { code: 'signin_session_invalid', message: 'Your sign-in session is no longer valid. Please start over to continue.' } }, 400);
    }
    if (url.startsWith('https://auth.openai.com/oauth/authorize?')) {
      authorizationAttempts += 1;
      const state = new URL(url).searchParams.get('state');
      return new Response('', { status: 302, headers: { location: `http://localhost:1455/auth/callback?code=fresh-code&state=${state}` } });
    }
    if (url === 'https://auth.openai.com/oauth/token') {
      exchanged = true;
      return jsonResponse({ access_token: 'fresh-access-token', refresh_token: 'fresh-refresh-token', id_token: 'fresh-id-token' });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await loginFreeAccount({
    email: 'member@example.com',
    password: 'password',
    totp: 'JBSWY3DPEHPK3PXP',
    fetch: requestFetch,
    sentinelTokenProvider: async () => 'sentinel-token',
    session: { currentUrl: 'https://auth.openai.com/log-in/password' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionRecovered, true);
  assert.equal(passwordAttempts, 1);
  assert.equal(authorizationAttempts, 1);
  assert.equal(exchanged, true);
  assert.equal(result.accessToken, 'fresh-access-token');
});

test('Sub2API OAuth URL failure falls back to the local PKCE authorization flow', async () => {
  let providerCalls = 0;
  let localAuthorizationCalls = 0;
  let tokenExchangeCalls = 0;
  let callbackHandlerCalls = 0;
  let localOAuthState = '';
  const selected = [];
  const teamAccessToken = `header.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'team-account',
      chatgpt_plan_type: 'team',
    },
  })).toString('base64url')}.signature`;
  const requestFetch = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith('https://auth.openai.com/oauth/authorize?')) {
      localAuthorizationCalls += 1;
      const authorization = new URL(url);
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(authorization.searchParams.get('code_challenge'));
      localOAuthState = authorization.searchParams.get('state');
      return new Response('', {
        status: 302,
        headers: {
          location: 'https://auth.openai.com/workspace',
          'set-cookie': `oai-client-auth-session=${workspaceCookie([
            { id: 'team-account', kind: 'team' },
            { id: 'personal-account', kind: 'personal' },
          ])}; Path=/; Secure; HttpOnly`,
        },
      });
    }
    if (url === 'https://auth.openai.com/workspace' || url === 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent') {
      return new Response('', { status: 200 });
    }
    if (url === 'https://auth.openai.com/api/accounts/workspace/select') {
      selected.push(JSON.parse(options.body));
      return jsonResponse({ continue_url: `http://localhost:1455/auth/callback?code=local-code&state=${localOAuthState}` });
    }
    if (url === 'https://auth.openai.com/oauth/token') {
      tokenExchangeCalls += 1;
      return jsonResponse({
        access_token: teamAccessToken,
        refresh_token: 'local-refresh-token',
        id_token: 'local-id-token',
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await loginFreeAccount({
    email: 'member@example.com',
    password: 'password',
    totp: 'JBSWY3DPEHPK3PXP',
    workspaceMode: 'team',
    workspaceId: 'team-account',
    fetch: requestFetch,
    authorizationProvider: async () => {
      providerCalls += 1;
      const error = new Error('Invalid admin API key');
      error.code = 'sub2api_oauth_url_failed';
      error.status = 401;
      throw error;
    },
    callbackHandler: async () => {
      callbackHandlerCalls += 1;
      throw new Error('Sub2API callback must not run after local OAuth fallback');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.accessToken, teamAccessToken);
  assert.equal(result.refreshToken, 'local-refresh-token');
  assert.equal(result.claims.accountId, 'team-account');
  assert.equal(result.oauthFallback?.code, 'sub2api_oauth_url_failed');
  assert.equal(result.oauthFallback?.message, 'Invalid admin API key');
  assert.equal(providerCalls, 1);
  assert.equal(localAuthorizationCalls, 1);
  assert.equal(tokenExchangeCalls, 1);
  assert.equal(callbackHandlerCalls, 0);
  assert.deepEqual(selected, [{ workspace_id: 'team-account' }]);
  assert.equal(result.session.authorization, null);
});

test('workspace selection accepts structured workspace data returned by the consent page', async () => {
  const selected = [];
  const callbackUrl = 'http://localhost:1455/auth/callback?code=consent-code&state=consent-state';
  const authUrl = 'https://auth.openai.com/oauth/authorize?state=consent-state&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';
  const requestFetch = async (input, options = {}) => {
    const url = String(input);
    if (url === authUrl) return new Response('', { status: 302, headers: { location: 'https://auth.openai.com/workspace' } });
    if (url === 'https://auth.openai.com/workspace') {
      return new Response('<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"workspaces":[{"workspace_id":"team-from-page","type":"team"}]}}}</script>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url === 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent') {
      return new Response('<script type="application/json">{"workspaces":[{"id":"team-from-consent","kind":"team"}]}</script>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url === 'https://auth.openai.com/api/accounts/workspace/select') {
      selected.push(JSON.parse(options.body));
      return jsonResponse({ continue_url: callbackUrl });
    }
    throw new Error(`unexpected request: ${options.method || 'GET'} ${url}`);
  };
  const result = await loginFreeAccount({
    email: 'member@example.com', password: 'password', workspaceMode: 'team', workspaceId: 'team-from-consent', fetch: requestFetch,
    authorizationProvider: async () => ({ authUrl, state: 'consent-state', sessionId: 'consent-session' }),
    callbackHandler: async () => ({ accessToken: 'access-token', refreshToken: 'refresh-token', claims: { accountId: 'team-from-consent', planType: 'team' } }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(selected, [{ workspace_id: 'team-from-consent' }]);
});

for (const scenario of [
  { name: 'missing workspace data does not trigger an unverified selection', payload: {}, expectedCode: 'workspace_list_unavailable' },
  { name: 'a different Team is never substituted for the requested Team', payload: { workspaces: [{ id: 'another-team', kind: 'team' }] }, expectedCode: 'workspace_list_unavailable' },
  { name: 'an organization ID is not treated as a workspace ID', payload: { organizations: [{ id: 'target-team', kind: 'team' }] }, expectedCode: 'workspace_list_unavailable' },
  { name: 'a known personal workspace cannot be selected as a Team', payload: { workspaces: [{ id: 'target-team', kind: 'personal' }] }, expectedCode: 'workspace_list_unavailable' },
]) {
  test(scenario.name, async () => {
    const authUrl = 'https://auth.openai.com/oauth/authorize?state=negative-state';
    let selectionCalls = 0;
    let consentCalls = 0;
    const requestFetch = async (input) => {
      const url = String(input);
      if (url === authUrl) return new Response('', { status: 302, headers: { location: 'https://auth.openai.com/workspace' } });
      if (url === 'https://auth.openai.com/workspace') return new Response('', { status: 200 });
      if (url === 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent') {
        consentCalls += 1;
        return jsonResponse(scenario.payload);
      }
      if (url === 'https://auth.openai.com/api/accounts/workspace/select') {
        selectionCalls += 1;
        throw new Error('unverified workspace selection must not run');
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const result = await loginFreeAccount({
      email: 'member@example.com', password: 'password', workspaceMode: 'team', workspaceId: 'target-team', fetch: requestFetch,
      authorizationProvider: async () => ({ authUrl, state: 'negative-state', sessionId: 'negative-session' }),
      callbackHandler: async () => { throw new Error('unverified callback must not run'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, scenario.expectedCode);
    assert.equal(result.needsInput, true);
    assert.equal(result.browserRequired, true);
    assert.equal(result.authUrl, authUrl);
    assert.equal(selectionCalls, 0);
    assert.equal(consentCalls, 1, 'official verification must pause without retrying the same incomplete consent response');
  });
}

test('a consent response can set the workspace Cookie before selection', async () => {
  const selected = [];
  const authUrl = 'https://auth.openai.com/oauth/authorize?state=late-cookie-state';
  const requestFetch = async (input, options = {}) => {
    const url = String(input);
    if (url === authUrl) return new Response('', { status: 302, headers: { location: 'https://auth.openai.com/workspace' } });
    if (url === 'https://auth.openai.com/workspace') return new Response('', { status: 200 });
    if (url === 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent') return new Response('', { status: 200, headers: { 'set-cookie': `oai-client-auth-session=${workspaceCookie([{ id: 'target-team', kind: 'team' }])}; Path=/` } });
    if (url === 'https://auth.openai.com/api/accounts/workspace/select') {
      selected.push(JSON.parse(options.body));
      return jsonResponse({ continue_url: 'http://localhost:1455/auth/callback?code=late-cookie-code&state=late-cookie-state' });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const result = await loginFreeAccount({
    email: 'member@example.com', password: 'password', workspaceMode: 'team', workspaceId: 'target-team', fetch: requestFetch,
    authorizationProvider: async () => ({ authUrl, state: 'late-cookie-state', sessionId: 'late-cookie-session' }),
    callbackHandler: async () => ({ accessToken: 'access-token', refreshToken: 'refresh-token', claims: { accountId: 'target-team', planType: 'team' } }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(selected, [{ workspace_id: 'target-team' }]);
});

for (const workspaceMode of ['team', 'free']) {
  test(`automatic ${workspaceMode} browser login reuses original state and PKCE and exchanges only its callback`, async () => {
    const originalState = `fixture-browser-${workspaceMode}-state`;
    const originalVerifier = `fixture-browser-${workspaceMode}-verifier`;
    const originalSession = { state: originalState, codeVerifier: originalVerifier };
    const original = structuredClone(originalSession);
    const browserProxy = { server: 'http://127.0.0.1:8089', username: 'fixture-user', password: 'fixture-proxy-password' };
    const progress = [];
    let browserCalls = 0;
    let exchangeCalls = 0;
    const result = await loginFreeAccount({
      email: ' Browser-Member@example.test ', password: 'fixture-password', totp: 'JBSWY3DPEHPK3PXP',
      workspaceMode, workspaceId: workspaceMode === 'team' ? 'fixture-target-team' : '',
      browserLogin: true, session: originalSession, browserProxy,
      onProgress: (phase, message) => progress.push({ phase, message }),
      browserOAuth: async (settings) => {
        browserCalls += 1;
        const authorization = new URL(settings.authUrl);
        assert.equal(authorization.origin, 'https://auth.openai.com');
        assert.equal(authorization.pathname, '/oauth/authorize');
        assert.equal(authorization.searchParams.get('state'), originalState);
        assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(authorization.searchParams.get('code_challenge'), createHash('sha256').update(originalVerifier).digest('base64url'));
        assert.equal(settings.expectedState, originalState);
        assert.equal(settings.redirectUri, 'http://localhost:1455/auth/callback');
        assert.equal(settings.email, 'browser-member@example.test');
        assert.equal(settings.password, 'fixture-password');
        assert.equal(settings.workspaceMode, workspaceMode);
        assert.equal(settings.workspaceId, workspaceMode === 'team' ? 'fixture-target-team' : '');
        assert.deepEqual(settings.proxy, browserProxy);
        assert.match(await settings.getTotpCode(), /^\d{6}$/);
        settings.onProgress('browser_totp', '提交当前 2FA 验证码');
        settings.onProgress('browser_workspace', '选择目标工作空间');
        return { callbackUrl: `http://localhost:1455/auth/callback?code=fixture-browser-code&state=${originalState}` };
      },
      fetch: async (url, settings) => {
        assert.equal(String(url), 'https://auth.openai.com/oauth/token', 'browser primary must not request protocol credential endpoints');
        exchangeCalls += 1;
        const form = new URLSearchParams(settings.body);
        assert.equal(form.get('code'), 'fixture-browser-code');
        assert.equal(form.get('code_verifier'), originalVerifier);
        assert.equal(form.get('redirect_uri'), 'http://localhost:1455/auth/callback');
        return jsonResponse({ access_token: 'fixture-browser-access', refresh_token: 'fixture-browser-refresh' });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.accessToken, 'fixture-browser-access');
    assert.equal(result.refreshToken, 'fixture-browser-refresh');
    assert.equal(result.session.state, originalState);
    assert.equal(result.session.codeVerifier, originalVerifier);
    assert.equal(result.session.callbackUrl, '');
    assert.equal(browserCalls, 1);
    assert.equal(exchangeCalls, 1);
    assert.deepEqual(originalSession, original);
    assert.ok(progress.some((entry) => entry.phase === 'browser_totp'));
    assert.ok(progress.some((entry) => entry.phase === 'browser_workspace'));
    assert.doesNotMatch(JSON.stringify(progress), /fixture-password|JBSWY3DPEHPK3PXP/);
  });
}

test('automatic provider browser login uses the exact provider state and callback handler without protocol login', async () => {
  const state = 'fixture-provider-browser-state';
  const authUrl = `https://auth.openai.com/oauth/authorize?state=${state}&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback`;
  let authorizations = 0;
  let browsers = 0;
  let exchanges = 0;
  const result = await loginFreeAccount({
    browserLogin: true, email: 'fixture@example.test', password: 'fixture-password',
    workspaceMode: 'team', workspaceId: 'fixture-target-team',
    authorizationProvider: async () => {
      authorizations += 1;
      return { authUrl, state, sessionId: 'fixture-provider-browser-session', source: 'sub2api', providerId: 'fixture-provider' };
    },
    browserOAuth: async (settings) => {
      browsers += 1;
      assert.equal(settings.authUrl, authUrl);
      assert.equal(settings.expectedState, state);
      assert.equal(settings.redirectUri, 'http://localhost:1455/auth/callback');
      assert.equal(settings.workspaceId, 'fixture-target-team');
      return { callbackUrl: `http://localhost:1455/auth/callback?code=fixture-provider-browser-code&state=${state}` };
    },
    callbackHandler: async ({ code, state: callbackState, authorization }) => {
      exchanges += 1;
      assert.equal(code, 'fixture-provider-browser-code');
      assert.equal(callbackState, state);
      assert.equal(authorization.sessionId, 'fixture-provider-browser-session');
      return { accessToken: 'fixture-provider-browser-access', refreshToken: 'fixture-provider-browser-refresh' };
    },
    fetch: async () => { throw new Error('provider browser flow must not call protocol login or local exchange'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.accessToken, 'fixture-provider-browser-access');
  assert.equal(result.session.state, state);
  assert.equal(result.session.codeVerifier, '');
  assert.equal(authorizations, 1);
  assert.equal(browsers, 1);
  assert.equal(exchanges, 1);
});

for (const input of ['explicit', 'persisted', 'current-url']) {
  test(`completed ${input} callback takes priority over automatic browser login without credentials`, async () => {
    const state = `fixture-browser-priority-${input}`;
    const callbackUrl = `http://localhost:1455/auth/callback?code=fixture-priority-code&state=${state}`;
    const session = { state, codeVerifier: 'fixture-priority-verifier' };
    if (input === 'persisted') session.callbackUrl = callbackUrl;
    if (input === 'current-url') session.currentUrl = callbackUrl;
    let browsers = 0;
    let exchanges = 0;
    const result = await loginFreeAccount({
      browserLogin: true, session, ...(input === 'explicit' ? { callbackUrl } : {}),
      browserOAuth: async () => { browsers += 1; throw new Error('must not log in again'); },
      fetch: async (url, settings) => {
        exchanges += 1;
        assert.equal(String(url), 'https://auth.openai.com/oauth/token');
        assert.equal(new URLSearchParams(settings.body).get('code_verifier'), 'fixture-priority-verifier');
        return jsonResponse({ access_token: 'fixture-priority-access', refresh_token: 'fixture-priority-refresh' });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(browsers, 0);
    assert.equal(exchanges, 1);
  });
}

test('automatic browser callback state mismatch never exchanges code or creates another browser session', async () => {
  const state = 'fixture-browser-wrong-state';
  let browsers = 0;
  let exchanges = 0;
  const result = await loginFreeAccount({
    browserLogin: true, email: 'fixture@example.test', password: 'fixture-password',
    session: { state, codeVerifier: 'fixture-wrong-state-verifier' }, workspaceMode: 'team', workspaceId: 'fixture-team',
    browserOAuth: async () => {
      browsers += 1;
      return { callbackUrl: 'http://localhost:1455/auth/callback?code=fixture-wrong-code&state=another-state' };
    },
    fetch: async () => { exchanges += 1; throw new Error('must not exchange a conflicting callback'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'callback_state_mismatch');
  assert.equal(result.status, 400);
  assert.equal(result.session.state, state);
  assert.equal(result.session.callbackUrl, '');
  assert.equal(browsers, 1);
  assert.equal(exchanges, 0);
});

test('official browser security challenge preserves safe code, status, input flags and original OAuth session', async () => {
  const state = 'fixture-browser-challenge-state';
  const originalSession = { state, codeVerifier: 'fixture-browser-challenge-verifier' };
  const original = structuredClone(originalSession);
  let browsers = 0;
  let requests = 0;
  const result = await loginFreeAccount({
    browserLogin: true, email: 'fixture@example.test', password: 'fixture-password',
    session: originalSession, workspaceMode: 'team', workspaceId: 'fixture-team',
    browserOAuth: async ({ onProgress }) => {
      browsers += 1;
      onProgress('browser_password', '在官方页面提交密码');
      onProgress('roxy_window_left_open', '有头窗口保留供检查');
      throw new BrowserOAuthError('browser_oauth_verification_required', { status: 403 });
    },
    fetch: async () => { requests += 1; throw new Error('challenge must not retry through the protocol'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'browser_oauth_verification_required');
  assert.equal(result.status, 403);
  assert.equal(result.browserRequired, true);
  assert.equal(result.needsInput, true);
  assert.equal(result.stage, 'browser_password');
  assert.equal(result.session.state, state);
  assert.equal(result.session.codeVerifier, originalSession.codeVerifier);
  assert.equal(new URL(result.authUrl).searchParams.get('state'), state);
  assert.equal(browsers, 1);
  assert.equal(requests, 0);
  assert.deepEqual(originalSession, original);
  assert.doesNotMatch(result.message, /fixture-password/);
});

test('external provider failure falls back to a fresh browser PKCE flow with the same target Team', async () => {
  let providerCalls = 0;
  let browserCalls = 0;
  let localExchanges = 0;
  let providerExchanges = 0;
  let browserState = '';
  let challenge = '';
  const result = await loginFreeAccount({
    browserLogin: true, email: 'fixture@example.test', password: 'fixture-password', totp: 'JBSWY3DPEHPK3PXP',
    workspaceMode: 'team', workspaceId: 'fixture-target-team',
    authorizationProvider: async () => {
      providerCalls += 1;
      throw Object.assign(new Error('fixture provider unavailable'), { code: 'sub2api_oauth_url_failed', status: 503 });
    },
    browserOAuth: async (settings) => {
      browserCalls += 1;
      const authorization = new URL(settings.authUrl);
      browserState = authorization.searchParams.get('state');
      challenge = authorization.searchParams.get('code_challenge');
      assert.ok(browserState);
      assert.ok(challenge);
      assert.equal(settings.expectedState, browserState);
      assert.equal(settings.workspaceMode, 'team');
      assert.equal(settings.workspaceId, 'fixture-target-team');
      assert.match(await settings.getTotpCode(), /^\d{6}$/);
      return { callbackUrl: `http://localhost:1455/auth/callback?code=fixture-fallback-browser-code&state=${browserState}` };
    },
    callbackHandler: async () => { providerExchanges += 1; throw new Error('unavailable provider must not exchange local callback'); },
    fetch: async (url, settings) => {
      localExchanges += 1;
      assert.equal(String(url), 'https://auth.openai.com/oauth/token', 'fallback must not resume protocol password login');
      const form = new URLSearchParams(settings.body);
      assert.equal(form.get('code'), 'fixture-fallback-browser-code');
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge);
      return jsonResponse({ access_token: 'fixture-fallback-browser-access', refresh_token: 'fixture-fallback-browser-refresh' });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.accessToken, 'fixture-fallback-browser-access');
  assert.equal(result.session.state, browserState);
  assert.equal(result.session.authorization, null);
  assert.equal(result.oauthFallback.code, 'sub2api_oauth_url_failed');
  assert.equal(providerCalls, 1);
  assert.equal(browserCalls, 1);
  assert.equal(localExchanges, 1);
  assert.equal(providerExchanges, 0);
});

test('single-attempt Roxy may recover a disconnected link provider before its only browser login', async () => {
  let browserCalls = 0;
  let providerCalls = 0;
  const phases = [];
  const result = await loginFreeAccount({
    singleAttempt: true, allowLocalAuthorizationFallback: true, browserLogin: true,
    email: 'fixture@example.test', password: 'fixture-password', workspaceMode: 'team', workspaceId: 'target-team',
    authorizationProvider: async () => { providerCalls += 1; throw Object.assign(new Error('fixture reset'), { code: 'ECONNRESET' }); },
    callbackHandler: async () => { assert.fail('local callback cannot use the failed remote provider'); },
    browserOAuth: async (options) => {
      browserCalls += 1;
      assert.equal(options.workspaceMode, 'team');
      assert.equal(options.workspaceId, 'target-team');
      assert.ok(new URL(options.authUrl).searchParams.get('code_challenge'));
      return { callbackUrl: `http://localhost:1455/auth/callback?code=fixture-local-code&state=${options.expectedState}` };
    },
    fetch: async (url) => {
      assert.equal(new URL(url).pathname, '/oauth/token');
      return jsonResponse({ access_token: 'fixture-local-access', refresh_token: 'fixture-local-refresh' });
    },
    onProgress: (phase) => phases.push(phase),
  });
  assert.equal(result.ok, true);
  assert.equal(browserCalls, 1);
  assert.equal(providerCalls, 1);
  assert.equal(result.oauthFallback.code, 'ECONNRESET');
  assert.ok(phases.includes('oauth_local_fallback'));
});

test('single-attempt batch login stops at provider failure without starting fallback authorization', async () => {
  let providerCalls = 0;
  let browserCalls = 0;
  let requests = 0;
  const result = await loginFreeAccount({
    singleAttempt: true, browserLogin: true, email: 'fixture@example.test', password: 'fixture-password',
    workspaceMode: 'team', workspaceId: 'fixture-target-team',
    authorizationProvider: async () => {
      providerCalls += 1;
      throw Object.assign(new Error('fixture provider unavailable'), { code: 'sub2api_oauth_url_failed', status: 503 });
    },
    browserOAuth: async () => { browserCalls += 1; throw new Error('must not start fallback browser'); },
    fetch: async () => { requests += 1; throw new Error('must not start fallback protocol'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'sub2api_oauth_url_failed');
  assert.equal(result.oauthFallback, undefined);
  assert.equal(providerCalls, 1);
  assert.equal(browserCalls, 0);
  assert.equal(requests, 0);
});

test('single-attempt browser session failure never opens a second window and allows a later explicit retry', async () => {
  let browserCalls = 0;
  let exchanges = 0;
  const options = {
    singleAttempt: true, browserLogin: true, email: 'fixture@example.test', password: 'fixture-password',
    workspaceMode: 'team', workspaceId: 'fixture-target-team',
    session: { state: 'fixture-invalid-signin-state', codeVerifier: 'fixture-invalid-signin-verifier' },
    browserOAuth: async ({ expectedState, workspaceId }) => {
      browserCalls += 1;
      assert.equal(workspaceId, 'fixture-target-team');
      if (browserCalls === 1) throw Object.assign(new Error('your login session has expired'), { code: 'signin_session_invalid', status: 409 });
      return { callbackUrl: `http://localhost:1455/auth/callback?code=fixture-explicit-retry&state=${expectedState}` };
    },
    fetch: async () => { exchanges += 1; return jsonResponse({ access_token: 'fixture-retry-at', refresh_token: 'fixture-retry-rt' }); },
  };
  const failed = await loginFreeAccount(options);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'signin_session_invalid');
  assert.equal(browserCalls, 1);
  assert.equal(exchanges, 0);
  assert.notEqual(failed.session.state, options.session.state);
  const retried = await loginFreeAccount({ ...options, session: failed.session });
  assert.equal(retried.ok, true);
  assert.equal(browserCalls, 2, 'one browser per explicit invocation');
  assert.equal(exchanges, 1);
});

test('single-attempt expired provider callback stops without requesting another link or login', async (t) => {
  const session = providerCallbackFixture('single-attempt');
  storeOAuthCallback(session.callbackUrl);
  t.after(() => clearOAuthCallback(session.state));
  let linkCreations = 0;
  let exchanges = 0;
  let browsers = 0;
  const result = await loginFreeAccount({
    singleAttempt: true, browserLogin: true, email: 'fixture@example.test', password: 'fixture-password',
    session, callbackUrl: session.callbackUrl,
    authorizationProvider: async () => { linkCreations += 1; return freshProviderAuthorization('single-attempt'); },
    callbackHandler: async () => {
      exchanges += 1;
      throw Object.assign(new Error('session not found or expired'), { code: 'sub2api_oauth_session_expired', status: 409 });
    },
    browserOAuth: async () => { browsers += 1; throw new Error('must not reopen browser'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'oauth_session_expired');
  assert.equal(result.authUrl, null);
  assert.equal(result.sessionRecovered, false);
  assert.equal(exchanges, 1);
  assert.equal(linkCreations, 0);
  assert.equal(browsers, 0);
  assert.equal(consumeOAuthCallback(session.state), '');
  assert.notEqual(result.session.state, session.state);
});
