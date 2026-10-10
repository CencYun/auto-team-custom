import puppeteer from 'puppeteer-core';
import { createProxyChainRelay } from './proxy-chain.mjs';

export const DEFAULT_ROXY_CONFIG = Object.freeze({
  enabled: false,
  headless: false,
  useProxyPool: false,
  concurrency: 1,
  baseUrl: 'http://127.0.0.1:50000',
  apiKey: '',
  workspaceId: '',
  profiles: Object.freeze([]),
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const activeProfiles = new Set();
const retainedProfileRelays = new Map();
const MESSAGES = {
  roxy_config_invalid: 'Roxy 配置格式无效',
  roxy_concurrency_invalid: 'Roxy 并发数必须是 1 到 3 的整数',
  roxy_api_base_invalid: 'Roxy API 地址必须是本机 HTTP 地址，不能包含路径或登录信息',
  roxy_api_key_missing: '请先配置 Roxy API 密钥',
  roxy_workspace_missing: '请先选择 Roxy 团队',
  roxy_disabled: 'Roxy 自动化未启用',
  roxy_profile_missing: '该账号尚未绑定 Roxy 窗口，请在参数配置中配置',
  roxy_profile_conflict: '每个账号需要独立的 Roxy 窗口，不能重复绑定',
  roxy_profile_ambiguous: 'Roxy 中存在多个属于该账号的窗口，请在参数配置中手动选择正确窗口',
  roxy_profile_list_incomplete: '未能完整核对 Roxy 窗口列表，暂未创建新窗口，请稍后重试',
  roxy_profile_limit: '已达到本工具的 Roxy 窗口绑定上限，请先清理不再使用的账号绑定',
  roxy_profile_busy: '该 Roxy 窗口已打开或正在执行任务，请先结束占用后重试',
  roxy_proxy_pool_disabled: 'Roxy 已启用代理池，但工具代理池尚未开启，请先启用代理池',
  roxy_proxy_missing: '该账号绑定的代理不存在或不可用，请在 Roxy 配置中重新选择代理',
  roxy_proxy_invalid: 'Roxy 代理格式无效或协议不支持，请使用 HTTP、HTTPS 或 SOCKS5 代理',
  roxy_proxy_chain_failed: '无法建立本机前置代理到账号固定代理的链路，请检查两端代理设置',
  roxy_api_unavailable: '无法连接 Roxy 本机 API，请检查应用、API 开关与端口',
  roxy_api_timeout: 'Roxy 本机 API 请求超时',
  roxy_api_auth_failed: 'Roxy API 密钥无效或没有访问权限',
  roxy_api_rate_limited: 'Roxy API 请求过于频繁，请稍后重试',
  roxy_entitlement_unavailable: 'Roxy 当前套餐或权限不允许此操作，请在 Roxy 中检查',
  roxy_api_failed: 'Roxy API 操作失败，请在 Roxy 中检查窗口与套餐状态',
  roxy_response_invalid: 'Roxy API 返回格式无效',
  roxy_cdp_invalid: 'Roxy 返回的浏览器调试地址不是有效本机地址',
  roxy_connect_failed: '无法连接 Roxy 浏览器窗口，请检查内核与自动化权限',
  roxy_cleanup_failed: 'Roxy 授权窗口未能自动关闭，请在 Roxy 中检查并关闭该窗口',
};

export class RoxyBrowserError extends Error {
  constructor(code, { status = 409 } = {}) {
    super(MESSAGES[code] || MESSAGES.roxy_api_failed);
    this.name = 'RoxyBrowserError';
    this.code = MESSAGES[code] ? code : 'roxy_api_failed';
    this.status = status;
    this.browserRequired = true;
    this.needsInput = true;
  }
}

function fail(code, status = 400) {
  throw new RoxyBrowserError(code, { status });
}

function identifier(value, { optional = false } = {}) {
  if (typeof value !== 'string') fail('roxy_config_invalid');
  const result = value.trim();
  if (optional && !result) return '';
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(result)) fail('roxy_config_invalid');
  return result;
}

export function normalizeRoxyApiBase(value = DEFAULT_ROXY_CONFIG.baseUrl) {
  let url;
  try { url = new URL(value); } catch { fail('roxy_api_base_invalid'); }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('roxy_api_base_invalid');
  }
  return url.origin;
}

