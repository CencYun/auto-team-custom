import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  BrowserOAuthError, completeBrowserOAuth, selectBrowserWorkspace,
  validateBrowserOAuthCallback, validateBrowserOAuthOptions,
} from './openai-browser-login.mjs';

const redirectUri = 'http://localhost:1455/auth/callback';
const state = 'fixture-state';
const callbackUrl = `${redirectUri}?code=fixture-private-code&state=${state}`;
const authUrl = `https://auth.openai.com/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
const options = { authUrl, state, redirectUri, workspaceMode: 'team', workspaceId: 'target-team' };

function fixture({ stages, resultCallback = callbackUrl, responseStatus = 200, responseRequests = [], gotoError, afterFieldClick, gotoCallback = false,
  alterTypedValue } = {}) {
  const events = {};
  const typed = [];
  const selected = [];
  const intercepted = [];
  const runtime = { contextClosed: 0, browserClosed: 0, options: null, authentication: null, submits: 0, keyboard: [], fieldValues: new Map() };
  const pages = stages || [
    { url: 'https://auth.openai.com/log-in', control: 'email' },
    { url: 'https://auth.openai.com/log-in/password', control: 'password' },
    { url: 'https://auth.openai.com/mfa-challenge/fixture-id', control: 'totp' },
    { url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent', control: 'workspace', entries: [
      { value: 'personal-account', label: 'Personal account' }, { value: 'target-team', label: 'Target Team' },
    ] },
  ];
  let position = 0;
  let focused = null;
  let modifierDown = false;
  let allSelected = false;
  const frame = {};
  const stage = () => pages[position];
  const emitForbidden = ({ url = authUrl, navigation = false, resourceType = 'fetch', childFrame = false } = {}) => {
    events.response({ status: () => 403, request: () => ({
      frame: () => childFrame ? {} : frame, url: () => url,
      isNavigationRequest: () => navigation, resourceType: () => resourceType,
    }) });
  };
  function handle(info, name) {
    const fieldKey = `${position}:${name}`;
    if (!runtime.fieldValues.has(fieldKey)) runtime.fieldValues.set(fieldKey, stage().initialValue || '');
    return {
      evaluate: async (fn, ...args) => fn.name === 'inspectControl'
        ? { visible: true, disabled: false, hasForm: true, action: '', label: '', kind: '', value: '', ...info }
        : fn({ value: runtime.fieldValues.get(fieldKey) }, ...args),
      click: async () => {
        if (name === 'submit') {
          runtime.submits += 1;
          if (stage().forbiddenResponse) emitForbidden(stage().forbiddenResponse);
          if (position < pages.length - 1) { position += 1; return; }
          const request = {
            url: () => resultCallback, method: () => 'GET', isNavigationRequest: () => true,
            frame: () => frame, abort: async () => { intercepted.push('abort'); },
            continue: async () => { intercepted.push('continue'); },
          };
          await events.request(request);
        } else {
          focused = fieldKey;
          allSelected = false;
          if (name === 'workspace') selected.push(info.value);
          afterFieldClick?.(pages, position, name);
        }
      },
      type: async (value) => {
        typed.push({ name, value });
        const next = runtime.fieldValues.get(fieldKey) + value;
        runtime.fieldValues.set(fieldKey, alterTypedValue ? alterTypedValue(next, name) : next);
      },
    };
  }
  const page = {
    keyboard: {
      down: async (key) => { runtime.keyboard.push(['down', key]); modifierDown = true; },
      up: async (key) => { runtime.keyboard.push(['up', key]); modifierDown = false; },
      press: async (key) => {
        runtime.keyboard.push(['press', key]);
        if (key === 'KeyA' && modifierDown) allSelected = true;
        if (key === 'Backspace' && focused && allSelected) runtime.fieldValues.set(focused, '');
      },
    },
    setViewport: async () => {}, setDefaultTimeout: () => {},
    authenticate: async (value) => { runtime.authentication = value; },
    setRequestInterception: async () => {}, on: (name, listener) => { events[name] = listener; },
    mainFrame: () => frame, url: () => stage().url,
    goto: async () => {
      if (gotoError) throw new Error(gotoError);
      if (gotoCallback) {
        await events.request({
          url: () => resultCallback, method: () => 'GET', isNavigationRequest: () => true,
          frame: () => frame, abort: async () => { intercepted.push('abort'); },
          continue: async () => { intercepted.push('continue'); },
        });
      }
      if (responseStatus === 403) emitForbidden({ navigation: true, resourceType: 'document' });
      responseRequests.forEach(emitForbidden);
    },
    evaluate: async (fn) => {
      const inspected = runInNewContext(`(${fn.toString()})()`, {
        document: { body: { innerText: stage().bodyText || '' }, querySelectorAll: () => [] },
        window: { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) },
      });
      return { ...inspected, challenge: Boolean(stage().challenge) || inspected.challenge,
        rejected: Boolean(stage().rejected) || inspected.rejected };
    },
    $$: async (selector) => {
      if (selector.startsWith('button')) return stage().noSubmit ? [] : [handle({ action: stage().submitAction || '' }, 'submit')];
      if (selector.startsWith('input[type="radio"]')) {
        return stage().control === 'workspace' ? (stage().entries || []).map((entry) => handle(entry, 'workspace')) : [];
      }
      const name = selector.startsWith('input[type="email"]') ? 'email'
        : selector.startsWith('input[type="password"]') ? 'password' : 'totp';
      return stage().control === name ? [handle({ action: stage().action || '' }, name)] : [];
    },
  };
  const context = { newPage: async () => page, close: async () => { runtime.contextClosed += 1; } };
  const browser = { createBrowserContext: async () => context, close: async () => { runtime.browserClosed += 1; } };
  return {
    runtime, typed, selected, intercepted, events, page,
    launch: async (value) => { runtime.options = value; return browser; },
    login: (extra = {}) => completeBrowserOAuth({
      ...options, email: 'fixture@example.test', password: 'fixture-private-password',
      getTotpCode: async () => '654321', executablePath: '/fixture/chrome',
      launch: async (value) => { runtime.options = value; return browser; }, ...extra,
    }),
  };
}

test('ordinary browser form flow submits email, password and TOTP, chooses exact Team and intercepts callback', async () => {
  const fake = fixture();
  const logs = [];
  const result = await fake.login({ onProgress: (phase, message) => logs.push({ phase, message }) });
  assert.deepEqual(result, { callbackUrl });
  assert.deepEqual(fake.typed, [
    { name: 'email', value: 'fixture@example.test' },
    { name: 'password', value: 'fixture-private-password' },
    { name: 'totp', value: '654321' },
  ]);
  assert.deepEqual(fake.selected, ['target-team']);
  assert.deepEqual(fake.intercepted, ['abort']);
  assert.deepEqual(logs.map((entry) => entry.phase), [
    'browser_start', 'browser_email', 'browser_password', 'browser_totp', 'browser_workspace', 'browser_callback',
  ]);
  assert.equal(fake.runtime.contextClosed, 1);
  assert.equal(fake.runtime.browserClosed, 1);
  assert.equal(fake.runtime.options.headless, true);
  assert.equal(fake.runtime.options.args.some((value) => /AutomationControlled|disable-web-security|ignore-certificate/i.test(value)), false);
  assert.doesNotMatch(JSON.stringify(logs), /fixture@example|private-password|654321|private-code/);
});

test('expectedState accepts the original runner state without replacing it', async () => {
  const fake = fixture();
  assert.deepEqual(await fake.login({ expectedState: state, state: undefined }), { callbackUrl });
});

test('prefilled email, password, and TOTP are replaced with normal keyboard input before submission', async () => {
  const fake = fixture();
  fake.runtime.fieldValues.set('0:email', 'old@example.test');
  fake.runtime.fieldValues.set('1:password', 'old-private-password');
  fake.runtime.fieldValues.set('2:totp', '000000');
  assert.deepEqual(await fake.login(), { callbackUrl });
  assert.equal(fake.runtime.fieldValues.get('0:email'), 'fixture@example.test');
  assert.equal(fake.runtime.fieldValues.get('1:password'), 'fixture-private-password');
  assert.equal(fake.runtime.fieldValues.get('2:totp'), '654321');
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  assert.deepEqual(fake.runtime.keyboard, Array.from({ length: 3 }, () => [
    ['down', modifier], ['press', 'KeyA'], ['up', modifier], ['press', 'Backspace'],
  ]).flat());
});

test('a controlled input that changes the entered password prevents submission without exposing its contents', async () => {
  const fake = fixture({ alterTypedValue: (value, name) => name === 'password' ? 'unexpected-private-value' : value });
  const logs = [];
  await assert.rejects(fake.login({ onProgress: (phase, message) => logs.push({ phase, message }) }), (error) => {
    assert.equal(error.code, 'browser_oauth_input_mismatch');
    assert.equal(error.browserRequired, false);
    assert.doesNotMatch(error.message + JSON.stringify(error), /unexpected-private-value|fixture-private-password/);
    return true;
  });
  assert.equal(fake.runtime.submits, 1, 'only the email form may submit; mismatched password must never submit');
  assert.deepEqual(fake.typed.map((entry) => entry.name), ['email', 'password']);
  assert.doesNotMatch(JSON.stringify(logs), /unexpected-private-value|fixture-private-password/);
});

for (const bodyText of ['Incorrect email address or password.', 'Incorrect password', '邮箱或密码错误']) {
  test(`official credential rejection text ends the login without misclassifying it as browser verification: ${bodyText}`, async () => {
    const fake = fixture({ stages: [
      { url: 'https://auth.openai.com/log-in/password', control: 'password' },
      { url: 'https://auth.openai.com/log-in/password', control: 'password', bodyText },
    ] });
    let requestedTotp = false;
    await assert.rejects(fake.login({ getTotpCode: async () => { requestedTotp = true; return '654321'; } }), {
      code: 'browser_oauth_credentials_rejected', reason: 'password_invalid', browserRequired: false, needsInput: true,
    });
    assert.equal(fake.runtime.submits, 1);
    assert.equal(requestedTotp, false);
    assert.equal(fake.runtime.browserClosed, 1);
  });
}

test('attached Roxy session reuses the normal login flow and closes only its owned session', async () => {
  const fake = fixture();
  let closed = 0;
  const closeOptions = [];
  const logs = [];
  const result = await fake.login({
    launch: async () => { throw new Error('Chrome must not launch'); },
    proxy: { server: 'invalid-unused-Chrome-proxy' },
    acquireSession: async () => ({ page: fake.page, keepOpenOnFailure: true,
      close: async (options) => { closed += 1; closeOptions.push(options); } }),
    onProgress: (phase) => logs.push(phase),
  });
  assert.deepEqual(result, { callbackUrl });
  assert.deepEqual(fake.selected, ['target-team']);
  assert.equal(closed, 1);
  assert.deepEqual(closeOptions, [undefined], 'a successful callback still closes a headed window');
  assert.equal(fake.runtime.contextClosed, 0);
  assert.equal(fake.runtime.browserClosed, 0);
  assert.equal(fake.runtime.authentication, null);
  assert.equal(logs[0], 'roxy_start');
});

test('attached browser failure closes its owned session without falling back to Chrome', async () => {
  const fake = fixture({ responseStatus: 403 });
  let closed = 0;
  await assert.rejects(fake.login({
    launch: async () => { throw new Error('Chrome must not launch'); },
    acquireSession: async () => ({ page: fake.page, close: async () => { closed += 1; } }),
  }), { code: 'browser_oauth_verification_required' });
  assert.equal(closed, 1);
  assert.equal(fake.runtime.browserClosed, 0);
});

test('a headed Roxy failure keeps its owned window open and emits a fixed handoff message', async () => {
  const fake = fixture({ responseStatus: 403 });
  const closeOptions = [];
  const logs = [];
  await assert.rejects(fake.login({
    acquireSession: async () => ({ page: fake.page, keepOpenOnFailure: true,
      close: async (options) => { closeOptions.push(options); } }),
    onProgress: (phase, message) => logs.push({ phase, message }),
  }), { code: 'browser_oauth_verification_required', status: 403 });
  assert.deepEqual(closeOptions, [{ keepOpen: true }]);
  assert.equal(logs.at(-1).phase, 'roxy_window_left_open');
  assert.doesNotMatch(JSON.stringify(logs), /fixture-private|fixture-state|https?:\/\//);
  assert.deepEqual(fake.typed, []);
});

test('keeping a Roxy window open must not replace the original password error with a cleanup error', async () => {
  const fake = fixture({ stages: [{ url: 'https://auth.openai.com/log-in/password', control: 'password',
    bodyText: 'Incorrect email address or password.' }] });
  const logs = [];
  await assert.rejects(fake.login({
    acquireSession: async () => ({ page: fake.page, keepOpenOnFailure: true,
      close: async (options) => { assert.deepEqual(options, { keepOpen: true }); throw new Error('private cleanup error'); } }),
    onProgress: (phase, message) => logs.push({ phase, message }),
  }), { code: 'browser_oauth_credentials_rejected', reason: 'password_invalid', browserRequired: false });
  assert.equal(logs.at(-1).phase, 'roxy_cleanup_failed');
  assert.equal(logs.some((entry) => entry.phase === 'roxy_window_left_open'), false);
  assert.doesNotMatch(JSON.stringify(logs), /private cleanup error/);
});

test('Roxy cleanup failure preserves the valid callback for token exchange and emits only a safe warning', async () => {
  const fake = fixture();
  const logs = [];
  assert.deepEqual(await fake.login({
    acquireSession: async () => ({ page: fake.page, close: async () => { throw new Error('private Roxy error'); } }),
    onProgress: (phase, message) => logs.push({ phase, message }),
  }), { callbackUrl });
  assert.equal(logs.at(-1).phase, 'roxy_cleanup_failed');
  assert.doesNotMatch(JSON.stringify(logs), /private Roxy error|private-code/);
});

test('Roxy cleanup failure never hides an official 403 verification failure', async () => {
  const fake = fixture({ responseStatus: 403 });
  await assert.rejects(fake.login({
    acquireSession: async () => ({ page: fake.page, close: async () => { throw new Error('cleanup failed'); } }),
  }), { code: 'browser_oauth_verification_required', status: 403 });
});

for (const invalid of [
  { authUrl: authUrl.replace('auth.openai.com', 'auth.openai.com.example.test') },
  { authUrl: authUrl.replace('oauth/authorize', 'log-in') },
  { authUrl: `${authUrl}&state=another` },
  { state: 'another-state' },
  { authUrl: `${authUrl}#fragment` },
  { redirectUri: 'http://remote.example.test/auth/callback' },
  { workspaceId: '' },
]) {
  test(`unsafe OAuth options rejected before browser launch: ${Object.keys(invalid).join(',')}:${JSON.stringify(invalid)}`, async () => {
    let launched = false;
    await assert.rejects(completeBrowserOAuth({ ...options, ...invalid, launch: async () => { launched = true; } }), { code: 'browser_oauth_options_invalid' });
    assert.equal(launched, false);
  });
}

