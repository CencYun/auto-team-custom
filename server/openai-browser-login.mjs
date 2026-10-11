import puppeteer from 'puppeteer-core';
import { resolveSentinelExecutablePath } from './openai-sentinel.mjs';
import { RoxyBrowserError } from './roxy-browser.mjs';

const AUTH_ORIGIN = 'https://auth.openai.com';
const MAX_STEPS = 240;
const SAFE_PAGES = /^\/(?:oauth\/authorize|log-in(?:\/(?:username|password|totp|mfa|otp))?|log-in-or-create-account|mfa-challenge\/[a-zA-Z0-9_-]+|mfa|two-factor|totp|authenticator|one-time-password|workspace|sign-in-with-chatgpt\/codex\/consent)\/?$/;
const SELECTORS = {
  email: 'input[type="email"], input[name="email"], input[autocomplete="username"]',
  password: 'input[type="password"]',
  totp: 'input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], input[name="totp"], input[inputmode="numeric"][maxlength="6"]',
  workspace: 'input[type="radio"][name="workspace_id"], select[name="workspace_id"], button[name="workspace_id"], button[data-workspace-id], [role="radio"][data-workspace-id], [role="radio"][data-value], [role="option"][data-workspace-id], [role="option"][data-value], [role="option"][value]',
  workspaceDropdown: 'button[role="combobox"], button[aria-haspopup="listbox"]',
  submit: 'button[type="submit"], input[type="submit"]',
};
const ERROR_MESSAGES = {
  browser_oauth_options_invalid: '浏览器授权参数无效，请重新生成原始授权任务',
  browser_oauth_state_mismatch: '授权状态不匹配，已停止本次登录',
  browser_oauth_callback_invalid: '回调地址与原始授权任务不匹配，已停止本次登录',
  browser_oauth_callback_error: '官方授权未完成，请在浏览器检查授权结果',
  browser_oauth_page_unsupported: '遇到未知授权页面，需在浏览器手动确认',
  browser_oauth_verification_required: '官方要求安全或额外验证，需在浏览器手动完成',
  browser_oauth_credentials_rejected: '官方未接受本次登录信息，请检查账号或在浏览器重试',
  browser_oauth_totp_required: '当前账号需要有效的六位 2FA 验证码',
  browser_oauth_workspace_unavailable: '未找到目标工作空间，未选择其他空间',
  browser_oauth_workspace_unconfirmed: '未确认目标工作空间，未保存授权结果',
  browser_oauth_control_unavailable: '未找到唯一可用的授权控件，需在浏览器手动确认',
  browser_oauth_input_mismatch: '登录输入框内容未能正确填入，已停止提交，请检查浏览器输入状态',
  browser_oauth_timeout: '浏览器授权等待超时，可通过手动授权继续',
  browser_oauth_unavailable: '无法启动本机授权浏览器，请检查 Chrome 安装',
  browser_oauth_failed: '浏览器授权未完成，请查看阶段日志后重试',
  browser_oauth_proxy_connection_failed: '浏览器无法建立代理连接或上游隧道，请检查本机代理、代理池及上游连通性后重试',
  browser_oauth_network_failed: '浏览器连接官方授权服务失败，请检查网络或代理连通性后重试',
  browser_oauth_browser_disconnected: '授权浏览器或标签页连接已断开，请检查 Roxy 窗口是否被关闭或占用后重试',
  browser_oauth_navigation_timeout: '官方授权页面加载超时，请检查网络或代理后重试',
  browser_oauth_proxy_invalid: '浏览器代理配置无效，未使用直连',
  browser_oauth_socks_auth_unsupported: '浏览器不支持带认证的 SOCKS 代理，请改用 HTTP 代理，未使用直连',
};

export class BrowserOAuthError extends Error {
  constructor(code, { status = 409, browserRequired = true, needsInput = true } = {}) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.browser_oauth_failed);
    this.name = 'BrowserOAuthError';
    this.code = ERROR_MESSAGES[code] ? code : 'browser_oauth_failed';
    this.status = status;
    this.browserRequired = browserRequired;
    this.needsInput = needsInput;
  }
}