export function normalizeRoxyConfig(input = {}, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !previous || typeof previous !== 'object' || Array.isArray(previous)) fail('roxy_config_invalid');
  const value = { ...DEFAULT_ROXY_CONFIG, ...previous, ...input };
  if (!Number.isInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 3) fail('roxy_concurrency_invalid');
  if (typeof value.enabled !== 'boolean' || typeof value.headless !== 'boolean'
    || typeof value.useProxyPool !== 'boolean' || typeof value.baseUrl !== 'string'
    || typeof value.apiKey !== 'string' || !Array.isArray(value.profiles)) fail('roxy_config_invalid');
  const apiKey = value.apiKey.trim();
  if (apiKey.length > 1024 || /[\r\n]/.test(apiKey) || value.profiles.length > 1000) fail('roxy_config_invalid');
  const workspaceId = identifier(value.workspaceId, { optional: true });
  const children = new Set();
  const directories = new Set();
  const profiles = value.profiles.map((profile) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) fail('roxy_config_invalid');
    const childId = identifier(profile.childId);
    const dirId = identifier(profile.dirId);
    const proxyId = profile.proxyId === undefined ? '' : identifier(profile.proxyId, { optional: true });
    if (children.has(childId) || directories.has(dirId)) fail('roxy_profile_conflict');
    children.add(childId);
    directories.add(dirId);
    return { childId, dirId, ...(proxyId ? { proxyId } : {}) };
  });
  const config = { enabled: value.enabled, headless: value.headless, useProxyPool: value.useProxyPool, concurrency: value.concurrency,
    baseUrl: normalizeRoxyApiBase(value.baseUrl), apiKey, workspaceId, profiles };
  if (config.enabled && !apiKey) fail('roxy_api_key_missing');
  if (config.enabled && !workspaceId) fail('roxy_workspace_missing');
  return config;
}

export function publicRoxyConfig(config = {}) {
  return {
    enabled: config.enabled === true,
    headless: config.headless === true,
    useProxyPool: config.useProxyPool === true,
    concurrency: config.concurrency ?? DEFAULT_ROXY_CONFIG.concurrency,
    baseUrl: config.baseUrl || DEFAULT_ROXY_CONFIG.baseUrl,
    apiKeySet: Boolean(config.apiKey),
    workspaceId: config.workspaceId || '',
    profiles: Array.isArray(config.profiles) ? config.profiles.map(({ childId, dirId, proxyId }) => ({ childId, dirId, ...(proxyId ? { proxyId } : {}) })) : [],
  };
}

export function roxyProxyInfo(proxyEntry) {
  if (!proxyEntry || typeof proxyEntry !== 'object' || Array.isArray(proxyEntry)
    || proxyEntry.enabled === false || !proxyEntry.url) fail('roxy_proxy_missing', 409);
  let url;
  let username;
  let password;
  try {
    url = new URL(proxyEntry.url);
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch { fail('roxy_proxy_invalid'); }
  const categories = { 'http:': 'HTTP', 'https:': 'HTTPS', 'socks:': 'SOCKS5', 'socks5:': 'SOCKS5', 'socks5h:': 'SOCKS5' };
  const proxyCategory = categories[url.protocol];
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'http:' ? 80 : url.protocol === 'https:' ? 443 : 1080));
  if (!proxyCategory || !host || (url.pathname && url.pathname !== '/') || url.search || url.hash
    || !Number.isInteger(port) || port < 1 || port > 65535
    || /[\r\n\0]/.test(username + password) || username.length > 1024 || password.length > 1024) {
    fail('roxy_proxy_invalid');
  }
  // moduleId references a proxy saved inside Roxy. A custom endpoint has no
  // such ID; even "0" is rejected as nonexistent by some Local API versions.
  return { proxyMethod: 'custom', proxyCategory, ipType: host.includes(':') ? 'IPV6' : 'IPV4',
    host, port: String(port), proxyUserName: username, proxyPassword: password };
}

function pagination({ pageIndex = 1, pageSize = 15 } = {}) {
  if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > 10000
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('roxy_config_invalid');
  return { page_index: pageIndex, page_size: pageSize };
}

function paginated(data, project) {
  if (!data || !Array.isArray(data.rows) || !Number.isSafeInteger(data.total) || data.total < 0
    || data.rows.length > 100) fail('roxy_response_invalid', 502);
  try { return { total: data.total, rows: data.rows.map(project) }; }
  catch (error) {
    if (error instanceof RoxyBrowserError && error.code === 'roxy_response_invalid') throw error;
    fail('roxy_response_invalid', 502);
  }
}

function text(value) { return typeof value === 'string' ? value.slice(0, 500) : ''; }