test('callback must match exact loopback origin, path, state and original redirect query', () => {
  const validated = validateBrowserOAuthOptions(options);
  assert.equal(validateBrowserOAuthCallback(callbackUrl, validated), callbackUrl);
  assert.throws(() => validateBrowserOAuthCallback(callbackUrl.replace(state, 'another-state'), validated), { code: 'browser_oauth_state_mismatch' });
  for (const value of [
    callbackUrl.replace('localhost', 'localhost.example.test'),
    callbackUrl.replace('/auth/callback', '/auth/callback/other'),
    callbackUrl.replace(':1455', ':1456'),
    `${callbackUrl}&code=second`, `${callbackUrl}&state=second`, `${callbackUrl}#fragment`,
  ]) assert.throws(() => validateBrowserOAuthCallback(value, validated), { code: 'browser_oauth_callback_invalid' });
  const providerRedirect = 'http://127.0.0.1:1455/auth/callback?source=fixture';
  const provider = validateBrowserOAuthOptions({ ...options, redirectUri: providerRedirect, authUrl: `https://auth.openai.com/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(providerRedirect)}` });
  const providerCallback = `${providerRedirect}&code=fixture-code&state=${state}`;
  assert.equal(validateBrowserOAuthCallback(providerCallback, provider), providerCallback);
  assert.throws(() => validateBrowserOAuthCallback(providerCallback.replace('source=fixture', 'source=other'), provider), { code: 'browser_oauth_callback_invalid' });
});