function logUnknownBrowserFailure(error, navigation) {
  const safeNames = new Set(['Error', 'TypeError', 'TimeoutError', 'ProtocolError', 'TargetCloseError', 'AbortError', 'AggregateError']);
  const safeMethods = new Set([
    'Page.navigate', 'Page.enable', 'Page.getFrameTree', 'Page.createIsolatedWorld',
    'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.addBinding',
    'Network.enable', 'Network.setRequestInterception', 'Fetch.enable', 'Fetch.continueRequest', 'Fetch.failRequest',
    'Target.createTarget', 'Target.createBrowserContext', 'Target.closeTarget', 'Target.getTargets',
    'Target.attachToTarget', 'Target.detachFromTarget', 'Target.setAutoAttach',
    'Browser.getVersion', 'DOM.describeNode', 'DOM.resolveNode', 'DOM.getContentQuads',
  ]);
  const message = String(error?.message || '');
  const method = message.match(/^Protocol error \(([A-Za-z]+\.[A-Za-z]+)\):/)?.[1]
    || message.match(/^([A-Za-z]+\.[A-Za-z]+) timed out\./)?.[1];
  // Extract only a Chromium error token at the start of its error clause;
  // never scan URLs, query strings or arbitrary payloads for diagnostic text.
  const chromiumCode = message.match(/^(?:Protocol error \([A-Za-z]+\.[A-Za-z]+\): )?(?:net::)?(ERR_[A-Z_]{1,64})(?=\s|:|$)/)?.[1] || '';
  try {
    console.warn('[browser-oauth] unclassified browser error', JSON.stringify({
      phase: navigation ? 'navigation' : 'browser',
      errorName: safeNames.has(error?.name) ? error.name : 'OtherError',
      chromiumCode,
      cdpMethod: safeMethods.has(method) ? method : '',
    }));
  } catch { /* Diagnostics must not replace the original sanitized failure. */ }
}

function classifyBrowserFailure(error, { navigation = false } = {}) {
  if (error instanceof BrowserOAuthError || error instanceof RoxyBrowserError) return error;
  // Raw Chromium/CDP messages can contain credentials, proxy addresses and the
  // OAuth URL. Inspect them only here; expose fixed codes and messages below.
  const detail = `${String(error?.name || '')} ${String(error?.code || '')} ${String(error?.message || '')}`;
  let code = 'browser_oauth_failed';
  let status = 502;
  if (/\bERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|SOCKS_CONNECTION_HOST_UNREACHABLE|NO_SUPPORTED_PROXIES|PROXY_AUTH_UNSUPPORTED|PROXY_AUTH_REQUESTED|INVALID_AUTH_CREDENTIALS|PROXY_CERTIFICATE_INVALID|PROXY_HTTP_1_1_REQUIRED)\b/i.test(detail)) {
    code = 'browser_oauth_proxy_connection_failed';
  } else if (/TargetCloseError|Target closed|Session closed|Connection closed|browser (?:has )?disconnected|Target page, context or browser has been closed|Browser closed/i.test(detail)) {
    code = 'browser_oauth_browser_disconnected';
    status = 503;
  } else if (navigation && (/TimeoutError|Navigation timeout|navigation.*timed out|Timed out.*navigat/i.test(detail)
    || /^Page\.navigate timed out\./.test(String(error?.message || '')))) {
    code = 'browser_oauth_navigation_timeout';
    status = 504;
  } else if (/\bERR_(?:CONNECTION_[A-Z_]+|NAME_NOT_RESOLVED|DNS_[A-Z_]+|NETWORK_[A-Z_]+|INTERNET_DISCONNECTED|ADDRESS_[A-Z_]+|SSL_[A-Z_]+|CERT_[A-Z_]+|TIMED_OUT|EMPTY_RESPONSE|HTTP_RESPONSE_CODE_FAILURE)\b|\b(?:ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b/i.test(detail)) {
    code = 'browser_oauth_network_failed';
  }
  if (code === 'browser_oauth_failed') logUnknownBrowserFailure(error, navigation);
  return new BrowserOAuthError(code, { status, browserRequired: false, needsInput: false });
}

function urlFor(value, code = 'browser_oauth_options_invalid') {
  try {
    const url = new URL(String(value || ''));
    if (url.username || url.password || url.hash) throw new Error();
    return url;
  } catch {
    throw new BrowserOAuthError(code, { status: 400 });
  }
}

