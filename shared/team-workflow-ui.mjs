function key(value) {
  return String(value || '').trim().toLowerCase();
}

function memberships(account = {}) {
  const entries = new Map();
  for (const entry of [...(account.workspaceHistory || []), ...(account.joinedTeams || [])]) {
    const team = key(entry?.team || entry?.workspaceId);
    if (!team) continue;
    entries.set(team, { ...(entries.get(team) || {}), ...entry });
  }
  const current = key(account.team);
  if (current && !entries.has(current) && !['kicked', 'cooldown'].includes(account.status)) entries.set(current, { team: current, status: 'active' });
  return entries;
}

export function isTeamJoinCandidate(account, mother, joinMode = 'invite', nowMs = Date.now()) {
  const teamId = key(mother?.accountId || mother?.team);
  if (!account || !teamId || account.status === 'banned' || account.banStatus === 'banned') return false;
  const membership = memberships(account).get(teamId);
  if (membership?.status === 'active') return false;
  if ((mother.members || []).some((member) => !member.deactivated_time && !member.deactivatedTime && key(member.email) === key(account.email))) return false;
  if (['kicked', 'cooldown'].includes(membership?.status)) {
    const retryAt = Date.parse(membership.retryAfter || '');
    if (Number.isFinite(retryAt) ? retryAt > nowMs : membership.rejoinEligible === false || ['quota_5h', 'quota_7d'].includes(membership.reason) && membership.rejoinEligible !== true) return false;
  }
  const login = account.login || {};
  if (['login_pending', 'phone_verification_required'].includes(account.status)
    || ['phone_verification_required', 'waiting_code'].includes(login.status)
    || login.browserRequired) return false;
  const credentials = account.credentialsStatus || {};
  if (!(credentials.canAcquire || credentials.hasAccessToken || credentials.hasRefreshToken || credentials.hasPassword || account.hasAccessToken || account.accessToken || account.refreshToken || account.password)) return false;
  const domain = (email) => key(email).match(/^[^\s@]+@([^\s@]+)$/)?.[1] || '';
  return joinMode === 'invite' || Boolean(domain(mother.email) && domain(mother.email) === domain(account.email));
}

export function teamAuthorizationState(account, workspaceId) {
  const target = key(workspaceId);
  if (!account || !target) return null;
  const membership = memberships(account).get(target);
  const login = key(account.teamLogin?.workspaceId) === target ? account.teamLogin : null;
  const pendingMembership = membership?.status === 'active' && (
    ['pending', 'invalid', 'login_required', 'authenticating'].includes(membership.workspaceTokenStatus)
    || ['team_token_failed', 'member_confirmed_token_pending', 'owner_confirmed_token_pending'].includes(membership.joinStatus)
  );
  if (!login && !pendingMembership) return null;
  const invalid = membership?.workspaceTokenStatus === 'invalid';
  const pending = invalid || (login ? login.status !== 'ready' : true);
  const authUrl = pending && login?.browserRequired && account.status !== 'banned' && account.banStatus !== 'banned'
    ? officialTeamAuthorizationUrl(login.authUrl) : null;
  const status = !pending ? 'ready' : login?.browserRequired ? 'browser_required' : login?.needsInput ? 'waiting_code'
    : ['authenticating', 'initializing', 'workspace', 'oauth_exchange'].includes(login?.status) ? 'authenticating' : login?.code === 'team_auth_retry_backoff' ? 'queued' : 'failed';
  const label = !pending ? 'Team 授权就绪' : login?.browserRequired ? 'Team 授权待验证' : login?.needsInput ? 'Team 授权待输入'
    : status === 'authenticating' ? 'Team 授权获取中' : status === 'queued' ? 'Team 授权重试冷却'
      : invalid || login?.code === 'team_reauthorization_required' ? 'Team 授权失效 · 需重新授权'
        : login?.code === 'team_token_refresh_failed' ? '授权刷新失败 · 可重新获取' : '已入团 · 待 Team 授权';
  return { pending, status, label, authUrl, message: login?.message || '', retryAfter: login?.retryAfter || null };
}

export function officialTeamAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'auth.openai.com' && !url.username && !url.password && (!url.port || url.port === '443')) return url.toString();
  } catch { /* Only an official HTTPS authorization link can become an action. */ }
  return null;
}

// A late response must never supply a link for a different account or Team.
export function manualTeamAuthorizationUrl(result, target) {
  if (!result || !target?.id || !target.motherId || !target.workspaceId
    || result.child?.id !== target.id || key(result.motherId) !== key(target.motherId)
    || key(result.workspaceId) !== key(target.workspaceId) || result.browserRequired !== true) return null;
  return officialTeamAuthorizationUrl(result.authUrl);
}

function targetTeam(mother) {
  return { motherId: key(mother?.id), workspaceId: key(mother?.accountId || mother?.team || mother?.teamId) };
}

function matchesTarget(record, target) {
  return Boolean(record && target.motherId && target.workspaceId
    && key(record.motherId) === target.motherId && key(record.workspaceId) === target.workspaceId);
}

function activeRemoteMember(account, mother) {
  const email = key(account?.email);
  return Boolean(email && (mother?.members || []).some((member) => key(member?.email) === email
    && !member.deactivated_time && !member.deactivatedTime));
}