for (const unsupportedRedirect of [
  'https://provider.example.test/oauth/callback?source=fixture',
  'https://localhost:1455/auth/callback',
  'http://localhost:1456/auth/callback',
  'http://localhost:1455/other/callback',
]) {
  test(`unsupported original provider redirect is rejected before launch: ${unsupportedRedirect}`, async () => {
    let launched = false;
    const invalidOptions = {
      ...options, redirectUri: unsupportedRedirect,
      authUrl: `https://auth.openai.com/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(unsupportedRedirect)}`,
    };
    assert.throws(() => validateBrowserOAuthOptions(invalidOptions), { code: 'browser_oauth_options_invalid' });
    await assert.rejects(completeBrowserOAuth({
      ...invalidOptions, launch: async () => { launched = true; },
    }), { code: 'browser_oauth_options_invalid' });
    assert.equal(launched, false);
  });
}

test('Team selection never falls back to personal space or another Team', async () => {
  const fake = fixture({ stages: [{
    url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent', control: 'workspace',
    entries: [{ value: 'personal', label: 'Personal account' }, { value: 'wrong-team', label: 'Team' }],
  }] });
  await assert.rejects(fake.login(), { code: 'browser_oauth_workspace_unavailable' });
  assert.deepEqual(fake.selected, []);
  assert.equal(fake.runtime.contextClosed, 1);
  assert.equal(fake.runtime.browserClosed, 1);
});