export function validateBrowserOAuthOptions({ authUrl, state, redirectUri, workspaceMode, workspaceId }) {
  const authorization = urlFor(authUrl);
  const redirect = urlFor(redirectUri);
  const localCallback = redirect.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
    && redirect.port === '1455' && redirect.pathname === '/auth/callback';
  if (!localCallback
    || authorization.origin !== AUTH_ORIGIN || authorization.pathname !== '/oauth/authorize'
    || !state || authorization.searchParams.getAll('state').length !== 1
    || authorization.searchParams.get('state') !== state
    || authorization.searchParams.getAll('redirect_uri').length !== 1
    || authorization.searchParams.get('redirect_uri') !== redirect.toString()
    || (workspaceMode === 'team' && !String(workspaceId || '').trim())) {
    throw new BrowserOAuthError('browser_oauth_options_invalid', { status: 400 });
  }
  return { authorization, redirect, state: String(state) };
}

export function validateBrowserOAuthCallback(value, { redirect, state }) {
  const callback = urlFor(value, 'browser_oauth_callback_invalid');
  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname
    || callback.searchParams.getAll('state').length !== 1
    || callback.searchParams.getAll('code').length !== 1) {
    throw new BrowserOAuthError('browser_oauth_callback_invalid', { status: 400 });
  }
  for (const [key, expected] of redirect.searchParams) {
    if (callback.searchParams.getAll(key).length !== 1 || callback.searchParams.get(key) !== expected) {
      throw new BrowserOAuthError('browser_oauth_callback_invalid', { status: 400 });
    }
  }
  if (callback.searchParams.get('state') !== state) {
    throw new BrowserOAuthError('browser_oauth_state_mismatch', { status: 400 });
  }
  if (callback.searchParams.has('error') || !callback.searchParams.get('code')?.trim()) {
    throw new BrowserOAuthError('browser_oauth_callback_error', { status: 400 });
  }
  return callback.toString();
}

function assertAuthPage(value) {
  const url = urlFor(value, 'browser_oauth_page_unsupported');
  if (url.origin !== AUTH_ORIGIN || !SAFE_PAGES.test(url.pathname)) {
    throw new BrowserOAuthError('browser_oauth_page_unsupported');
  }
  return url;
}

function normalizeProxy(proxy) {
  if (proxy == null) return null;
  if (!proxy.server) throw new BrowserOAuthError('browser_oauth_proxy_invalid', { status: 400 });
  let url;
  let username;
  let password;
  try {
    url = new URL(String(proxy.server));
    username = String(proxy.username || proxy.user || decodeURIComponent(url.username));
    password = String(proxy.password || proxy.pass || decodeURIComponent(url.password));
  } catch { throw new BrowserOAuthError('browser_oauth_proxy_invalid', { status: 400 }); }
  const protocols = ['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'];
  if (!protocols.includes(url.protocol) || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new BrowserOAuthError('browser_oauth_proxy_invalid', { status: 400 });
  }
  if (url.protocol.startsWith('socks') && (username || password)) {
    throw new BrowserOAuthError('browser_oauth_socks_auth_unsupported', { status: 400 });
  }
  const protocol = url.protocol === 'socks5h:' ? 'socks5:' : url.protocol;
  return { server: `${protocol}//${url.hostname}:${url.port || (protocol.startsWith('socks') ? '1080' : '8080')}`, username, password };
}

export function selectBrowserWorkspace(entries, workspaceId, workspaceMode = 'team') {
  const personal = (entry) => /^(?:personal|individual|free)$/i.test(entry.kind || '')
    || (!/^(?:team|business|enterprise)$/i.test(entry.kind || '')
      && /\bpersonal\b|个人(?:空间|账户|账号)?/i.test(entry.label || ''));
  const matches = workspaceMode === 'team'
    ? entries.filter((entry) => entry.value === workspaceId && !personal(entry))
    : entries.filter(personal);
  if (matches.length !== 1 || !matches[0].value) {
    throw new BrowserOAuthError('browser_oauth_workspace_unavailable');
  }
  return matches[0];
}

