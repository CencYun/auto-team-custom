import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { accessTokenClaims, decodeJwtPayload } from './openai-auth.mjs';
import { fetchSentinelToken } from './openai-sentinel.mjs';
import { completeBrowserOAuth } from './openai-browser-login.mjs';
import { isLoopbackHost } from './security.mjs';

const AUTH_BASE_URL = 'https://auth.openai.com';
const CHATGPT_BASE_URL = 'https://chatgpt.com';
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const TOKEN_ENDPOINTS = [
  'https://auth.openai.com/oauth/token',
  'https://auth.openai.com/api/oauth/oauth2/token',
];
const callbackInbox = new Map();

const browserHeaders = {
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.175 Safari/537.36',
  'sec-ch-ua': '"Google Chrome";v="151", "Chromium";v="151", "Not.A/Brand";v="24"',
  'sec-ch-ua-full-version-list': '"Google Chrome";v="151.0.7922.175", "Chromium";v="151.0.7922.175", "Not.A/Brand";v="24.0.0.0"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-ch-ua-platform-version': '"15.0.0"',
  'sec-ch-viewport-width': '"1365"',
};

export class OpenAiLoginError extends Error {
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.name = 'OpenAiLoginError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export function parseValidOAuthCallback(callbackUrl, expectedState = '') {
  let parsed;
  try { parsed = new URL(string(callbackUrl)); } catch { throw new OpenAiLoginError('callback_invalid', 'OAuth 回调地址无效', 400); }
  if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname) || parsed.pathname !== '/auth/callback'
    || parsed.username || parsed.password || parsed.hash
    || parsed.searchParams.getAll('code').length > 1 || parsed.searchParams.getAll('state').length > 1) {
    throw new OpenAiLoginError('callback_invalid', '请填写浏览器授权后的完整本机回调地址', 400);
  }
  if (!string(parsed.searchParams.get('code'))) throw new OpenAiLoginError('callback_code_missing', 'OAuth 回调缺少授权码', 400);
  const callbackState = parsed.searchParams.get('state') || '';
  if (!string(callbackState) || string(expectedState) && callbackState !== string(expectedState)) {
    throw new OpenAiLoginError('callback_state_mismatch', 'OAuth 回调状态不匹配，请使用当前账号和当前空间的授权回调地址', 400);
  }
  return parsed;
}

export function storeOAuthCallback(callbackUrl) {
  try {
    const url = parseValidOAuthCallback(callbackUrl);
    const state = string(url.searchParams.get('state'));
    const code = string(url.searchParams.get('code'));
    if (!state || !code) return false;
    callbackInbox.set(state, { url: url.toString(), expiresAt: Date.now() + 10 * 60 * 1000 });
    for (const [key, value] of callbackInbox) if (value.expiresAt <= Date.now()) callbackInbox.delete(key);
    return true;
  } catch {
    return false;
  }
}

export function consumeOAuthCallback(state) {
  const key = string(state);
  const value = callbackInbox.get(key);
  if (!value || value.expiresAt <= Date.now()) { callbackInbox.delete(key); return ''; }
  return value.url;
}

export function clearOAuthCallback(state, expectedUrl = '') {
  const key = string(state);
  const value = callbackInbox.get(key);
  if (!value || (expectedUrl && value.url !== expectedUrl)) return false;
  callbackInbox.delete(key);
  return true;
}

