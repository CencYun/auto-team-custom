import { teamAccountWorkflows, teamMemberRemovalState } from './team-workflow-ui.mjs';

const key = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validId = (value) => typeof value === 'string' && value.trim() && !/\s/.test(value);

// Removing members requires an explicit Team; the overview must never widen
// a destructive batch to every workspace associated with an account.
export function teamMemberRemovalCandidates(accounts = [], mothers = [], motherId = '') {
  const targetId = key(motherId);
  if (!targetId || !Array.isArray(accounts) || !Array.isArray(mothers)) return [];
  const targets = mothers.filter((mother) => validId(mother?.id) && key(mother.id) === targetId);
  const workspaces = new Set(targets.map((mother) => key(mother.accountId || mother.team || mother.teamId)));
  if (workspaces.size !== 1 || workspaces.has('')) return [];

  const candidates = [];
  const seen = new Set();
  for (const account of accounts) {
    if (!validId(account?.id) || typeof account.email !== 'string'
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email.trim())) continue;
    for (const { mother } of teamAccountWorkflows(account, targets, targetId)) {
      const removal = teamMemberRemovalState(account, mother);
      const { workspaceId, membership } = removal;
      if (!removal.selectable || (membership?.status && key(membership.status) !== 'active')) continue;
      // A stale remote cache must not resurrect an already removed current
      // membership when older records lack a workspace-history entry.
      if (!membership && key(account.team) === workspaceId
        && ['kicked', 'cooldown', 'removed'].includes(key(account.status))) continue;
      const identity = JSON.stringify([account.id, workspaceId]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      candidates.push({
        childId: account.id,
        email: account.email.trim(),
        motherId: mother.id,
        workspaceId,
        teamName: mother.teamName || mother.displayName || '未命名 Team',
      });
    }
  }
  return candidates;
}

// Each explicitly selected member is attempted once. Removal is sequential
// so independent failures cannot interrupt the remaining confirmed selection.
export async function runTeamMemberRemovalBatch(targets, remove, onProgress = () => {}) {
  const seen = new Set();
  const selected = (Array.isArray(targets) ? targets : []).filter((target) => {
    if (!validId(target?.childId) || !validId(target.motherId) || !validId(target.workspaceId)) return false;
    const identity = JSON.stringify([target.childId, key(target.workspaceId)]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).map((target) => ({ ...target }));
  let succeeded = 0;
  const results = [];
  const summary = () => ({ total: selected.length, completed: results.length,
    succeeded, failed: results.length - succeeded, results: [...results] });
  for (const target of selected) {
    let result;
    try {
      const response = await remove(target);
      const ok = response?.ok === true;
      result = { ...target, ok, error: ok ? '' : response?.message || '移除成员失败',
        canDelete: ok && response.account?.localDeletion?.eligible === true };
    } catch (error) {
      result = { ...target, ok: false, error: error?.message || '移除成员失败', canDelete: false };
    }
    if (result.ok) succeeded += 1;
    results.push(result);
    // A presentation callback cannot cancel already confirmed remaining work.
    try { onProgress(summary()); } catch { /* The final summary remains available. */ }
  }
  return summary();
}