function inspectPageSafety() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const bodyText = document.body?.innerText || '';
  const challenge = [...document.querySelectorAll('iframe, .cf-turnstile, .h-captcha, .hcaptcha, .g-recaptcha')]
    .some((element) => visible(element) && (element.tagName !== 'IFRAME'
      || /challenges\.cloudflare\.com|recaptcha|hcaptcha/i.test(element.getAttribute('src') || '')))
    || /verify (?:that )?you are human|checking your browser|unusual activity|security check|phone verification|verify (?:your )?phone|add (?:a )?phone|additional verification|verify your email|text message|\bsms\b|mobile number|人机验证|验证您是真人|手机验证|安全验证|异常活动|短信验证码/i.test(bodyText)
    || [...document.querySelectorAll('input[type="tel"]:not([autocomplete="one-time-code"])')].some(visible);
  const rejected = [...document.querySelectorAll('[role="alert"], [aria-live="assertive"]')]
    .some((element) => visible(element) && /invalid|incorrect|failed|wrong|错误|失败|不正确/i.test(element.innerText || ''));
  const passwordRejected = /(?:incorrect|invalid|wrong)\s+(?:email(?:\s+address)?\s+or\s+)?password|invalid (?:login )?credentials|邮箱(?:地址)?或密码(?:错误|不正确)|账号或密码(?:错误|不正确)|密码错误/i.test(bodyText);
  return { challenge, passwordRejected,
    rejected: rejected || passwordRejected || /login failed|incorrect code|invalid code|验证码错误/i.test(bodyText) };
}

function inspectControl(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const label = [...(element.labels || [])].map((item) => item.innerText || '').join(' ');
  return {
    visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
    disabled: element.disabled || element.readOnly,
    value: element.type === 'radio' || element.name === 'workspace_id' ? element.value : '',
    kind: element.dataset.kind || element.dataset.workspaceType || element.dataset.type || '',
    label: label.slice(0, 300),
    action: (element.form || element.closest('form'))?.getAttribute('action') || '',
    hasForm: Boolean(element.form || element.closest('form')),
  };
}