function string(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeJsonPart(value) {
  try {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function normalizeTotpSecret(secret) {
  const raw = string(secret).replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
  return raw.replace(/=+$/g, '');
}

function generateTotp(secret, timestamp = Date.now()) {
  const normalized = normalizeTotpSecret(secret);
  if (!normalized) return '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new OpenAiLoginError('totp_invalid', '2FA Secret 格式无效', 400);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(parseInt(bits.slice(offset, offset + 8), 2));
  const counter = Math.floor(timestamp / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counterBuffer).digest();
  const index = digest[digest.length - 1] & 0x0f;
  const value = ((digest[index] & 0x7f) << 24) | (digest[index + 1] << 16) | (digest[index + 2] << 8) | digest[index + 3];
  return String(value % 1_000_000).padStart(6, '0');
}

function extractCode(value) {
  if (Array.isArray(value)) {
    for (const item of value) { const code = extractCode(item); if (code) return code; }
    return '';
  }
  if (value && typeof value === 'object') {
    for (const key of ['code', 'otp', 'verification_code', 'verificationCode', 'passcode']) {
      const code = extractCode(value[key]);
      if (code) return code;
    }
    for (const key of ['body', 'text', 'html', 'content', 'message', 'subject']) {
      const code = extractCode(value[key]);
      if (code) return code;
    }
    for (const child of Object.values(value)) { const code = extractCode(child); if (code) return code; }
    return '';
  }
  const text = string(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const contextual = text.match(/(?:verification|security|login|sign[- ]?in|code|验证码)[^\d]{0,100}((?:\d[ -]?){6})/i)
    || text.match(/((?:\d[ -]?){6})[^\w]{0,100}(?:verification|security|login|sign[- ]?in|code)/i);
  const code = contextual?.[1] || text.match(/\b\d{6}\b/)?.[0] || '';
  return code.replace(/\D/g, '').slice(0, 6);
}

function createCookieJar(snapshot = {}) {
  const jar = new Map(Object.entries(snapshot || {}).filter(([key, value]) => key && value));
  function absorb(response) {
    const rawValues = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') || ''];
    // A Response reconstructed by the proxy layer can expose all Set-Cookie
    // fields as one combined value even through getSetCookie(). Split each raw
    // value again while preserving commas inside Expires attributes.
    const values = rawValues.flatMap((value) => String(value || '').split(/,(?=[^;,]+=)/g));
    for (const line of values) {
      const pair = String(line || '').split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!value || /max-age=0/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  }
  return {
    absorb,
    header: () => [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; '),
    snapshot: () => Object.fromEntries(jar),
    get: (name) => jar.get(name) || '',
  };
}

function authStep(url, name) {
  try { return new URL(url).pathname.toLowerCase().includes(name); } catch { return false; }
}

function isCallback(url) {
  return string(url).startsWith(DEFAULT_REDIRECT_URI) || string(url).startsWith(`${CHATGPT_BASE_URL}/api/auth/callback/openai`);
}

function pageUrl(payload, fallback = '') {
  if (!payload || typeof payload !== 'object') return fallback;
  const next = string(payload.page?.payload?.url || payload.continue_url || payload.continueUrl || payload.url || fallback);
  if (!next) return '';
  try { return new URL(next, AUTH_BASE_URL).toString(); } catch { return next; }
}

function responseErrorCode(payload, body = '') {
  const candidates = [
    payload?.error?.code,
    payload?.error?.type,
    payload?.code,
    typeof payload?.error === 'string' ? payload.error : '',
  ];
  for (const candidate of candidates) {
    const value = string(candidate).toLowerCase();
    if (/^[a-z0-9_.-]{1,80}$/.test(value)) return value;
  }
  const text = string(body).toLowerCase();
  if (text.includes('invalid_state')) return 'invalid_state';
  if (text.includes('sign-in session is no longer valid')) return 'signin_session_invalid';
  return '';
}

function responseErrorMessage(payload, body = '', fallback = '') {
  const candidates = [
    payload?.error?.message,
    payload?.error_description,
    payload?.detail,
    payload?.message,
    typeof payload?.error === 'string' ? payload.error : '',
    payload?.error?.code,
  ];
  const direct = candidates.map(string).find(Boolean);
  if (direct) return direct;
  const raw = string(body).trim();
  return raw && raw.length <= 500 ? raw : fallback;
}

function explicitAccountBanMessage(value = '') {
  const text = string(value).toLowerCase();
  if (/account[_ .-]*(?:deactivated|disabled|suspended|banned|terminated)|user[_ .-]*(?:deactivated|disabled|suspended|banned|terminated)|account[^\n]{0,120}(?:deleted|deactivated|disabled|suspended|banned|terminated)|账号已停用|账户已停用|账号已被删除|账户已被删除|账号已封|账号被封|封号|被封禁|账户被封|停用/.test(text)) return string(value);
  return '';
}

function stopOnForbidden(status, payload = {}, body = '') {
  if (Number(status) !== 403) return;
  const banned = explicitAccountBanMessage(`${responseErrorCode(payload, body)} ${responseErrorMessage(payload, body)}`);
  throw new OpenAiLoginError(
    banned ? 'account_banned' : 'protocol_verification_required',
    banned ? 'OpenAI 账号已被停用或封禁' : '官方接口拒绝本次登录，请在官方授权页完成验证后重试',
    403,
    { needsInput: true, browserRequired: !banned, upstreamStatus: 403 },
  );
}

function classifyChallenge(url, body = '', status = 0) {
  let path = '';
  try { path = new URL(url, AUTH_BASE_URL).pathname.toLowerCase(); } catch { path = string(url).toLowerCase(); }
  const value = `${url} ${body}`.toLowerCase();
  if (status >= 400 && explicitAccountBanMessage(value)) return 'account_banned';
  if (status === 403) return 'protocol_verification_required';
  if (/\/mfa|two-factor|two_factor|totp|authenticator|one-time-password/.test(path)) return 'totp_required';
  if (/email-verification|email_otp|passwordless/.test(path)) return 'email_otp_required';
  if (status < 400) return '';
  if (/turnstile|captcha|unsupported_country|country_region/.test(value)) return 'protocol_verification_required';
  if (/mfa|two-factor|two_factor|totp|authenticator|one-time-password/.test(value)) return 'totp_required';
  if (/email-verification|email_otp|passwordless/.test(value)) return 'email_otp_required';
  return '';
}

function sentinelHash(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function sentinelAnswer(seed, difficulty) {
  const started = Date.now();
  const data = [
    3000,
    new Date().toString(),
    4294705152,
    0,
    browserHeaders['user-agent'],
    'https://sentinel.openai.com/sentinel/20260219f9f6/sdk.js',
    '20260219f9f6',
    'zh-CN',
    'zh-CN,zh,en',
    0,
    `userAgent=${browserHeaders['user-agent']}`,
    'location',
    'navigator',
    0,
    randomUUID(),
    'sv',
    8,
    Date.now(),
    0, 1, 1, 0, 0, 0, 1,
  ];
  for (let attempt = 0; attempt < 500000; attempt += 1) {
    data[3] = attempt;
    data[9] = Date.now() - started;
    const encoded = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
    if (sentinelHash(`${seed}${encoded}`).slice(0, difficulty.length) <= difficulty) return `${encoded}~S`;
    if ((attempt + 1) % 5000 === 0) await Promise.resolve();
  }
  throw new OpenAiLoginError('sentinel_proof_failed', 'Sentinel proof 计算失败', 502);
}

function isProtocolAuthPage(url) {
  return ['/log-in', '/log-in/password', '/email-verification', '/mfa', '/two-factor', '/totp', '/authenticator', '/one-time-password', '/workspace', '/sign-in-with-chatgpt/codex/consent']
    .some((step) => authStep(url, step));
}

function workspaceListsFromObject(value, key = '', seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 16) return [];
  seen.add(value);
  const entries = [];
  if (Array.isArray(value)) {
    if (key === 'workspaces') {
      entries.push(value.filter((item) => item && typeof item === 'object'));
    }
    for (const item of value) entries.push(...workspaceListsFromObject(item, '', seen, depth + 1));
    return entries;
  }
  for (const [childKey, child] of Object.entries(value)) {
    entries.push(...workspaceListsFromObject(child, childKey, seen, depth + 1));
  }
  return entries;
}

function workspaceEntriesFromObject(value) {
  return workspaceListsFromObject(value).flat();
}

function workspaceEntryId(item) {
  if (!item || typeof item !== 'object') return '';
  return string(item.id || item.workspace_id || item.workspaceId);
}

function workspaceEntryIsPersonal(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.is_personal === true || item.isPersonal === true || item.personal === true) return true;
  const kind = string(item.kind || item.type || item.plan_type || item.planType).toLowerCase();
  return kind === 'personal' || kind === 'free';
}

function workspaceEntryIsTeam(item) {
  if (!item || typeof item !== 'object' || workspaceEntryIsPersonal(item)) return false;
  return ['team', 'business', 'enterprise'].includes(string(item.kind || item.type || item.plan_type || item.planType).toLowerCase());
}

function workspaceIdFromObject(value, preferredId = '', mode = 'free') {
  const workspaces = workspaceEntriesFromObject(value);
  const preferred = string(preferredId);
  if (preferred) {
    const matched = workspaces.find((item) => workspaceEntryId(item) === preferred);
    if (matched && (mode !== 'team' || !workspaceEntryIsPersonal(matched))) return preferred;
    if (mode === 'team') return '';
  }
  if (mode === 'team') return workspaceEntryId(workspaces.find((item) => workspaceEntryIsTeam(item)));
  return workspaceEntryId(workspaces.find((item) => workspaceEntryIsPersonal(item)));
}

function workspaceIdFromCookie(value, preferredId = '', mode = 'free') {
  const raw = string(value);
  if (!raw) return '';
  const candidates = [raw, (() => { try { return decodeURIComponent(raw); } catch { return ''; } })()];
  for (const candidate of candidates) {
    const decoded = decodeJsonPart(candidate.split('.')[0].replace(/^"|"$/g, ''));
    const selected = workspaceIdFromObject(decoded, preferredId, mode);
    if (selected) return selected;
  }
  return '';
}

function workspaceEntriesFromResponse(result) {
  const lists = workspaceListsFromObject(result?.payload);
  const html = string(result?.text);
  if (!html) return lists.length ? lists.flat() : null;
  const scripts = [];
  const scriptPattern = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    try { scripts.push(JSON.parse(match[1])); } catch { /* Ignore non-JSON page fragments. */ }
  }
  const nextData = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (nextData) {
    try { scripts.push(JSON.parse(nextData)); } catch { /* Ignore malformed page state. */ }
  }
  for (const value of scripts) {
    lists.push(...workspaceListsFromObject(value));
  }
  return lists.length ? lists.flat() : null;
}

function authorizationFromInput(input = {}) {
  if (!input || typeof input !== 'object') return null;
  const authUrl = string(input.authUrl || input.auth_url || input.url);
  if (!authUrl) return null;
  let parsed = null;
  try { parsed = new URL(authUrl); } catch { parsed = null; }
  return {
    source: string(input.source) || 'external',
    providerId: string(input.providerId || input.provider_id),
    authUrl,
    sessionId: string(input.sessionId || input.session_id),
    state: string(input.state) || string(parsed?.searchParams.get('state')),
    redirectUri: string(input.redirectUri || input.redirect_uri) || string(parsed?.searchParams.get('redirect_uri')) || DEFAULT_REDIRECT_URI,
  };
}

function sessionFromInput(input = {}) {
  const session = input && typeof input === 'object' ? input : {};
  return {
    state: string(session.state),
    codeVerifier: string(session.codeVerifier),
    currentUrl: string(session.currentUrl),
    callbackUrl: string(session.callbackUrl),
    callbackReceivedAt: string(session.callbackReceivedAt),
    phase: string(session.phase),
    deviceId: string(session.deviceId) || randomUUID(),
    cookies: session.cookies && typeof session.cookies === 'object' ? session.cookies : {},
    baselineMailbox: session.baselineMailbox && typeof session.baselineMailbox === 'object' ? session.baselineMailbox : null,
    authorization: authorizationFromInput(session.authorization),
    attempts: Number(session.attempts) || 0,
  };
}

function publicSession(session) {
  return {
    state: session.state,
    codeVerifier: session.codeVerifier,
    currentUrl: session.currentUrl,
    callbackUrl: session.callbackUrl,
    callbackReceivedAt: session.callbackReceivedAt,
    phase: session.phase,
    deviceId: session.deviceId,
    cookies: session.cookies,
    baselineMailbox: session.baselineMailbox,
    authorization: session.authorization,
    attempts: session.attempts,
  };
}

async function waitForMailboxCode(mailboxUrl, email, baseline, requestFetch, timeoutMs = 120000, mailboxHeaders = {}) {
  const target = string(mailboxUrl).replace(/\{email\}/gi, encodeURIComponent(email));
  if (!target) throw new OpenAiLoginError('email_otp_required', '需要邮箱验证码', 202);
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await requestFetch(target, { headers: { accept: 'application/json,text/plain,*/*', ...mailboxHeaders }, signal: AbortSignal.timeout(Math.min(15000, timeoutMs)) });
      const raw = await response.text().catch(() => '');
      if (!response.ok) last = `mailbox_http_${response.status}`;
      else {
        const code = extractCode(raw);
        const hash = createHash('sha256').update(raw).digest('hex');
        if (code && (!baseline || (baseline.hash !== hash && baseline.code !== code))) return code;
        if (code && !baseline) return code;
        last = code ? 'mailbox_code_unchanged' : 'mailbox_code_missing';
      }
    } catch (error) { last = error?.name === 'TimeoutError' ? 'mailbox_timeout' : 'mailbox_network_error'; }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new OpenAiLoginError('email_otp_timeout', `邮箱验证码获取超时（${last || '未收到新验证码'}）`, 408);
}

class LoginRunner {
  constructor(options = {}) {
    this.email = string(options.email).toLowerCase();
    this.password = string(options.password);
    this.totp = string(options.totp || options.secret);
    this.mailboxUrl = string(options.mailboxUrl);
    this.verificationCode = string(options.verificationCode);
    this.callbackUrl = string(options.callbackUrl);
    this.accountId = string(options.workspaceId || options.accountId);
    this.workspaceMode = options.workspaceMode === 'team' ? 'team' : 'free';
    this.requestFetch = options.fetch || fetch;
    this.sentinelProxy = options.sentinelProxy || options.browserProxy || null;
    this.browserLogin = options.browserLogin === true;
    this.protocolOnly = options.protocolOnly === true;
    this.browserOAuth = typeof options.browserOAuth === 'function' ? options.browserOAuth : completeBrowserOAuth;
    this.mailboxHeaders = options.mailboxHeaders && typeof options.mailboxHeaders === 'object' ? options.mailboxHeaders : {};
    this.timeoutMs = Number(options.timeoutMs) || 15000;
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    this.sentinelTokenProvider = typeof options.sentinelTokenProvider === 'function' ? options.sentinelTokenProvider : null;
    this.authorizationProvider = typeof options.authorizationProvider === 'function' ? options.authorizationProvider : null;
    this.callbackHandler = typeof options.callbackHandler === 'function' ? options.callbackHandler : null;
    this.session = sessionFromInput(options.session);
    this.jar = createCookieJar(this.session.cookies);
    // Page data belongs only to this runner's current OAuth session. Never
    // restore a previously observed account list from persisted state.
    this.protocolWorkspaces = null;
    this.protocolWorkspacePages = new Set();
    this.phase = this.session.phase || 'initializing';
  }

  progress(phase, message) {
    if (!['roxy_window_left_open', 'roxy_cleanup_failed'].includes(phase)) {
      this.phase = phase;
      this.session.phase = phase;
    }
    this.onProgress(phase, message);
  }

  async request(url, options = {}) {
    const headers = { ...browserHeaders, ...(options.headers || {}) };
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    let body = options.body;
    if (body && typeof body === 'object' && !(body instanceof URLSearchParams) && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
    const response = await this.requestFetch(url, {
      method: options.method || 'GET',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs || this.timeoutMs),
    });
    this.jar.absorb(response);
    const text = await response.text().catch(() => '');
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    stopOnForbidden(response.status, payload, text);
    const location = response.headers.get('location') || '';
    const result = { response, status: response.status, ok: response.ok || (response.status >= 300 && response.status < 400), text, payload, location: location ? new URL(location, url).toString() : '' };
    const parsedUrl = new URL(url);
    if (response.ok && parsedUrl.origin === AUTH_BASE_URL
      && (authStep(url, '/workspace') || authStep(url, '/sign-in-with-chatgpt/codex/consent'))) {
      this.protocolWorkspacePages.add(String(url));
      const workspaces = workspaceEntriesFromResponse(result);
      if (workspaces !== null) this.protocolWorkspaces = workspaces;
    }
    return result;
  }

  authorizeUrl() {
    this.session.state ||= base64Url(randomBytes(18));
    this.session.codeVerifier ||= base64Url(randomBytes(48));
    const query = new URLSearchParams({
      client_id: DEFAULT_CLIENT_ID,
      response_type: 'code',
      redirect_uri: DEFAULT_REDIRECT_URI,
      scope: 'openid email profile offline_access',
      state: this.session.state,
      code_challenge: pkceChallenge(this.session.codeVerifier),
      code_challenge_method: 'S256',
      prompt: 'login',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
    });
    return `${AUTH_BASE_URL}/oauth/authorize?${query.toString()}`;
  }

  currentAuthorizationUrl() {
    if (this.session.authorization?.authUrl) return this.session.authorization.authUrl;
    return this.authorizationProvider ? '' : this.authorizeUrl();
  }

  async prepareAuthorization() {
    if (this.session.authorization?.authUrl) return this.session.authorization.authUrl;
    if (!this.authorizationProvider) return this.authorizeUrl();
    this.progress('oauth_link', '正在从 Sub2API 获取 OAuth 授权链接');
    let provided;
    try {
      provided = authorizationFromInput(await this.authorizationProvider());
    } catch (error) {
      throw new OpenAiLoginError(error?.code || 'oauth_provider_failed', error?.message || 'Sub2API OAuth 授权链接获取失败', error?.status || 502);
    }
    if (!provided?.authUrl || !provided.state || !provided.sessionId) {
      throw new OpenAiLoginError('oauth_provider_response_invalid', 'Sub2API OAuth 授权响应缺少 auth_url、state 或 session_id', 502);
    }
    this.session.authorization = provided;
    this.session.state = provided.state;
    this.session.codeVerifier = '';
    return provided.authUrl;
  }

  async startAuthorization({ fresh = false } = {}) {
    if (fresh) {
      this.session.state = '';
      this.session.codeVerifier = '';
      this.session.currentUrl = '';
      this.session.callbackUrl = '';
      this.session.callbackReceivedAt = '';
      this.session.cookies = {};
      this.session.baselineMailbox = null;
      this.session.authorization = null;
      this.callbackUrl = '';
      this.jar = createCookieJar();
      this.protocolWorkspaces = null;
      this.protocolWorkspacePages.clear();
    }
    let current = await this.prepareAuthorization();
    for (let hop = 0; hop < 8; hop += 1) {
      if (isCallback(current)) return current;
      const result = await this.request(current, {
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': hop === 0 ? 'none' : 'same-origin',
        },
      });
      this.session.deviceId = this.jar.get('oai-did') || this.session.deviceId;
      if (result.status >= 400) throw new OpenAiLoginError('oauth_start_failed', responseErrorMessage(result.payload, result.text, `OAuth 会话创建失败（HTTP ${result.status}）`), result.status);
      if (!result.location) return current;
      current = result.location;
    }
    throw new OpenAiLoginError('oauth_start_redirects_exceeded', 'OAuth 入口重定向次数过多', 502);
  }

  async mailboxCode() {
    this.progress('waiting_code', '正在邮箱中等待登录验证码');
    if (this.verificationCode) return this.verificationCode;
    if (!this.mailboxUrl) throw new OpenAiLoginError('email_otp_required', '登录验证码已发送，请填写验证码后重试', 202, { needsInput: true });
    return waitForMailboxCode(this.mailboxUrl, this.email, this.session.baselineMailbox, this.requestFetch, Math.min(120000, Math.max(15000, this.timeoutMs * 8)), this.mailboxHeaders);
  }

  async captureMailboxBaseline() {
    if (!this.mailboxUrl || this.session.baselineMailbox) return;
    try {
      const target = this.mailboxUrl.replace(/\{email\}/gi, encodeURIComponent(this.email));
      const response = await this.requestFetch(target, { headers: { accept: 'application/json,text/plain,*/*', ...this.mailboxHeaders }, signal: AbortSignal.timeout(Math.min(10000, this.timeoutMs)) });
      const raw = await response.text().catch(() => '');
      if (response.ok) this.session.baselineMailbox = { hash: createHash('sha256').update(raw).digest('hex'), code: extractCode(raw) };
    } catch {
      // A mailbox baseline is optional; the provider can still return a new code.
    }
  }

  async sendAuthorizeContinue() {
    const sentinelToken = await this.sentinelToken('authorize_continue');
    this.progress('protocol_email', '正在通过协议提交登录邮箱');
    const result = await this.request(`${AUTH_BASE_URL}/api/accounts/authorize/continue`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'openai-sentinel-token': sentinelToken, origin: AUTH_BASE_URL, referer: `${AUTH_BASE_URL}/log-in-or-create-account?usernameKind=email`, 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' },
      body: { username: { kind: 'email', value: this.email } },
    });
    if (!result.ok) {
      const remoteCode = responseErrorCode(result.payload, result.text);
      if (result.status === 409 || remoteCode === 'invalid_state' || remoteCode === 'signin_session_invalid') {
        throw new OpenAiLoginError('authorize_state_invalid', 'OAuth 登录会话已失效', 409);
      }
      const challenge = classifyChallenge(result.location || '', result.text, result.status);
      const browserRequired = challenge === 'protocol_verification_required';
      const message = challenge === 'account_banned'
        ? responseErrorMessage(result.payload, result.text, 'OpenAI 账号已被停用或封禁')
        : browserRequired ? '登录需要浏览器验证' : responseErrorMessage(result.payload, result.text, '登录邮箱提交失败');
      throw new OpenAiLoginError(challenge || 'authorize_failed', message, result.status || 502, { browserRequired });
    }
    return pageUrl(result.payload, result.location || `${AUTH_BASE_URL}/email-verification`);
  }

  async sentinelToken(flow) {
    this.progress('protocol_sentinel', '正在检查官方登录验证要求');
    if (this.sentinelTokenProvider) {
      return this.sentinelTokenProvider({ flow, deviceId: this.session.deviceId, userAgent: browserHeaders['user-agent'], proxy: this.sentinelProxy });
    }
    let browserError = null;
    if (!this.protocolOnly) {
      try {
        return await fetchSentinelToken({
          flow,
          deviceId: this.session.deviceId,
          userAgent: browserHeaders['user-agent'],
          proxy: this.sentinelProxy,
          timeoutMs: Math.max(20000, this.timeoutMs),
        });
      } catch (error) {
        browserError = error;
      }
    }
    const seed = `${Date.now() / 1000}:${randomBytes(8).toString('hex')}`;
    const requirementProof = `gAAAAAC${await sentinelAnswer(seed, '0')}`;
    const response = await this.requestFetch('https://sentinel.openai.com/backend-api/sentinel/req', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': browserHeaders['user-agent'] },
      body: JSON.stringify({ p: requirementProof, id: this.session.deviceId, flow }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    stopOnForbidden(response.status, payload);
    if (!response.ok) throw new OpenAiLoginError('sentinel_requirements_failed', `Sentinel requirements 请求失败（HTTP ${response.status}）`, response.status || 502);
    if (payload.turnstile?.dx) {
      if (this.protocolOnly) throw new OpenAiLoginError('browser_verification_required', '官方要求浏览器安全验证，请手动完成后继续', 403, { browserRequired: true, needsInput: true, upstreamStatus: response.status });
      const reason = browserError?.message === 'sentinel_browser_unavailable'
        ? '未找到后台浏览器运行环境'
        : browserError?.message === 'sentinel_socks_auth_unsupported'
          ? '后台浏览器不支持带认证的 SOCKS 代理'
          : '后台 Sentinel 验证未通过';
      throw new OpenAiLoginError('sentinel_verification_failed', `${reason}，无法生成 Turnstile 令牌`, 502);
    }
    let proof = null;
    if (payload.proofofwork?.required && payload.proofofwork.seed && payload.proofofwork.difficulty) {
      proof = `gAAAAAB${await sentinelAnswer(String(payload.proofofwork.seed), String(payload.proofofwork.difficulty))}`;
    }
    return JSON.stringify({ p: proof, t: null, c: string(payload.token), id: this.session.deviceId, flow });
  }

  async verifyPassword() {
    const sentinelToken = await this.sentinelToken('password_verify');
    this.progress('protocol_password', '正在通过协议校验账号密码');
    const result = await this.request(`${AUTH_BASE_URL}/api/accounts/password/verify`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'openai-sentinel-token': sentinelToken, origin: AUTH_BASE_URL, referer: `${AUTH_BASE_URL}/log-in/password`, 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' },
      body: { password: this.password },
    });
    if (!result.ok) {
      const challenge = classifyChallenge(result.location || '', result.text, result.status);
      const browserRequired = challenge === 'protocol_verification_required';
      const message = challenge === 'account_banned'
        ? responseErrorMessage(result.payload, result.text, 'OpenAI 账号已被停用或封禁')
        : browserRequired ? '密码登录触发协议验证' : responseErrorMessage(result.payload, result.text, '账号密码校验失败');
      throw new OpenAiLoginError(challenge || 'password_invalid', message, result.status || 400, { needsInput: challenge === 'totp_required', browserRequired });
    }
    return pageUrl(result.payload, result.location);
  }

  async sendPasswordlessOtp() {
    await this.captureMailboxBaseline();
    const result = await this.request(`${AUTH_BASE_URL}/api/accounts/passwordless/send-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: AUTH_BASE_URL, referer: `${AUTH_BASE_URL}/log-in/password` },
    });
    if (!result.ok) {
      const challenge = classifyChallenge(result.location || '', result.text, result.status);
      const browserRequired = challenge === 'protocol_verification_required';
      const message = challenge === 'account_banned'
        ? responseErrorMessage(result.payload, result.text, 'OpenAI 账号已被停用或封禁')
        : browserRequired ? '登录需要浏览器验证' : responseErrorMessage(result.payload, result.text, '无法发送邮箱验证码');
      throw new OpenAiLoginError(challenge || 'otp_send_failed', message, result.status || 502, { browserRequired });
    }
    return pageUrl(result.payload, result.location || `${AUTH_BASE_URL}/email-verification`);
  }

  async validateEmailOtp(code) {
    const result = await this.request(`${AUTH_BASE_URL}/api/accounts/email-otp/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: AUTH_BASE_URL, referer: `${AUTH_BASE_URL}/email-verification` },
      body: { code },
    });
    if (!result.ok) throw new OpenAiLoginError('email_otp_invalid', responseErrorMessage(result.payload, result.text, '邮箱验证码无效或已过期'), result.status || 400);
    return pageUrl(result.payload, result.location);
  }

  async validateTotp(url) {
    this.progress('protocol_totp', '正在通过协议校验两步验证码');
    if (!this.totp) throw new OpenAiLoginError('totp_required', '登录需要 2FA 验证码，请补充 2FA Secret', 202, { needsInput: true });
    let challengeId = '';
    try {
      const path = new URL(url, AUTH_BASE_URL).pathname;
      challengeId = string(path.match(/^\/mfa-challenge\/([^/]+)/i)?.[1]);
    } catch {
      challengeId = '';
    }
    if (!challengeId) throw new OpenAiLoginError('totp_challenge_invalid', '2FA challenge ID 缺失', 502);
    const code = generateTotp(this.totp);
    const result = await this.request(`${AUTH_BASE_URL}/api/accounts/mfa/verify`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', origin: AUTH_BASE_URL, referer: url, 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' },
      body: { id: challengeId, type: 'totp', code },
    });
    if (result.ok) return pageUrl(result.payload, result.location || url);
    throw new OpenAiLoginError('totp_invalid', responseErrorMessage(result.payload, result.text, '2FA 验证失败'), result.status || 400);
  }

  async selectWorkspace(url) {
    this.progress('protocol_workspace', '正在读取并选择目标工作空间');
    let consentUrl = authStep(url, '/sign-in-with-chatgpt/codex/consent')
      ? url
      : `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`;
    if (authStep(url, '/workspace') && !this.protocolWorkspacePages.has(url)) {
      const page = await this.request(url, {
        headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', referer: `${AUTH_BASE_URL}/` },
      });
      if (page.status >= 400) throw new OpenAiLoginError('workspace_select_failed', '工作空间页面读取失败', page.status);
      if (page.location && (isCallback(page.location) || (isProtocolAuthPage(page.location) && !authStep(page.location, '/workspace') && !authStep(page.location, '/sign-in-with-chatgpt/codex/consent')))) return page.location;
      if (page.location && authStep(page.location, '/sign-in-with-chatgpt/codex/consent')) consentUrl = page.location;
    }
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const consent = await this.request(consentUrl, {
          headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', referer: `${AUTH_BASE_URL}/` },
        });
        if (consent.location && (isCallback(consent.location) || (isProtocolAuthPage(consent.location) && !authStep(consent.location, '/workspace') && !authStep(consent.location, '/sign-in-with-chatgpt/codex/consent')))) return consent.location;
        if (consent.status >= 400) {
          last = consent;
        } else {
          const workspaceId = this.protocolWorkspaces !== null
            ? workspaceIdFromObject({ workspaces: this.protocolWorkspaces }, this.accountId, this.workspaceMode)
            : workspaceIdFromCookie(this.jar.get('oai-client-auth-session'), this.accountId, this.workspaceMode);
          if (!workspaceId) {
            // The consent page can be an HTML shell while the browser session
            // loads the workspace list asynchronously. Do not turn an
            // unobservable list into a false "not a Team member" result.
            last = { status: 409, payload: {}, text: '' };
            throw new OpenAiLoginError(
              this.workspaceMode === 'team' && this.accountId ? 'workspace_list_unavailable' : 'workspace_required',
              this.workspaceMode === 'team' && this.accountId
                ? '授权页面未返回空间列表，请在官方授权页完成登录后重试'
                : '登录会话没有可选择的空间信息',
              409,
              { needsInput: true, browserRequired: true },
            );
          }
          const result = await this.request(`${AUTH_BASE_URL}/api/accounts/workspace/select`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: AUTH_BASE_URL, referer: consentUrl },
            body: { workspace_id: workspaceId },
          });
          if (result.ok) return pageUrl(result.payload, result.location || consentUrl);
          last = result;
        }
      } catch (error) {
        // A required official verification cannot be solved by repeating the
        // same consent request. Preserve the original OAuth session for the
        // browser callback rather than retrying an input-dependent failure.
        if (error instanceof OpenAiLoginError && (error.needsInput || error.browserRequired)) throw error;
        last = { status: error?.status || 0, error, payload: { code: error?.code, message: error?.message }, text: error?.message || '' };
      }
      if (![0, 408, 409, 425, 429, 500, 502, 503, 504].includes(Number(last?.status)) || attempt === 2) break;
      this.progress('workspace', `空间选择暂时失败，正在重试（${attempt + 2}/3）`);
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
    if (last?.error instanceof OpenAiLoginError) throw last.error;
    throw new OpenAiLoginError('workspace_select_failed', responseErrorMessage(last?.payload, last?.text, '空间选择失败'), last?.status || 502);
  }

  async followToCallback(url) {
    let current = url;
    for (let hop = 0; hop < 12 && current; hop += 1) {
      if (isCallback(current)) return current;
      const result = await this.request(current, { headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', referer: `${AUTH_BASE_URL}/` } });
      if (result.status < 400) {
        if (result.location) { current = result.location; continue; }
        if (isProtocolAuthPage(current)) return current;
      }
      const challenge = classifyChallenge(current, result.text, result.status);
      if (challenge) throw new OpenAiLoginError(challenge, '协议登录触发额外验证', result.status || 202, { needsInput: true });
      if (result.location) { current = result.location; continue; }
      if (result.status >= 400) throw new OpenAiLoginError('oauth_redirect_failed', 'OAuth 授权跳转失败', result.status);
      if (isProtocolAuthPage(current)) return current;
      break;
    }
    throw new OpenAiLoginError('oauth_callback_missing', '未能取得 OAuth 回调地址', 502);
  }

  async exchangeCode(callbackUrl) {
    const parsed = parseValidOAuthCallback(callbackUrl, this.session.state);
    if (!this.session.state) throw new OpenAiLoginError('callback_session_missing', '原 OAuth 会话已失效，请重新打开当前账号的授权链接', 409);
    const code = string(parsed.searchParams.get('code'));
    let last = null;
    for (const endpoint of TOKEN_ENDPOINTS) {
      const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: DEFAULT_CLIENT_ID, code, redirect_uri: DEFAULT_REDIRECT_URI, code_verifier: this.session.codeVerifier });
      const result = await this.request(endpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'codex-cli/0.91.0' }, body });
      if (result.ok) {
        const accessToken = string(result.payload.access_token || result.payload.accessToken);
        const refreshToken = string(result.payload.refresh_token || result.payload.refreshToken);
        const idToken = string(result.payload.id_token || result.payload.idToken);
        if (!accessToken || !refreshToken) throw new OpenAiLoginError('token_incomplete', 'OAuth 返回缺少 AT 或 RT', 502);
        const accessClaims = accessTokenClaims(accessToken);
        const idClaims = decodeJwtPayload(idToken);
        const idAuth = idClaims['https://api.openai.com/auth'] || idClaims.auth || {};
        const claims = {
          ...accessClaims,
          email: accessClaims.email || string(idClaims.email),
          accountId: accessClaims.accountId || string(idAuth.chatgpt_account_id || idClaims.chatgpt_account_id),
          userId: accessClaims.userId || string(idAuth.chatgpt_user_id || idClaims.chatgpt_user_id || idClaims.sub),
          planType: accessClaims.planType || string(idAuth.chatgpt_plan_type || idClaims.chatgpt_plan_type),
        };
        return { accessToken, refreshToken, idToken, claims, cookies: this.jar.snapshot() };
      }
      last = result;
      if (result.status !== 404 && result.status !== 405) break;
    }
    throw new OpenAiLoginError('token_exchange_failed', '授权码交换 Token 失败', last?.status || 502);
  }

  async completeCallback(callbackUrl) {
    const parsed = parseValidOAuthCallback(callbackUrl, this.session.state);
    if (!this.session.state) throw new OpenAiLoginError('callback_session_missing', '原 OAuth 会话已失效，请重新打开当前账号的授权链接', 409);
    const code = string(parsed.searchParams.get('code'));
    const callbackState = string(parsed.searchParams.get('state'));
    if (!this.callbackHandler && (!this.session.codeVerifier || this.session.authorization)) {
      throw new OpenAiLoginError('callback_session_missing', '原 OAuth 会话已失效，请重新打开当前账号的授权链接', 409);
    }
    if (this.session.callbackUrl !== parsed.toString() || !Number.isFinite(Date.parse(this.session.callbackReceivedAt))) {
      this.session.callbackReceivedAt = new Date().toISOString();
    }
    this.session.callbackUrl = parsed.toString();
    if (!this.callbackHandler) {
      const completed = await this.exchangeCode(callbackUrl);
      clearOAuthCallback(callbackState, parsed.toString());
      this.session.callbackUrl = '';
      this.session.callbackReceivedAt = '';
      if (isCallback(this.session.currentUrl)) this.session.currentUrl = '';
      return completed;
    }
    this.progress('oauth_exchange', '正在由 Sub2API 完成 OAuth 并生成 JSON');
    try {
      const completed = await this.callbackHandler({
        callbackUrl,
        code,
        state: callbackState || this.session.state,
        authorization: this.session.authorization,
      });
      if (!completed?.accessToken || !completed?.refreshToken) {
        throw new OpenAiLoginError('oauth_provider_token_incomplete', 'Sub2API OAuth 返回缺少 AT 或 RT', 502);
      }
      clearOAuthCallback(callbackState, parsed.toString());
      this.session.callbackUrl = '';
      this.session.callbackReceivedAt = '';
      if (isCallback(this.session.currentUrl)) this.session.currentUrl = '';
      return completed;
    } catch (error) {
      if (error instanceof OpenAiLoginError) throw error;
      throw new OpenAiLoginError(error?.code || 'oauth_provider_callback_failed', error?.message || 'Sub2API OAuth 回调处理失败', error?.status || 502);
    }
  }

  async run() {
    this.session.attempts += 1;
    try {
      const pendingCallback = this.callbackUrl || this.session.callbackUrl;
      if (pendingCallback) return await this.completeCallback(pendingCallback);
      if (isCallback(this.session.currentUrl)) return await this.completeCallback(this.session.currentUrl);
      if (!this.email || !this.password) throw new OpenAiLoginError('credentials_required', '请先填写邮箱和密码', 400);
      if (this.browserLogin) {
        this.progress('initializing', '正在创建独立浏览器登录会话');
        const authUrl = await this.prepareAuthorization();
        let completed;
        try {
          completed = await this.browserOAuth({
            authUrl,
            expectedState: this.session.state,
            redirectUri: new URL(authUrl).searchParams.get('redirect_uri'),
            email: this.email,
            password: this.password,
            workspaceId: this.accountId,
            workspaceMode: this.workspaceMode,
            getTotpCode: () => generateTotp(this.totp),
            verificationCode: this.verificationCode,
            proxy: this.sentinelProxy,
            onProgress: (phase, message) => this.progress(phase, message),
          });
          if (!completed?.callbackUrl) throw completed || {};
        } catch (error) {
          if (error?.code === 'browser_oauth_totp_required') {
            throw new OpenAiLoginError('totp_required', '请先填写有效的 2FA Secret 后重试', 202, { needsInput: true });
          }
          throw new OpenAiLoginError(error?.code || 'browser_login_failed', error?.message || '自动浏览器登录失败', error?.status || 502, {
            browserRequired: Boolean(error?.browserRequired), needsInput: Boolean(error?.needsInput),
          });
        }
        return await this.completeCallback(completed.callbackUrl);
      }
      let current = this.session.currentUrl;
      if (!current) {
        this.progress('initializing', '正在创建 OpenAI 登录会话');
        current = await this.startAuthorization();
        this.session.currentUrl = current;
      }
      let authRecoveryCount = 0;
      for (let step = 0; step < 10; step += 1) {
        this.session.currentUrl = current;
        if (isCallback(current)) return await this.completeCallback(current);
        if (authStep(current, '/log-in') && !authStep(current, '/log-in/password')) {
          try {
            current = await this.sendAuthorizeContinue();
          } catch (error) {
            if (error?.code !== 'authorize_state_invalid' || authRecoveryCount >= 2) throw error;
            authRecoveryCount += 1;
            this.progress('initializing', `OAuth 会话已失效，正在重新建立协议会话（${authRecoveryCount}/2）`);
            current = await this.startAuthorization({ fresh: true });
          }
          continue;
        }
        if (authStep(current, '/log-in/password')) {
          current = await this.verifyPassword();
          continue;
        }
        if (authStep(current, '/email-verification')) {
          const code = await this.mailboxCode();
          current = await this.validateEmailOtp(code);
          this.verificationCode = '';
          continue;
        }
        if (authStep(current, '/mfa') || authStep(current, '/two-factor') || authStep(current, '/totp') || authStep(current, '/authenticator') || authStep(current, '/one-time-password')) {
          current = await this.validateTotp(current);
          continue;
        }
        if (authStep(current, '/workspace') || authStep(current, '/sign-in-with-chatgpt/codex/consent')) {
          current = await this.selectWorkspace(current);
          continue;
        }
        if (authStep(current, '/add-phone')) {
          const message = '账号需要手机号验证，自动登录已停止，请完成接码后重试';
          this.progress('phone_verification_required', message);
          throw new OpenAiLoginError('phone_verification_required', message, 202, { needsInput: true });
        }
        if (current.startsWith(AUTH_BASE_URL)) {
          current = await this.followToCallback(current);
          continue;
        }
        throw new OpenAiLoginError('auth_step_unknown', '登录停在未识别的协议步骤', 202, { needsInput: true });
      }
      throw new OpenAiLoginError('auth_steps_exceeded', '登录步骤过多，已暂停本次操作', 502);
    } catch (error) {
      if (error instanceof OpenAiLoginError) throw error;
      const message = error?.name === 'TimeoutError' ? '登录请求超时' : '登录网络请求失败';
      throw new OpenAiLoginError(error?.name === 'TimeoutError' ? 'network_timeout' : 'network_error', message, 502);
    } finally {
      this.session.cookies = this.jar.snapshot();
      this.session.phase = this.phase;
    }
  }
}