test('Team selection rejects a known personal workspace even when its radio value matches the requested ID', () => {
  for (const entry of [
    { value: 'target-team', kind: 'personal', label: 'Account' },
    { value: 'target-team', label: 'Personal account' },
    { value: 'target-team', label: '个人空间' },
  ]) assert.throws(() => selectBrowserWorkspace([entry], 'target-team', 'team'), { code: 'browser_oauth_workspace_unavailable' });
});

test('Free login accepts a validated direct callback without a workspace selector and lets the runner inspect real claims', async () => {
  const fake = fixture({ gotoCallback: true });
  assert.deepEqual(await fake.login({ workspaceMode: 'free', workspaceId: '' }), { callbackUrl });
  assert.deepEqual(fake.selected, []);
  assert.deepEqual(fake.typed, []);
  assert.deepEqual(fake.intercepted, ['abort']);
  assert.equal(fake.runtime.contextClosed, 1);
  assert.equal(fake.runtime.browserClosed, 1);
});

test('Team login rejects a direct callback when the target workspace was never selected', async () => {
  const fake = fixture({ gotoCallback: true });
  await assert.rejects(fake.login(), { code: 'browser_oauth_workspace_unconfirmed' });
  assert.deepEqual(fake.selected, []);
  assert.deepEqual(fake.typed, []);
  assert.deepEqual(fake.intercepted, ['abort']);
  assert.equal(fake.runtime.contextClosed, 1);
  assert.equal(fake.runtime.browserClosed, 1);
});