function inspectWorkspaceControl(element) {
  const visible = (item) => {
    const rect = item.getBoundingClientRect();
    const style = window.getComputedStyle(item);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const form = element.form || element.closest('form');
  const label = [...(element.labels || [])].map((item) => item.innerText || '').join(' ')
    || element.getAttribute('aria-label') || element.innerText || '';
  const radio = element.tagName === 'INPUT' && element.type === 'radio';
  const value = element.name === 'workspace_id' ? element.value
    : element.dataset.workspaceId || element.dataset.value || element.getAttribute('value') || '';
  const formValues = form ? [...form.querySelectorAll('[name="workspace_id"]')]
    .filter((item) => !item.disabled && (item.type !== 'radio' || item.checked)
      && item.tagName !== 'BUTTON' && item.type !== 'submit').map((item) => item.value) : [];
  return {
    visible: visible(element) || (radio && [...(element.labels || [])].some(visible)),
    clickLabel: radio && !visible(element),
    disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
    value, label: label.slice(0, 300),
    kind: element.dataset.kind || element.dataset.workspaceType || element.dataset.type || '',
    action: form?.getAttribute('action') || '', hasForm: Boolean(form),
    controlType: element.tagName === 'SELECT' ? 'select' : radio ? 'radio' : 'choice',
    directSubmit: element.tagName === 'BUTTON' && element.name === 'workspace_id'
      && element.type === 'submit' && Boolean(form),
    selected: radio ? element.checked : element.tagName === 'SELECT' ? Boolean(value)
      : element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-selected') === 'true'
        || (formValues.length === 1 && formValues[0] === value),
    formValues,
    options: element.tagName === 'SELECT' ? [...element.options].filter((option) => !option.disabled).map((option) => ({
      value: option.value, label: option.textContent || '',
      kind: option.dataset.kind || option.dataset.workspaceType || option.dataset.type || '',
    })) : null,
  };
}

async function workspaceControls(page) {
  const entries = [];
  for (const handle of await page.$$(SELECTORS.workspace)) {
    const info = await handle.evaluate(inspectWorkspaceControl);
    if (!info.visible || info.disabled) continue;
    if (info.options) entries.push(...info.options.filter((option) => option.value).map((option) => ({ ...info, ...option, handle })));
    else if (info.value) entries.push({ ...info, handle });
  }
  return entries;
}

function inspectWorkspaceFormSelection(expectedValue) {
  const fields = [...document.querySelectorAll('input[name="workspace_id"], select[name="workspace_id"]')]
    .filter((element) => !element.disabled && element.form
      && element.type !== 'submit' && (element.type !== 'radio' || element.checked));
  return fields.length === 1 && fields[0].value === expectedValue;
}

async function workspaceSelectionConfirmed(page, selected) {
  const actual = await selected.handle.evaluate(inspectWorkspaceControl);
  if (actual.selected && actual.value === selected.value
    && !actual.formValues?.some((value) => value !== selected.value)) return true;
  // A custom dropdown may remove its option from the DOM after clicking it.
  // Its controlled, form-associated workspace field remains authoritative.
  return selected.controlType === 'choice'
    && page.evaluate(inspectWorkspaceFormSelection, selected.value);
}

async function submitWorkspace(page, selected, beforeSubmit, deadline) {
  assertAuthPage(page.url());
  if (selected.hasForm) assertControlAction(selected, page.url());
  const fresh = await selected.handle.evaluate(inspectWorkspaceControl);
  if (!fresh.visible || fresh.disabled || (fresh.controlType !== 'select' && fresh.value !== selected.value)) {
    throw new BrowserOAuthError('browser_oauth_workspace_unconfirmed');
  }
  if (fresh.directSubmit) {
    assertControlAction(fresh, page.url());
    if (fresh.formValues?.some((value) => value !== selected.value)) {
      throw new BrowserOAuthError('browser_oauth_workspace_unconfirmed');
    }
    beforeSubmit();
    await selected.handle.click();
    return;
  }
  if (fresh.controlType === 'select') {
    await selected.handle.select(selected.value);
  } else if (fresh.clickLabel) {
    const label = await selected.handle.evaluateHandle((element) => [...(element.labels || [])].find((item) => {
      const rect = item.getBoundingClientRect();
      const style = window.getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }));
    try {
      const clickable = label.asElement();
      if (!clickable) throw new BrowserOAuthError('browser_oauth_control_unavailable');
      await clickable.click();
    } finally { await label.dispose(); }
  } else {
    await selected.handle.click();
  }
  assertAuthPage(page.url());
  // Read back the actual submitted field, including controlled React inputs.
  // Clicking a label alone is not proof that the target workspace was selected.
  let confirmed = await workspaceSelectionConfirmed(page, selected);
  const selectionDeadline = Math.min(deadline, Date.now() + 1500);
  while (!confirmed && Date.now() < selectionDeadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, selectionDeadline - Date.now()))));
    assertAuthPage(page.url());
    confirmed = await workspaceSelectionConfirmed(page, selected);
  }
  if (!confirmed) {
    throw new BrowserOAuthError('browser_oauth_workspace_unconfirmed');
  }
  const safety = await page.evaluate(inspectPageSafety);
  if (safety.challenge) throw new BrowserOAuthError('browser_oauth_verification_required');
  const buttons = await controls(page, SELECTORS.submit);
  const submitButtons = buttons.filter((button) => !button.value);
  if (submitButtons.length !== 1) throw new BrowserOAuthError('browser_oauth_control_unavailable');
  assertControlAction(submitButtons[0], page.url());
  // Re-read immediately before clicking Continue: a stale personal default
  // must never be accepted as confirmation of a Team authorization.
  if (!await workspaceSelectionConfirmed(page, selected)) {
    throw new BrowserOAuthError('browser_oauth_workspace_unconfirmed');
  }
  beforeSubmit();
  await submitButtons[0].handle.click();
}

async function controls(page, selector) {
  const handles = await page.$$(selector);
  const entries = [];
  for (const handle of handles) {
    const info = await handle.evaluate(inspectControl);
    if (info.visible && !info.disabled) entries.push({ ...info, handle });
  }
  return entries;
}

function assertControlAction(control, pageUrl) {
  assertAuthPage(pageUrl);
  if (!control.hasForm) throw new BrowserOAuthError('browser_oauth_control_unavailable');
  const action = new URL(control.action || pageUrl, pageUrl);
  if (action.origin !== AUTH_ORIGIN || action.username || action.password || action.hash) {
    throw new BrowserOAuthError('browser_oauth_page_unsupported');
  }
}

