import { createHash } from 'node:crypto';
import { OPENAI_OAUTH_CLIENT_ID, accessTokenClaims, decodeJwtPayload } from './openai-auth.mjs';

const TEAM_PLANS = new Set(['team', 'business', 'self_serve_business_prolite']);
const PERSONAL_PLANS = new Set(['free', 'plus', 'pro', 'go', 'chatgptplus', 'chatgptpro']);
const normalized = (value) => String(value || '').trim().toLowerCase();

// This validates the saved credential's identity, not its current server-side
// authorization. Export never refreshes credentials or contacts OpenAI.
export function savedExportCredential(record, { scope, workspaceId = '', nowMs = Date.now() } = {}) {
  if (!record || !['free', 'team'].includes(scope)) return null;
  if (record.status === 'banned' || record.banStatus === 'banned') return null;
  const accessToken = String(record.accessToken || '').trim();
  const refreshToken = String(record.refreshToken || '').trim();
  const email = String(record.email || '').trim();
  if (!accessToken || !refreshToken || !/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  // Mother records can also hold a ChatGPT browser management session. Only
  // the Codex OAuth client is an account JSON credential for these exports.
  const jwt = decodeJwtPayload(accessToken);
  if (jwt.client_id !== OPENAI_OAUTH_CLIENT_ID) return null;
  let claims;
  let idClaims;
  try {
    claims = accessTokenClaims(accessToken);
    idClaims = accessTokenClaims(record.idToken);
  } catch { return null; }
  const expiresAt = Date.parse(claims.expiresAt || '');
  const plan = normalized(claims.planType);
  const accountId = String(claims.accountId || '').trim();
  if (!Number.isFinite(expiresAt) || !accountId || !claims.userId) return null;
  if (!(scope === 'team' ? TEAM_PLANS : PERSONAL_PLANS).has(plan)) return null;
  if (scope === 'team' && (!workspaceId || normalized(accountId) !== normalized(workspaceId))) return null;
  if (record.accountId && normalized(record.accountId) !== normalized(accountId)) return null;
  const expectedUserId = String(record.chatgptUserId || record.userId || '').trim();
  if (expectedUserId && claims.userId !== expectedUserId) return null;
  if (claims.email && normalized(claims.email) !== normalized(email)) return null;
  if (idClaims.email && normalized(idClaims.email) !== normalized(email)) return null;
  if (idClaims.userId && idClaims.userId !== claims.userId) return null;
  const knownIdentity = normalized(claims.email) === normalized(email)
    || Boolean(expectedUserId && expectedUserId === claims.userId)
    || Boolean(idClaims.userId === claims.userId && normalized(idClaims.email) === normalized(email));
  if (!knownIdentity) return null;
  return {
    ...record, email, accessToken, refreshToken, accountId,
    chatgptUserId: claims.userId, clientId: jwt.client_id, plan, planType: plan, tokenScope: scope,
    // Personal credentials must never inherit the child's current Team.
    team: scope === 'team' ? workspaceId : undefined,
    expiresAt: claims.expiresAt,
    accessTokenExpired: expiresAt <= nowMs + 30_000,
  };
}

export function buildAccountExportCandidates(sources, serialize, { nowMs = Date.now() } = {}) {
  const candidates = new Map();
  for (const source of sources) {
    const record = savedExportCredential(source.record, { scope: source.scope, workspaceId: source.workspaceId, nowMs });
    if (!record) continue;
    const identity = JSON.stringify([source.scope, normalized(record.email), normalized(record.accountId)]);
    const id = `${source.scope}:${createHash('sha256').update(identity).digest('hex')}`;
    const previous = candidates.get(id);
    if (previous && Date.parse(previous.metadata.expiresAt) > Date.parse(record.expiresAt)) continue;
    candidates.set(id, {
      metadata: {
        id, scope: source.scope, email: record.email,
        childId: source.childId || null, motherId: source.motherId || null,
        teamName: source.scope === 'team' ? String(source.teamName || '') : '',
        workspaceId: record.accountId, plan: record.plan,
        role: source.role || null, expiresAt: record.expiresAt,
        accessTokenExpired: record.accessTokenExpired,
      },
      payload: serialize(record),
    });
  }
  return [...candidates.values()];
}

export function selectAccountExports(candidates, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    return { ok: false, status: 400, code: 'export_selection_required', message: '请勾选需要导出的账号，且不要重复选择' };
  }
  const byId = new Map(candidates.map((entry) => [entry.metadata.id, entry]));
  if (ids.some((id) => !byId.has(id))) {
    return { ok: false, status: 409, code: 'export_selection_stale', message: '部分账号的授权记录已变化或不可导出，请刷新列表后重新选择' };
  }
  return { ok: true, accounts: ids.map((id) => byId.get(id).payload) };
}