test('Free selection requires an explicit personal label or metadata', () => {
  const entries = [{ value: 'first', label: 'Team A' }, { value: 'personal', label: '个人空间' }];
  assert.equal(selectBrowserWorkspace(entries, '', 'free').value, 'personal');
  assert.throws(() => selectBrowserWorkspace([{ value: 'first', label: 'Team A' }], '', 'free'), { code: 'browser_oauth_workspace_unavailable' });
  assert.throws(() => selectBrowserWorkspace([{ value: 'same' }, { value: 'same' }], 'same', 'team'), { code: 'browser_oauth_workspace_unavailable' });
});

for (const stage of [
  { url: 'https://auth.openai.com/log-in', control: 'email', challenge: true },
  { url: 'https://auth.openai.com/mfa-challenge/fixture', control: 'totp', challenge: true },
]) {
  test(`security verification stops without credentials on ${stage.url}`, async () => {
    const fake = fixture({ stages: [stage] });
    let codes = 0;
    await assert.rejects(fake.login({ getTotpCode: async () => { codes += 1; return '123456'; } }), {
      code: 'browser_oauth_verification_required', browserRequired: true, needsInput: true,
    });
    assert.deepEqual(fake.typed, []);
    assert.equal(codes, 0);
    assert.equal(fake.runtime.browserClosed, 1);
  });
}