async function readJson(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_RESPONSE_BYTES) fail('roxy_response_invalid', 502);
  let body = '';
  let bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) fail('roxy_response_invalid', 502);
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail('roxy_response_invalid', 502);
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  try { return JSON.parse(body); } catch { fail('roxy_response_invalid', 502); }
}

// Endpoint names and the token header follow Roxy's official Local API docs.
export function createRoxyApiClient(config = {}, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const baseUrl = normalizeRoxyApiBase(config.baseUrl || DEFAULT_ROXY_CONFIG.baseUrl);
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) fail('roxy_api_key_missing');
  const apiKey = config.apiKey.trim();
  if (apiKey.length > 1024 || /[\r\n]/.test(apiKey)) fail('roxy_config_invalid');
  const timeout = Math.min(60000, Math.max(100, Number(timeoutMs) || 15000));
  const request = async (path, { method = 'GET', query = {}, body } = {}) => {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(url, {
        method, headers: { token: apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) fail('roxy_api_auth_failed', response.status);
        if (response.status === 429) fail('roxy_api_rate_limited', 429);
        fail('roxy_api_failed', 502);
      }
      const result = await readJson(response);
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Number.isInteger(result.code)) {
        fail('roxy_response_invalid', 502);
      }
      if (result.code !== 0) {
        if (/过期|套餐|订阅|权限|expired|subscription|permission|entitlement/i.test(String(result.msg || ''))) {
          fail('roxy_entitlement_unavailable', 409);
        }
        fail('roxy_api_failed', 502);
      }
      return result.data;
    } catch (error) {
      if (error instanceof RoxyBrowserError) throw error;
      fail(controller.signal.aborted ? 'roxy_api_timeout' : 'roxy_api_unavailable', 503);
    } finally { clearTimeout(timer); }
  };
  return {
    async health() { await request('/health'); return { ok: true }; },
    async listWorkspaces(options = {}) {
      return paginated(await request('/browser/workspace', { query: pagination(options) }), (row) => ({
        id: identifier(row.id), workspaceName: text(row.workspaceName),
      }));
    },
    async listProfiles(workspaceId, options = {}) {
      return paginated(await request('/browser/list_v3', { query: { workspaceId: identifier(workspaceId), ...pagination(options) } }), (row) => ({
        dirId: identifier(row.dirId), windowSortNum: Number.isSafeInteger(row.windowSortNum) ? row.windowSortNum : null,
        windowName: text(row.windowName), windowRemark: text(row.windowRemark), coreType: text(row.coreType), coreVersion: text(row.coreVersion),
      }));
    },
    async createProfile(workspaceId, { windowName, windowRemark } = {}) {
      if (typeof windowName !== 'string' || !windowName.trim() || windowName.length > 200
        || typeof windowRemark !== 'string' || !windowRemark.trim() || windowRemark.length > 500) fail('roxy_config_invalid');
      // Official Local API create-browser-profile contract: workspaceId is
      // required; name, remark and OS are optional. No account secrets are sent.
      const data = await request('/browser/create', { method: 'POST', body: {
        workspaceId: identifier(workspaceId), windowName, windowRemark,
        os: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
        coreType: 'Chrome',
      } });
      try { return { dirId: identifier(data?.dirId) }; }
      catch { fail('roxy_response_invalid', 502); }
    },
    async connectionInfo(dirId) {
      const data = await request('/browser/connection_info', { query: { dirIds: identifier(dirId) } });
      if (!Array.isArray(data) || data.length > 1000) fail('roxy_response_invalid', 502);
      return data.map((row) => {
        try { return { dirId: identifier(row.dirId) }; }
        catch { fail('roxy_response_invalid', 502); }
      });
    },
    async updateProxy(workspaceId, dirId, proxyEntry) {
      // Official Local API: https://roxybrowser.com/docs/api-documentation/api-endpoint.html
      // Only update the proxy. Omitted profile, session and fingerprint fields remain untouched.
      await request('/browser/mdf', { method: 'POST', body: {
        workspaceId: identifier(workspaceId), dirId: identifier(dirId), proxyInfo: roxyProxyInfo(proxyEntry),
      } });
    },
    async open(workspaceId, dirId, { headless = false } = {}) {
      if (typeof headless !== 'boolean') fail('roxy_config_invalid');
      const data = await request('/browser/open', { method: 'POST', body: {
        workspaceId: identifier(workspaceId), dirId: identifier(dirId), forceOpen: false, headless,
      } });
      return { ws: data?.ws };
    },
    async close(dirId) { await request('/browser/close', { method: 'POST', body: { dirId: identifier(dirId) } }); },
  };
}