async function submit(page, field, text, beforeSubmit = () => {}) {
  assertControlAction(field, page.url());
  if (text != null) {
    await field.handle.click();
    assertAuthPage(page.url());
    assertControlAction(await field.handle.evaluate(inspectControl), page.url());
    const selectAllModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(selectAllModifier);
    try { await page.keyboard.press('KeyA'); }
    finally { await page.keyboard.up(selectAllModifier); }
    await page.keyboard.press('Backspace');
    assertAuthPage(page.url());
    await field.handle.type(text);
    // Read only: the normal keyboard input must have populated the entire
    // controlled field before any credential-bearing form can be submitted.
    if (!await field.handle.evaluate((element, expected) => element.value === expected, text)) {
      throw new BrowserOAuthError('browser_oauth_input_mismatch', { browserRequired: false });
    }
  } else {
    await field.handle.click();
  }
  assertAuthPage(page.url());
  const safety = await page.evaluate(inspectPageSafety);
  if (safety.challenge) throw new BrowserOAuthError('browser_oauth_verification_required');
  const buttons = await controls(page, SELECTORS.submit);
  if (buttons.length !== 1) throw new BrowserOAuthError('browser_oauth_control_unavailable');
  assertControlAction(buttons[0], page.url());
  beforeSubmit();
  await buttons[0].handle.click();
}

