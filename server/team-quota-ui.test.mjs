import assert from 'node:assert/strict';
import test from 'node:test';
import { teamQuotaState } from '../shared/team-quota-ui.mjs';
import { teamAccountWorkflows } from '../shared/team-workflow-ui.mjs';

const updatedAt = '2026-10-10T01:02:03.000Z';
const membership = { team: 'workspace-a', status: 'active' };
const workflow = (fields = {}) => ({ workspaceId: membership.team, member: true, membership: { ...membership, ...fields } });

test('successful Team probes show measured 0 and 100 including numeric strings', () => {
  const state = teamQuotaState(workflow({ quotaUpdatedAt: updatedAt, lastProbe: { ok: true, quotaWindowMapping: 'duration-v1', primary: { usedPercent: '100' }, secondary: { usedPercent: 0 } } }));
  assert.deepEqual(state, { quota5h: 0, quota7d: 100, hasData: true, failed: false, updatedAt, message: '上次成功检测的真实剩余额度' });
});

test('successful probe takes precedence over stored snapshots and compatibility percentages', () => {
  const state = teamQuotaState(workflow({ quotaUpdatedAt: updatedAt, quota5h: 100, quota7d: 100,
    quotaSnapshot: { primary: { usedPercent: 0 }, secondary: { usedPercent: 0 } },
    lastProbe: { ok: true, primary: { usedPercent: 24 }, secondary: { remainingPercent: '52.5' } } }));
  assert.equal(state.quota5h, 76);
  assert.equal(state.quota7d, 52.5);
});

test('duration-mapped responses never fill missing windows from previous values', () => {
  const state = teamQuotaState(workflow({ quotaUpdatedAt: updatedAt, quota5h: 100, quota7d: 100,
    quotaSnapshot: { primary: { usedPercent: 0 } },
    lastProbe: { ok: true, quotaWindowMapping: 'duration-v1', secondary: { usedPercent: 30 } } }));
  assert.equal(state.quota5h, null);
  assert.equal(state.quota7d, 70);
  const missing = teamQuotaState(workflow({ quotaUpdatedAt: updatedAt, quota5h: 100, quota7d: 100,
    lastProbe: { ok: true, quotaWindowMapping: 'duration-v1' } }));
  assert.equal(missing.hasData, false);
  assert.equal(missing.quota5h, null);
  assert.equal(missing.quota7d, null);
});

test('failed check keeps the last successful Team snapshot and explicitly labels it historical', () => {
  const state = teamQuotaState(workflow({ quota5h: 100, quota7d: 100,
    quotaSnapshot: { updatedAt, quotaWindowMapping: 'duration-v1', primary: { usedPercent: 90 } },
    lastProbe: { ok: false, status: 403, primary: { usedPercent: 0 }, secondary: { usedPercent: 0 } } }));
  assert.equal(state.quota5h, 10);
  assert.equal(state.quota7d, null);
  assert.equal(state.updatedAt, updatedAt);
  assert.equal(state.failed, true);
  assert.equal(state.message, '本次检测失败，显示上次成功结果');
});

test('successful JSON, untimestamped defaults and failed checks cannot invent quota', () => {
  for (const fields of [{}, { quota5h: 100, quota7d: 100 }, { quota5h: 100, lastProbe: { ok: true } }, { quotaUpdatedAt: 'invalid', quota5h: 100 },
    { lastProbe: { ok: false, primary: { usedPercent: 0 } } }]) {
    const state = teamQuotaState({ ...workflow(fields), ready: true });
    assert.equal(state.hasData, false);
    assert.equal(state.quota5h, null);
    assert.equal(state.quota7d, null);
  }
  assert.equal(teamQuotaState(workflow({ lastProbe: { ok: false } })).message, '额度检测失败，暂无成功结果');
});

test('timestamped legacy measured fields remain compatible without converting absent values to zero', () => {
  const state = teamQuotaState(workflow({ quotaUpdatedAt: updatedAt, quota5h: '0', quota7d: '87' }));
  assert.equal(state.quota5h, 0);
  assert.equal(state.quota7d, 87);
  assert.equal(state.hasData, true);
  for (const value of [null, undefined, '', ' ', false, true, {}, [], 'NaN', Infinity]) {
    assert.equal(teamQuotaState(workflow({ quotaUpdatedAt: updatedAt, quota5h: value })).quota5h, null);
  }
});

test('multiple Team workflows remain isolated and never use account-level Free or other-Team quota', () => {
  const account = { quota5h: 100, quota7d: 100, quotaUpdatedAt: updatedAt, joinedTeams: [
    { ...membership, quotaUpdatedAt: updatedAt, quotaSnapshot: { primary: { usedPercent: 95 } } },
    { team: 'workspace-b', status: 'active' },
  ] };
  const mothers = [{ id: 'mother-a', accountId: 'workspace-a' }, { id: 'mother-b', accountId: 'workspace-b' }];
  const [a, b] = teamAccountWorkflows(account, mothers).map(teamQuotaState);
  assert.equal(a.quota5h, 5);
  assert.equal(a.quota7d, null);
  assert.equal(b.hasData, false);
  assert.equal(teamQuotaState({ ...workflow({ quota5h: 100, quotaUpdatedAt: updatedAt }), workspaceId: 'workspace-b' }).hasData, false);
});

test('departed memberships cannot present historical quota as current even with cached remote membership', () => {
  const current = workflow({ quotaUpdatedAt: updatedAt, quota5h: 75 });
  assert.equal(teamQuotaState({ ...current, member: false }).hasData, false);
  assert.equal(teamQuotaState({ ...current, membership: { ...current.membership, status: 'kicked' } }).hasData, false);
  assert.equal(teamQuotaState({ ...current, membership: null }).hasData, false);
  assert.equal(teamQuotaState().hasData, false);
});