export async function resolveRoxyAccountProfile(config, childId, { email = '', client } = {}) {
  const normalized = normalizeRoxyConfig(config);
  const id = identifier(childId);
  if (!normalized.enabled) fail('roxy_disabled', 409);
  const bound = normalized.profiles.find((profile) => profile.childId === id);
  if (bound) return { ...bound, source: 'bound' };
  if (normalized.profiles.length >= 1000) fail('roxy_profile_limit', 409);
  const api = client || createRoxyApiClient(normalized);
  const marker = `auto-team:child:${id}`;
  const seen = new Set();
  const matches = [];
  let total;
  for (let pageIndex = 1; ; pageIndex += 1) {
    // Never create on a partial listing: a previous create may have succeeded
    // before local persistence was interrupted. Recover only our exact marker.
    if (pageIndex > 100) fail('roxy_profile_list_incomplete', 409);
    const page = await api.listProfiles(normalized.workspaceId, { pageIndex, pageSize: 100 });
    if (total !== undefined && page.total !== total) fail('roxy_profile_list_incomplete', 409);
    total = page.total;
    for (const profile of page.rows) {
      if (seen.has(profile.dirId)) fail('roxy_profile_list_incomplete', 409);
      seen.add(profile.dirId);
      if (profile.windowRemark === marker) matches.push(profile);
    }
    if (seen.size === total) break;
    if (!page.rows.length || seen.size > total) fail('roxy_profile_list_incomplete', 409);
  }
  if (matches.length > 1) fail('roxy_profile_ambiguous', 409);
  const existing = matches[0];
  if (existing && normalized.profiles.some((profile) => profile.dirId === existing.dirId)) {
    fail('roxy_profile_conflict', 409);
  }
  const profile = existing || await api.createProfile(normalized.workspaceId, {
    windowName: `AutoTeam ${String(email || id).replace(/[\r\n]/g, '').slice(0, 170)}`,
    windowRemark: marker,
  });
  if (normalized.profiles.some((entry) => entry.dirId === profile.dirId)) fail('roxy_profile_conflict', 409);
  return { childId: id, dirId: profile.dirId, source: existing ? 'recovered' : 'created' };
}

export function validateRoxyCdpEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { fail('roxy_cdp_invalid', 502); }
  if (url.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(url.hostname) || !url.port
    || url.username || url.password || url.search || url.hash
    || !/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(url.pathname)) fail('roxy_cdp_invalid', 502);
  return url.toString();
}

export function createRoxyCdpTransport(endpoint, { timeoutMs = 30000, WebSocketImpl = globalThis.WebSocket } = {}) {
  const url = validateRoxyCdpEndpoint(endpoint);
  return new Promise((resolve, reject) => {
    let socket;
    let opened = false;
    let failed = false;
    const stop = () => { try { socket?.close(); } catch { /* Closing a failed handshake is best effort. */ } };
    const failure = () => {
      clearTimeout(timer);
      if (!opened) { failed = true; reject(new RoxyBrowserError('roxy_connect_failed', { status: 503 })); }
    };
    const timer = setTimeout(() => { failure(); stop(); }, Math.min(60000, Math.max(100, Number(timeoutMs) || 30000)));
    try {
      // The native WebSocket rejects redirects; Puppeteer's default transport follows them.
      socket = new WebSocketImpl(url);
      socket.binaryType = 'arraybuffer';
      const transport = {
        onmessage: undefined,
        onclose: undefined,
        send(message) { socket.send(message); },
        close() { stop(); },
      };
      socket.addEventListener('message', ({ data }) => {
        transport.onmessage?.(typeof data === 'string' ? data : new TextDecoder().decode(data));
      });
      socket.addEventListener('close', () => { failure(); transport.onclose?.(); });
      socket.addEventListener('error', failure);
      socket.addEventListener('open', () => {
        if (failed) { stop(); return; }
        opened = true;
        clearTimeout(timer);
        resolve(transport);
      }, { once: true });
    } catch { failure(); stop(); }
  });
}

async function connectRoxyBrowser({ browserWSEndpoint, ...options }) {
  const transport = await createRoxyCdpTransport(browserWSEndpoint, { timeoutMs: options.protocolTimeout });
  try { return await puppeteer.connect({ ...options, transport }); }
  catch { transport.close(); fail('roxy_connect_failed', 503); }
}