export async function completeBrowserOAuth({
  authUrl, expectedState, state = expectedState, redirectUri, workspaceId = '', workspaceMode = 'team', email, password,
  getTotpCode, proxy = null, timeoutMs = 120000, onProgress = () => {},
  launch = (options) => puppeteer.launch(options), executablePath, acquireSession,
}) {
  const validated = validateBrowserOAuthOptions({ authUrl, state, redirectUri, workspaceMode, workspaceId });
  const normalizedProxy = acquireSession ? null : normalizeProxy(proxy);
  const limit = Math.min(180000, Math.max(1000, Number(timeoutMs) || 120000));
  const deadline = Date.now() + limit;
  let browser;
  let context;
  let ownedSession;
  let timeout;
  let cancelled = false;
  let completed = false;
  let navigating = false;
  const progress = (phase, message) => { try { onProgress(phase, message); } catch { /* Progress cannot alter the login flow. */ } };
  const execute = async () => {
    let page;
    if (acquireSession) {
      progress('roxy_start', '正在打开账号绑定的 Roxy 窗口');
      ownedSession = await acquireSession({ timeoutMs: Math.max(1, deadline - Date.now()) });
      if (cancelled) { await ownedSession.close(); return; }
      page = ownedSession.page;
    } else {
      let path = executablePath;
      if (!path) {
        try { path = await resolveSentinelExecutablePath(); }
        catch { throw new BrowserOAuthError('browser_oauth_unavailable', { status: 503 }); }
      }
      const args = ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync'];
      if (normalizedProxy) args.push(`--proxy-server=${normalizedProxy.server}`);
      progress('browser_start', '启动隔离浏览器，打开官方授权页面');
      try { browser = await launch({ executablePath: path, headless: true, args, timeout: Math.max(1, deadline - Date.now()) }); }
      catch { throw new BrowserOAuthError('browser_oauth_unavailable', { status: 503 }); }
      if (cancelled) { await browser.close().catch(() => {}); return; }
      context = await browser.createBrowserContext();
      if (cancelled) { await context.close().catch(() => {}); return; }
      page = await context.newPage();
      if (cancelled) { await context.close().catch(() => {}); return; }
      await page.setViewport({ width: 1280, height: 800 });
      if (normalizedProxy?.username || normalizedProxy?.password) {
        await page.authenticate({ username: normalizedProxy.username, password: normalizedProxy.password });
      }
    }
    page.setDefaultTimeout(Math.min(10000, limit));
    let callbackUrl = '';
    let failure = null;
    let workspaceSelected = false;
    const credentialValues = new Set([String(email || '').trim(), String(password || '')].filter(Boolean));
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      try {
        if (request.isInterceptResolutionHandled?.()) return;
        const raw = request.url();
        const url = urlFor(raw, 'browser_oauth_page_unsupported');
        const mainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (mainNavigation && url.origin === validated.redirect.origin && url.pathname === validated.redirect.pathname) {
          callbackUrl = validateBrowserOAuthCallback(raw, validated);
          if (workspaceMode === 'team' && !workspaceSelected) failure = new BrowserOAuthError('browser_oauth_workspace_unconfirmed');
          await request.abort();
          return;
        }
        if (mainNavigation) assertAuthPage(raw);
        if (request.method() !== 'GET' && request.method() !== 'HEAD' && url.origin !== AUTH_ORIGIN) {
          const body = request.postData?.() || '';
          let decoded = body;
          try { decoded = decodeURIComponent(body.replace(/\+/g, ' ')); } catch { /* Raw payload is still checked. */ }
          const credentialsPresent = [...credentialValues].some((value) =>
            body.includes(value) || decoded.includes(value) || body.includes(JSON.stringify(value).slice(1, -1)));
          // Official pages may use normal cross-origin SDK telemetry, but no
          // account credential can leave the official authentication origin.
          if (credentialsPresent) throw new BrowserOAuthError('browser_oauth_page_unsupported');
        }
        await request.continue();
      } catch (error) {
        failure ||= classifyBrowserFailure(error);
        await request.abort().catch(() => {});
      }
    });
    page.on('response', (response) => {
      if (response.status() !== 403) return;
      const request = response.request();
      const mainDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
      let authenticationApi = false;
      try {
        const url = new URL(request.url());
        authenticationApi = url.origin === AUTH_ORIGIN && url.pathname.startsWith('/api/accounts/')
          && ['fetch', 'xhr'].includes(request.resourceType());
      } catch { /* A resource URL cannot make an unrelated 403 an authentication failure. */ }
      if (mainDocument || authenticationApi) {
        progress('browser_http_forbidden', mainDocument
          ? '官方授权主页面返回 HTTP 403，已暂停自动登录'
          : '官方账号认证接口返回 HTTP 403，已暂停自动登录');
        failure = new BrowserOAuthError('browser_oauth_verification_required', { status: 403 });
      }
    });
    progress('browser_navigation', '浏览器已连接，正在通过当前网络打开官方授权页面');
    navigating = true;
    try {
      await page.goto(validated.authorization.toString(), { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) });
    } catch (error) {
      if (!callbackUrl && !failure) {
        // A redirect can replace the document while goto is waiting. Continue
        // only on a recognized official page; real network errors still stop.
        if (!/net::ERR_ABORTED|Execution context was destroyed/i.test(String(error?.message || ''))) {
          throw classifyBrowserFailure(error, { navigation: true });
        }
        assertAuthPage(page.url());
      }
    } finally { navigating = false; }
    const submitted = new Set();
    let workspaceWaitStarted = 0;
    let workspaceDropdownOpened = false;
    const workspaceWaitMs = Math.min(10000, Math.max(250, limit / 4));
    for (let step = 0; step < MAX_STEPS && Date.now() < deadline && !cancelled; step += 1) {
      if (failure) throw failure;
      if (callbackUrl) {
        progress('browser_callback', '已收到目标空间授权回调，准备兑换并保存 JSON');
        return { callbackUrl };
      }
      const current = assertAuthPage(page.url());
      let safety;
      let emailFields;
      let passwordFields;
      let otpFields;
      let workspaceFields;
      try {
        safety = await page.evaluate(inspectPageSafety);
        emailFields = await controls(page, SELECTORS.email);
        passwordFields = await controls(page, SELECTORS.password);
        otpFields = await controls(page, SELECTORS.totp);
        workspaceFields = await workspaceControls(page);
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context with specified id|detached (?:frame|Frame)/i.test(String(error?.message || ''))) throw error;
        // Navigation invalidates DOM handles briefly. Re-read the next known
        // page before interacting; never retry a credential submission here.
        await new Promise((resolve) => setTimeout(resolve, Math.min(150, Math.max(1, deadline - Date.now()))));
        continue;
      }
      if (safety.challenge) throw new BrowserOAuthError('browser_oauth_verification_required');
      if (safety.rejected) {
        const error = new BrowserOAuthError('browser_oauth_credentials_rejected', { browserRequired: false });
        if (safety.passwordRejected) error.reason = 'password_invalid';
        throw error;
      }
      if (page.url() !== current.toString()) continue;
      const workspacePage = /^\/(?:workspace|sign-in-with-chatgpt\/codex\/consent)\/?$/.test(current.pathname);
      const stage = passwordFields.length ? 'password' : emailFields.length ? 'email' : otpFields.length ? 'totp'
        : workspaceFields.length || workspacePage ? 'workspace' : '';
      const submissionKey = `${current.pathname}:${stage}`;
      if (stage && !submitted.has(submissionKey)) {
        const entries = { email: emailFields, password: passwordFields, totp: otpFields, workspace: workspaceFields }[stage];
        if (stage !== 'workspace' && entries.length !== 1) throw new BrowserOAuthError('browser_oauth_control_unavailable');
        if (stage === 'email') {
          if (!/^\/log-in(?:-or-create-account|\/username)?\/?$/.test(current.pathname)) throw new BrowserOAuthError('browser_oauth_page_unsupported');
          if (!String(email || '').trim()) throw new BrowserOAuthError('browser_oauth_credentials_rejected', { status: 400 });
          progress('browser_email', '在官方登录页面提交账号邮箱');
          await submit(page, entries[0], String(email).trim());
        } else if (stage === 'password') {
          if (!/^\/log-in(?:\/password)?\/?$/.test(current.pathname)) throw new BrowserOAuthError('browser_oauth_page_unsupported');
          if (!password) throw new BrowserOAuthError('browser_oauth_credentials_rejected', { status: 400 });
          progress('browser_password', '在官方登录页面提交账号密码');
          await submit(page, entries[0], String(password));
        } else if (stage === 'totp') {
          if (!/^\/(?:mfa-challenge\/|mfa|two-factor|totp|authenticator|one-time-password)/.test(current.pathname)) {
            throw new BrowserOAuthError('browser_oauth_verification_required');
          }
          let code;
          try { code = await getTotpCode?.(); } catch { throw new BrowserOAuthError('browser_oauth_totp_required'); }
          if (!/^\d{6}$/.test(String(code || ''))) throw new BrowserOAuthError('browser_oauth_totp_required');
          credentialValues.add(String(code));
          progress('browser_totp', '提交账号的当前六位 2FA 验证码');
          await submit(page, entries[0], String(code));
        } else {
          if (!workspacePage) throw new BrowserOAuthError('browser_oauth_page_unsupported');
          let selected;
          try { selected = selectBrowserWorkspace(entries, String(workspaceId), workspaceMode); }
          catch (error) {
            if (error?.code !== 'browser_oauth_workspace_unavailable') throw error;
            if (!workspaceWaitStarted) {
              workspaceWaitStarted = Date.now();
              progress('browser_workspace_wait', '正在等待目标工作空间列表加载，不会选择个人空间或其他 Team');
            }
            if (!workspaceDropdownOpened) {
              const dropdowns = await controls(page, SELECTORS.workspaceDropdown);
              if (dropdowns.length === 1) {
                if (dropdowns[0].hasForm) assertControlAction(dropdowns[0], page.url());
                await dropdowns[0].handle.click();
                workspaceDropdownOpened = true;
              }
            }
            if (Date.now() - workspaceWaitStarted >= workspaceWaitMs) throw error;
            await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
            continue;
          }
          progress('browser_workspace', workspaceMode === 'team' ? '选择与目标 Team ID 完全匹配的工作空间，并核对实际选中值' : '选择个人工作空间');
          await submitWorkspace(page, selected, () => { workspaceSelected = true; }, deadline);
          workspaceWaitStarted = 0;
          workspaceDropdownOpened = false;
        }
        submitted.add(submissionKey);
      }
      if (callbackUrl || failure || page.url() !== current.toString()) continue;
      await new Promise((resolve) => setTimeout(resolve, Math.min(750, Math.max(1, deadline - Date.now()))));
    }
    throw new BrowserOAuthError('browser_oauth_timeout', { status: 408 });
  };
  try {
    const result = await Promise.race([
      execute(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          cancelled = true;
          reject(new BrowserOAuthError(navigating ? 'browser_oauth_navigation_timeout' : 'browser_oauth_timeout', navigating
            ? { status: 504, browserRequired: false, needsInput: false } : { status: 408 }));
        }, limit);
      }),
    ]);
    completed = true;
    return result;
  } catch (error) {
    const classified = classifyBrowserFailure(error);
    if (['browser_oauth_proxy_connection_failed', 'browser_oauth_network_failed', 'browser_oauth_browser_disconnected',
      'browser_oauth_navigation_timeout', 'browser_oauth_failed'].includes(classified.code)) {
      progress(classified.code, classified.message);
    }
    throw classified;
  } finally {
    cancelled = true;
    clearTimeout(timeout);
    try {
      const keepOpen = !completed && ownedSession?.keepOpenOnFailure === true;
      await ownedSession?.close(keepOpen ? { keepOpen: true } : undefined);
      if (keepOpen) progress('roxy_window_left_open', '本次授权未完成，已保留 Roxy 有头窗口，请查看官方提示后手动处理');
    }
    catch {
      // Cleanup must not discard an already captured, validated OAuth code
      // or hide the actual official verification failure.
      progress('roxy_cleanup_failed', 'Roxy 窗口关闭未完成，请在 Roxy 中检查并关闭本次窗口');
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
