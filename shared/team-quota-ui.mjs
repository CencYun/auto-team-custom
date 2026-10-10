function key(value) {
  return String(value || '').trim().toLowerCase();
}

function percent(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function remaining(window) {
  const direct = percent(window?.remainingPercent);
  if (direct !== null) return direct;
  const used = percent(window?.usedPercent);
  return used === null ? null : 100 - used;
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

// Each Team owns a separate observation. A valid JSON proves authorization,
// not a quota amount; only measured values for this active membership qualify.
export function teamQuotaState(workflow = {}) {
  const empty = { quota5h: null, quota7d: null, hasData: false, failed: false, updatedAt: null, message: '暂未返回真实额度' };
  const membership = workflow.membership;
  const workspaceId = key(workflow.workspaceId);
  if (workflow.member !== true || membership?.status !== 'active') return { ...empty, message: '未在此 Team 中' };
  if (!workspaceId || key(membership.team || membership.workspaceId) !== workspaceId) return empty;

  const probe = membership.lastProbe;
  const failed = probe?.ok === false;
  const snapshot = membership.quotaSnapshot && typeof membership.quotaSnapshot === 'object' ? membership.quotaSnapshot : {};
  const source = probe?.ok === true ? probe : snapshot;
  const updatedAt = timestamp(membership.quotaUpdatedAt) || timestamp(snapshot.updatedAt);
  // Legacy imports can carry timestamped numeric fields without a snapshot.
  // Untimestamped defaults are not evidence that an account has quota.
  const legacyMeasured = Boolean(updatedAt);
  const complete = source.quotaWindowMapping === 'duration-v1';
  const quota5h = remaining(source.primary) ?? (!complete && legacyMeasured ? percent(membership.quota5h) : null);
  const quota7d = remaining(source.secondary) ?? (!complete && legacyMeasured ? percent(membership.quota7d) : null);
  const hasData = quota5h !== null || quota7d !== null;
  const message = failed
    ? hasData ? '本次检测失败，显示上次成功结果' : '额度检测失败，暂无成功结果'
    : hasData ? '上次成功检测的真实剩余额度' : empty.message;
  return { quota5h, quota7d, hasData, failed, updatedAt, message };
}