export async function loginFreeAccount(options = {}) {
  if (options.callbackUrl) {
    try {
      parseValidOAuthCallback(options.callbackUrl, options.session?.state);
      if (!string(options.session?.state)) {
        throw new OpenAiLoginError('callback_session_missing', '原 OAuth 会话已失效，请重新打开当前账号的授权链接', 409);
      }
      if (typeof options.callbackHandler !== 'function' && (!string(options.session?.codeVerifier) || options.session?.authorization)) {
        throw new OpenAiLoginError('callback_session_missing', '原 OAuth 会话已失效，请重新打开当前账号的授权链接', 409);
      }
    } catch (error) {
      // Invalid manual input must not initialize a new state or replace the
      // authorization the user has already completed in the browser.
      return {
        ok: false,
        status: error.status || 400,
        code: error.code || 'callback_invalid',
        message: error.message || 'OAuth 回调地址无效',
        stage: string(options.session?.phase) || 'initializing',
        browserRequired: false,
        needsInput: true,
        authUrl: string(options.session?.authorization?.authUrl) || null,
        session: options.session ? {
          ...structuredClone(options.session),
          callbackUrl: string(options.session.callbackUrl),
          callbackReceivedAt: string(options.session.callbackReceivedAt),
        } : null,
      };
    }
  }
  let runner = new LoginRunner(options);
  let oauthFallback = null;
  try {
    const token = await runner.run();
    return { ok: true, status: 200, code: 'ready', stage: 'ready', ...token, session: publicSession(runner.session) };
  } catch (error) {
    const providerSessionInvalid = Number(error?.status) === 409
      && ['sub2api_oauth_session_expired', 'sub2api_oauth_session_invalid'].includes(error?.code);
    if (providerSessionInvalid) {
      // This is a provider-confirmed terminal failure, not a network retry.
      // Discard only this account's old callback before requesting a new
      // official session; the old authorization code can never be replayed.
      const oldState = runner.session.state;
      const oldAuthorization = runner.session.authorization;
      clearOAuthCallback(oldState);
      const freshOptions = { ...options, session: null, callbackUrl: '', verificationCode: '' };
      runner = new LoginRunner(freshOptions);
      if (options.singleAttempt === true) {
        // A batch account gets one attempt. Keep a fresh session for an
        // explicitly requested retry without starting another login here.
        return {
          ok: false, status: 202, code: 'oauth_session_expired', stage: 'oauth_link',
          message: '授权会话已过期，本次已结束，请选择此账号重试',
          needsInput: true, browserRequired: false, authUrl: null,
          session: publicSession(runner.session), sessionRecovered: false,
        };
      }
      try {
        if (oldAuthorization && !runner.authorizationProvider) {
          throw new OpenAiLoginError('oauth_provider_unavailable', '原 OAuth 提供方不可用，请恢复配置后重新获取授权链接', 409);
        }
        const authUrl = await runner.prepareAuthorization();
        let parsed;
        try { parsed = new URL(authUrl); } catch { parsed = null; }
        if (!parsed || parsed.origin !== AUTH_BASE_URL || parsed.pathname !== '/oauth/authorize'
          || parsed.searchParams.get('state') !== runner.session.state || runner.session.state === oldState
          || (oldAuthorization?.sessionId && runner.session.authorization?.sessionId === oldAuthorization.sessionId)) {
          throw new OpenAiLoginError('oauth_provider_response_invalid', '新的 OAuth 授权链接无效', 502);
        }
        const message = '旧授权会话已过期，已生成新的官方授权链接，请重新打开链接完成授权';
        runner.progress('browser_verification_required', message);
        return {
          ok: false, status: 202, code: 'oauth_session_expired', stage: runner.phase,
          message, needsInput: true, browserRequired: true, authUrl,
          session: publicSession(runner.session), sessionRecovered: true,
        };
      } catch (renewalError) {
        // Link creation may itself fail. Never restore the discarded code,
        // silently switch providers, or resume the old password-login flow.
        runner = new LoginRunner(freshOptions);
        return {
          ok: false, status: renewalError?.status || 502,
          code: renewalError?.code || 'oauth_provider_failed',
          message: renewalError?.message || '新的 OAuth 授权链接获取失败',
          stage: 'oauth_link', needsInput: false, browserRequired: false, authUrl: null,
          session: publicSession(runner.session), sessionRecovered: false,
        };
      }
    }
    const providerTransportFailure = runner.phase === 'oauth_link'
      && /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(String(error?.code || ''));
    const providerFailure = Boolean(options.authorizationProvider)
      && (/^sub2api_oauth_/i.test(String(error?.code || ''))
        || /^oauth_provider_/i.test(String(error?.code || '')) || providerTransportFailure);
    const localEntryFallback = options.allowLocalAuthorizationFallback === true && options.browserLogin === true
      && runner.phase === 'oauth_link' && !runner.session.authorization
      && (providerTransportFailure || Number(error?.status) >= 500);
    if ((options.singleAttempt !== true || localEntryFallback) && providerFailure && !runner.session.callbackUrl && !options.callbackUrl) {
      // An unavailable link provider precedes the first browser login. Use
      // local PKCE once without retrying a submitted login or existing code.
      runner.progress('oauth_local_fallback', '授权链接服务暂不可用，改用本机 OAuth 入口继续本次登录');
      oauthFallback = {
        code: error?.code || 'oauth_provider_failed',
        message: error?.message || '外部 OAuth 服务不可用',
      };
      runner = new LoginRunner({
        ...options,
        authorizationProvider: null,
        callbackHandler: null,
        session: null,
        callbackUrl: '',
      });
      try {
        const token = await runner.run();
        return {
          ok: true,
          status: 200,
          code: 'ready',
          stage: 'ready',
          ...token,
          session: publicSession(runner.session),
          oauthFallback,
        };
      } catch (retryError) {
        error = retryError;
      }
    }
    const staleSession = ['authorize_state_invalid', 'signin_session_invalid'].includes(error?.code)
      || /sign-in session is no longer valid|your login session has expired|oauth (?:login )?session (?:is )?(?:invalid|expired)/i.test(String(error?.message || ''));
    if (staleSession && !runner.session.callbackUrl && (!options.callbackUrl || oauthFallback)) {
      runner = new LoginRunner({
        ...options,
        ...(oauthFallback ? { authorizationProvider: null, callbackHandler: null } : {}),
        session: null,
        callbackUrl: '',
      });
      if (options.singleAttempt !== true) {
        try {
          const token = await runner.run();
          return { ok: true, status: 200, code: 'ready', stage: 'ready', ...token, session: publicSession(runner.session), sessionRecovered: true, ...(oauthFallback ? { oauthFallback } : {}) };
        } catch (retryError) {
          error = retryError;
        }
      }
    }
    const browserRequired = Boolean(error.browserRequired)
      || ['protocol_verification_required', 'sentinel_verification_failed'].includes(error.code);
    return {
      ok: false,
      status: error.status || 502,
      upstreamStatus: error.upstreamStatus || null,
      code: error.code || 'login_failed',
      message: error.message || '登录失败',
      stage: runner.phase,
      browserRequired,
      needsInput: Boolean(error.needsInput),
      authUrl: runner.currentAuthorizationUrl(),
      session: publicSession(runner.session),
      ...(oauthFallback ? { oauthFallback } : {}),
    };
  }
}

export { generateTotp, classifyChallenge };
