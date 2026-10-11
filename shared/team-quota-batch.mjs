import { teamAccountWorkflows } from './team-workflow-ui.mjs';

// Quota refresh uses saved Team JSON, including expired access tokens whose
// refresh tokens can renew them. It must never enqueue authorization itself.
export function teamQuotaBatchTargets(accounts = [], mothers = [], motherId = '') {
  const targets = [];
  const seen = new Set();
  for (const account of accounts) {
    if (!account?.id || account.status === 'banned' || account.banStatus === 'banned') continue;
    for (const workflow of teamAccountWorkflows(account, mothers, motherId)) {
      const { mother, workspaceId, membership, authorization } = workflow;
      if (!mother?.id || !workspaceId || membership?.status !== 'active'
        || authorization?.hasAccessToken !== true || authorization.hasRefreshToken !== true) continue;
      const key = JSON.stringify([account.id, workspaceId]);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ childId: account.id, motherId: mother.id, workspaceId,
        email: account.email || account.id,
        teamName: mother.teamName || mother.displayName || mother.name || mother.email || workspaceId });
    }
  }
  return targets;
}