async function releaseRetainedProfileRelay(leaseKey) {
  const retained = retainedProfileRelays.get(leaseKey);
  if (!retained) return;
  retainedProfileRelays.delete(leaseKey);
  clearTimeout(retained.timer);
  await retained.relay.close();
}

function retainProfileRelay(leaseKey, relay, api, dirId) {
  const retained = { relay, timer: null };
  retainedProfileRelays.set(leaseKey, retained);
  const check = async () => {
    if (retainedProfileRelays.get(leaseKey) !== retained) return;
    try {
      const connections = await api.connectionInfo(dirId);
      if (retainedProfileRelays.get(leaseKey) !== retained) return;
      if (!connections.some((entry) => entry.dirId === dirId)) {
        await releaseRetainedProfileRelay(leaseKey);
        return;
      }
    } catch { /* Keep a visible browser usable until it is known to be closed. */ }
    if (retainedProfileRelays.get(leaseKey) === retained) {
      retained.timer = setTimeout(check, 15000);
      retained.timer.unref?.();
    }
  };
  retained.timer = setTimeout(check, 15000);
  retained.timer.unref?.();
}

export async function openRoxyBrowserSession({ config, childId, proxyEntry, localProxyUrl = '', timeoutMs = 30000 }, {
  client, connect = connectRoxyBrowser, createRelay = createProxyChainRelay,
} = {}) {
  const normalized = normalizeRoxyConfig(config);
  if (!normalized.enabled) fail('roxy_disabled', 409);
  const profile = normalized.profiles.find((entry) => entry.childId === childId);
  if (!profile) fail('roxy_profile_missing', 409);
  if (normalized.useProxyPool) {
    roxyProxyInfo(proxyEntry);
    if (profile.proxyId && profile.proxyId !== proxyEntry.id) fail('roxy_proxy_missing', 409);
  }
  const leaseKey = `${normalized.baseUrl}:${profile.dirId}`;
  if (activeProfiles.has(leaseKey)) fail('roxy_profile_busy', 409);
  activeProfiles.add(leaseKey);
  const api = client || createRoxyApiClient(normalized, { timeoutMs });
  let browser;
  let page;
  let owned = false;
  let closed = false;
  let relay;
  const close = async ({ keepOpen = false } = {}) => {
    if (closed) return;
    closed = true;
    let retainWindow = keepOpen === true && normalized.headless === false && owned && browser && page;
    try {
      if (!retainWindow) await page?.close().catch(() => {});
      try { await browser?.disconnect(); } catch { /* Never close a user's unrelated browser. */ }
      if (owned && !retainWindow) {
        try { await api.close(profile.dirId); }
        catch { retainWindow = true; fail('roxy_cleanup_failed', 503); }
      }
    } finally {
      try {
        if (relay) {
          if (retainWindow) retainProfileRelay(leaseKey, relay, api, profile.dirId);
          else await relay.close();
        }
      } finally { activeProfiles.delete(leaseKey); }
    }
  };
  try {
    const connections = await api.connectionInfo(profile.dirId);
    if (connections.some((entry) => entry.dirId === profile.dirId)) fail('roxy_profile_busy', 409);
    await releaseRetainedProfileRelay(leaseKey);
    if (normalized.useProxyPool) {
      if (localProxyUrl) {
        try { relay = await createRelay({ localProxyUrl, upstreamProxyUrl: proxyEntry.url, timeoutMs }); }
        catch { fail('roxy_proxy_chain_failed', 503); }
      }
      // Roxy sees a per-account loopback relay; the stored binding and backend
      // still identify the actual upstream. The relay dials it via the local proxy.
      await api.updateProxy(normalized.workspaceId, profile.dirId, relay ? { ...proxyEntry, url: relay.url } : proxyEntry);
    }
    const opened = await api.open(normalized.workspaceId, profile.dirId, { headless: normalized.headless });
    owned = true;
    const browserWSEndpoint = validateRoxyCdpEndpoint(opened.ws);
    try {
      browser = await connect({ browserWSEndpoint, defaultViewport: null,
        protocolTimeout: Math.min(60000, Math.max(1000, Number(timeoutMs) || 30000)) });
      // A dedicated existing profile retains its normal login session; no incognito or fingerprint changes.
      page = await browser.newPage();
    } catch { fail('roxy_connect_failed', 503); }
    return { page, close, keepOpenOnFailure: normalized.headless === false };
  } catch (error) {
    await close();
    throw error instanceof RoxyBrowserError ? error : new RoxyBrowserError('roxy_api_failed', { status: 502 });
  }
}