// Pool credentials and Team credentials have different scopes. Only metadata
// for this exact mother/workspace can describe a Team JSON as ready.
export function teamAutoJsonState(account, mother) {
  const target = targetTeam(mother);
  const membership = memberships(account || {}).get(target.workspaceId) || null;
  const member = Boolean(target.workspaceId && (membership?.status === 'active' || activeRemoteMember(account, mother)));
  const invitation = (account?.teamInvitations || []).find((record) => matchesTarget(record, target) && record.status === 'invited');
  const authorization = (account?.teamAuthorizations || []).find((record) => matchesTarget(record, target)) || null;
  const expiresAt = Date.parse(authorization?.expiresAt || '');
  const needsReauthorization = Boolean(authorization?.needsReauthorization || membership?.workspaceTokenStatus === 'invalid');
  const retryAuthorization = Boolean(authorization?.retryAuthorization);
  const ready = Boolean(member && !needsReauthorization && !retryAuthorization && authorization?.ready === true && authorization.hasAccessToken === true
    && authorization.hasRefreshToken === true && Number.isFinite(expiresAt) && expiresAt > Date.now() + 30_000);
  const rawLogin = authorization?.login && key(authorization.login.workspaceId) === target.workspaceId
    ? authorization.login : null;
  const login = !ready && (rawLogin?.status === 'ready' || !rawLogin && (needsReauthorization || retryAuthorization))
    ? { ...rawLogin, workspaceId: target.workspaceId, status: 'login_required', code: needsReauthorization ? 'team_reauthorization_required' : retryAuthorization ? 'team_token_refresh_failed' : 'team_json_incomplete', message: needsReauthorization ? '目标 Team 授权已失效，请重新授权' : retryAuthorization ? '目标 Team 授权刷新失败，可重新获取；尚未确认凭据失效' : member ? 'Team JSON 已失效或不完整，请重新获取' : '尚未确认加入目标 Team，请先完成入团', browserRequired: false, needsInput: false, authUrl: null }
    : rawLogin;
  const invited = Boolean(invitation);
  return { workspaceId: target.workspaceId, member, invited, related: member || invited, ready, needsReauthorization, retryAuthorization, login, membership, authorization };
}

// An overview keeps each Team's credentials separate and retains historical
// associations. An explicit target also includes accounts not yet invited.
export function teamAccountWorkflows(account, mothers = [], motherId = '') {
  const targetId = key(motherId);
  const targets = (Array.isArray(mothers) ? mothers : []).filter((mother) => !targetId || key(mother?.id) === targetId);
  return targets.map((mother) => ({ mother, ...teamAutoJsonState(account, mother) }))
    .filter((workflow) => targetId || workflow.related || workflow.authorization || workflow.membership);
}

// A batch counts only pending accounts for its exact Team. Explicit ids keep a
// row action scoped to that row; an empty selection must never mean "all".
export function teamAutoJsonCandidates(accounts = [], mother, ids = null) {
  const selected = Array.isArray(ids) ? new Set(ids) : null;
  const seen = new Set();
  return (Array.isArray(accounts) ? accounts : []).filter((account) => {
    if (!account?.id || seen.has(account.id) || selected && !selected.has(account.id)
      || account.status === 'banned' || account.banStatus === 'banned') return false;
    seen.add(account.id);
    const workflow = teamAutoJsonState(account, mother);
    return workflow.related && !workflow.ready;
  });
}

// Overview rows may choose their only associated Team. Multiple Teams require
// an explicit user choice, and a selected unrelated Team is never substituted.
export function teamAutoJsonRowTarget(account, mothers = [], motherId = '') {
  const related = teamAccountWorkflows(account, mothers).filter((workflow) => workflow.related);
  return motherId ? related.find((workflow) => key(workflow.mother.id) === key(motherId)) || null
    : related.length === 1 ? related[0] : null;
}

export function teamMemberRemovalState(account, mother) {
  const workflow = teamAutoJsonState(account, mother);
  const primaryEmail = key(mother?.primaryOwnerEmail || mother?.email);
  const protectedPrimary = mother?.rotationMode === 'fixed' && primaryEmail && key(account?.email) === primaryEmail;
  const reason = !mother?.id || !workflow.workspaceId ? '请先配置 Team'
    : !workflow.member ? '不是此 Team 的当前成员'
      : protectedPrimary ? '固定主号不能移除' : '';
  return { ...workflow, selectable: !reason, reason };
}

// Sending an invitation is an administrator action and does not require the
// recipient to have logged in or obtained any pool credentials yet.
export function teamInviteCandidateState(account, mother, nowMs = Date.now()) {
  const target = targetTeam(mother);
  const membership = memberships(account || {}).get(target.workspaceId) || null;
  const alreadyMember = Boolean(target.workspaceId && (membership?.status === 'active' || activeRemoteMember(account, mother)));
  const invited = Boolean((account?.teamInvitations || []).some((record) => matchesTarget(record, target) && record.status === 'invited'));
  let reason = '';
  if (!account || !target.motherId || !target.workspaceId) reason = '请先配置 Team 工作空间';
  else if (account.status === 'banned' || account.banStatus === 'banned') reason = '账号已封禁';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(account.email || '').trim())) reason = '请先填写有效邮箱';
  else if (alreadyMember) reason = '已在此 Team';
  else if (invited) reason = '已邀请，等待接受';
  else if (['kicked', 'cooldown'].includes(membership?.status)) {
    const retryAt = Date.parse(membership.retryAfter || '');
    if (Number.isFinite(retryAt) ? retryAt > nowMs : membership.rejoinEligible === false
      || ['quota_5h', 'quota_7d'].includes(membership.reason) && membership.rejoinEligible !== true) reason = '此 Team 重加冷却中';
  }
  return { selectable: !reason, reason, alreadyMember, invited };
}