test('official 403 immediately pauses browser login without submitting credentials', async () => {
  const fake = fixture({ responseStatus: 403 });
  const logs = [];
  await assert.rejects(fake.login({ onProgress: (phase, message) => logs.push({ phase, message }) }), { code: 'browser_oauth_verification_required', status: 403 });
  assert.deepEqual(fake.typed, []);
  assert.equal(fake.runtime.contextClosed, 1);
  assert.deepEqual(logs.at(-1), { phase: 'browser_http_forbidden', message: '官方授权主页面返回 HTTP 403，已暂停自动登录' });
  assert.doesNotMatch(JSON.stringify(logs), /fixture-state|redirect_uri|https:\/\//);
});

for (const resourceType of ['fetch', 'xhr']) {
  test(`official password API ${resourceType} 403 pauses before the next login step`, async () => {
    const fake = fixture({ stages: [
      { url: 'https://auth.openai.com/log-in', control: 'email' },
      { url: 'https://auth.openai.com/log-in/password', control: 'password', forbiddenResponse: {
        url: 'https://auth.openai.com/api/accounts/password/verify?fixture-private-query=yes', resourceType,
      } },
      { url: 'https://auth.openai.com/mfa-challenge/fixture-id', control: 'totp' },
    ] });
    const logs = [];
    await assert.rejects(fake.login({ onProgress: (phase, message) => logs.push({ phase, message }) }), {
      code: 'browser_oauth_verification_required', status: 403, browserRequired: true, needsInput: true,
    });
    assert.deepEqual(fake.typed.map((entry) => entry.name), ['email', 'password']);
    assert.deepEqual(logs.at(-1), { phase: 'browser_http_forbidden', message: '官方账号认证接口返回 HTTP 403，已暂停自动登录' });
    assert.doesNotMatch(JSON.stringify(logs), /fixture-private-query|fixture-private-password|654321/);
  });
}

for (const forbiddenResource of [
  { url: 'https://sentinel.openai.com/sdk/telemetry', resourceType: 'fetch' },
  { url: 'https://sentinel.openai.com/api/accounts/telemetry', resourceType: 'fetch' },
  { url: 'https://auth.openai.com/assets/app.js', resourceType: 'script' },
  { url: 'https://auth.openai.com/api/accounts/icon.png', resourceType: 'image' },
  { url: 'https://auth.openai.com/favicon.ico', resourceType: 'image' },
  { url: 'https://assets.example.test/app.js', resourceType: 'script' },
  { url: 'https://sentinel.openai.com/sdk/frame', resourceType: 'document', navigation: true, childFrame: true },
]) {
  test(`unrelated resource 403 does not falsely pause official login: ${forbiddenResource.resourceType}:${forbiddenResource.url}`, async () => {
    const fake = fixture({ responseRequests: [forbiddenResource] });
    const logs = [];
    assert.deepEqual(await fake.login({ onProgress: (phase, message) => logs.push({ phase, message }) }), { callbackUrl });
    assert.deepEqual(fake.typed.map((entry) => entry.name), ['email', 'password', 'totp']);
    assert.equal(logs.some((entry) => entry.phase === 'browser_http_forbidden'), false);
    assert.equal(fake.runtime.contextClosed, 1);
    assert.equal(fake.runtime.browserClosed, 1);
  });
}

for (const fakeOptions of [
  { stages: [{ url: 'https://evil.example.test/log-in', control: 'email' }] },
  { stages: [{ url: 'https://auth.openai.com/unknown-security-check', control: 'email' }] },
  { stages: [{ url: 'https://auth.openai.com/log-in', control: 'email', action: 'https://evil.example.test/collect' }] },
  { stages: [{ url: 'https://auth.openai.com/workspace', control: 'password' }] },
]) {
  test(`credentials never filled on unsupported page/action: ${JSON.stringify(fakeOptions)}`, async () => {
    const fake = fixture(fakeOptions);
    await assert.rejects(fake.login(), { code: 'browser_oauth_page_unsupported' });
    assert.deepEqual(fake.typed, []);
    assert.equal(fake.runtime.contextClosed, 1);
    assert.equal(fake.runtime.browserClosed, 1);
  });
}

test('URL is checked again after focusing the field and before typing credentials', async () => {
  const fake = fixture({ afterFieldClick: (pages, position) => { pages[position].url = 'https://evil.example.test/log-in'; } });
  await assert.rejects(fake.login(), { code: 'browser_oauth_page_unsupported' });
  assert.deepEqual(fake.typed, []);
});

test('TOTP callback failure returns fixed error without revealing secrets', async () => {
  const fake = fixture({ stages: [{ url: 'https://auth.openai.com/mfa-challenge/fixture', control: 'totp' }] });
  await assert.rejects(fake.login({ getTotpCode: async () => { throw new Error('private-otp-seed'); } }), (error) => {
    assert.equal(error.code, 'browser_oauth_totp_required');
    assert.doesNotMatch(JSON.stringify(error) + error.message, /private-otp-seed/);
    return true;
  });
  assert.deepEqual(fake.typed, []);
});

test('email OTP cannot be submitted with the TOTP seed', async () => {
  const fake = fixture({ stages: [{ url: 'https://auth.openai.com/log-in/otp', control: 'totp' }] });
  let requested = false;
  await assert.rejects(fake.login({ getTotpCode: async () => { requested = true; return '654321'; } }), { code: 'browser_oauth_verification_required' });
  assert.equal(requested, false);
});

test('browser proxy is applied with separate credentials and never falls back to direct', async () => {
  const fake = fixture();
  await fake.login({ proxy: { server: 'http://fixture-user:fixture-proxy-password@127.0.0.1:8088' } });
  assert.ok(fake.runtime.options.args.includes('--proxy-server=http://127.0.0.1:8088'));
  assert.doesNotMatch(JSON.stringify(fake.runtime.options), /fixture-user|fixture-proxy-password/);
  assert.deepEqual(fake.runtime.authentication, { username: 'fixture-user', password: 'fixture-proxy-password' });
  for (const proxy of [{ server: 'socks5://127.0.0.1:1080', username: 'user', password: 'secret' }, { server: 'socks5h://user:secret@127.0.0.1:1080' }]) {
    const unsupported = fixture();
    await assert.rejects(unsupported.login({ proxy }), { code: 'browser_oauth_socks_auth_unsupported' });
    assert.equal(unsupported.runtime.options, null);
  }
});

test('unexpected raw browser error is sanitized and closes isolated resources', async () => {
  const fake = fixture({ gotoError: 'fixture-password fixture-cookie fixture-access-token' });
  await assert.rejects(fake.login(), (error) => {
    assert.ok(error instanceof BrowserOAuthError);
    assert.equal(error.code, 'browser_oauth_failed');
    assert.doesNotMatch(JSON.stringify(error) + error.message, /fixture-password|fixture-cookie|fixture-access-token/);
    return true;
  });
  assert.equal(fake.runtime.contextClosed, 1);
  assert.equal(fake.runtime.browserClosed, 1);
});

test('callback with another state is aborted and never returned for token exchange', async () => {
  const fake = fixture({ resultCallback: callbackUrl.replace(state, 'another-state') });
  await assert.rejects(fake.login(), { code: 'browser_oauth_state_mismatch' });
  assert.deepEqual(fake.intercepted, ['abort']);
  assert.equal(fake.runtime.browserClosed, 1);
});

test('normal cross-origin SDK posts are allowed but credential-bearing posts are aborted', async () => {
  const fake = fixture({ stages: [{ url: 'https://auth.openai.com/oauth/authorize' }] });
  const job = fake.login({ timeoutMs: 1000 });
  // Wait for the isolated fake page to install interception, not for network.
  while (!fake.events.request) await Promise.resolve();
  const methods = [];
  const makeRequest = (body) => ({
    url: () => 'https://sentinel.openai.com/sdk/telemetry', method: () => 'POST',
    postData: () => body, frame: () => fake.page.mainFrame(), isNavigationRequest: () => false,
    abort: async () => methods.push('abort'), continue: async () => methods.push('continue'),
  });
  await fake.events.request(makeRequest('{"event":"page_ready"}'));
  await fake.events.request(makeRequest('email=fixture%40example.test'));
  await assert.rejects(job, { code: 'browser_oauth_page_unsupported' });
  assert.deepEqual(methods, ['continue', 'abort']);
});

test('bounded timeout cleans up isolated browser without exposing the current URL', async () => {
  const fake = fixture({ stages: [{ url: 'https://auth.openai.com/oauth/authorize' }] });
  await assert.rejects(fake.login({ timeoutMs: 1000 }), { code: 'browser_oauth_timeout', status: 408 });
  assert.equal(fake.runtime.contextClosed, 1);
  assert.equal(fake.runtime.browserClosed, 1);
});
