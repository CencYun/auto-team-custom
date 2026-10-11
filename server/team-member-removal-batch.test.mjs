import assert from 'node:assert/strict';
import test from 'node:test';
import { teamMemberRemovalCandidates, runTeamMemberRemovalBatch } from '../shared/team-member-removal-batch.mjs';

const first = { id: 'mother-a', accountId: 'workspace-a', teamName: 'Team A', email: 'owner-a@fixture.test', rotationMode: 'fixed' };
const second = { id: 'mother-b', accountId: 'workspace-b', teamName: 'Team B', email: 'owner-b@fixture.test' };
const member = { id: 'child-a', email: 'member@fixture.test', joinedTeams: [{ team: first.accountId, status: 'active' }] };
const ids = (accounts, mothers = [first, second], motherId = first.id) => teamMemberRemovalCandidates(accounts, mothers, motherId).map((candidate) => candidate.childId);

test('member removal requires a concrete existing Team and never turns overview or invalid selection into all Teams', () => {
  for (const target of ['', ' ', 'unknown', null, {}, 1]) {
    assert.deepEqual(teamMemberRemovalCandidates([member], [first, second], target), []);
  }
  assert.deepEqual(teamMemberRemovalCandidates([member], [first, second]), []);
  assert.deepEqual(teamMemberRemovalCandidates([member], null, first.id), []);
  assert.deepEqual(teamMemberRemovalCandidates(null, [first], first.id), []);
  assert.deepEqual(teamMemberRemovalCandidates([member], [{ ...first, accountId: '' }], first.id), []);
  assert.deepEqual(teamMemberRemovalCandidates([member], [first, { ...first, accountId: second.accountId }], first.id), [], 'ambiguous target ids must not authorize two workspaces');
});

test('multi-Team accounts produce only the exact selected workspace without requiring JSON', () => {
  const both = { ...member, joinedTeams: [...member.joinedTeams, { team: second.accountId, status: 'active' }] };
  assert.deepEqual(teamMemberRemovalCandidates([both], [first, second], second.id), [{
    childId: member.id, email: member.email, motherId: second.id,
    workspaceId: second.accountId, teamName: second.teamName,
  }]);
  assert.deepEqual(ids([member], [first, second], second.id), []);
  assert.deepEqual(ids([both]), [member.id]);
});

test('fixed primary owners stay protected while active banned members remain removable', () => {
  const primary = { ...member, id: 'primary', email: first.email };
  const banned = { ...member, id: 'banned', status: 'banned' };
  const bannedByFlag = { ...member, id: 'banned-flag', banStatus: 'banned' };
  assert.deepEqual(ids([primary, banned, bannedByFlag]), ['banned', 'banned-flag']);
  assert.deepEqual(ids([primary], [{ ...first, rotationMode: 'rotating' }]), ['primary']);
  const designated = { ...first, primaryOwnerEmail: member.email };
  assert.deepEqual(ids([member], [designated]), [], 'explicit primaryOwnerEmail takes precedence');
});

test('explicit non-active membership overrides stale remote lists and old saved JSON', () => {
  const staleMother = { ...first, members: [{ email: member.email }] };
  for (const status of ['kicked', 'cooldown', 'removed', 'inactive', 'invited']) {
    const removed = { ...member, team: first.accountId,
      joinedTeams: [{ team: first.accountId, status }],
      teamAuthorizations: [{ motherId: first.id, workspaceId: first.accountId, ready: true }],
    };
    assert.deepEqual(ids([removed], [staleMother]), [], status);
  }
  for (const status of ['kicked', 'cooldown']) {
    assert.deepEqual(ids([{ ...member, joinedTeams: [], team: first.accountId, status }], [staleMother]), [], status);
  }
  const removedCurrent = { ...member, workspaceHistory: member.joinedTeams,
    joinedTeams: [{ team: first.accountId, status: 'kicked' }] };
  assert.deepEqual(ids([removedCurrent], [staleMother]), [], 'the current membership supersedes old active history');
});

test('remote-only active members can be removed but invitations and deactivated remote entries cannot', () => {
  const remoteOnly = { id: member.id, email: member.email };
  assert.deepEqual(ids([remoteOnly], [{ ...first, members: [{ email: member.email.toUpperCase() }] }]), [member.id]);
  for (const deactivated of [{ deactivated_time: '2026-10-01' }, { deactivatedTime: '2026-10-01' }]) {
    assert.deepEqual(ids([remoteOnly], [{ ...first, members: [{ email: member.email, ...deactivated }] }]), []);
  }
  assert.deepEqual(ids([{ ...remoteOnly, teamInvitations: [{ motherId: first.id, workspaceId: first.accountId, status: 'invited' }] }]), []);
  assert.deepEqual(ids([{ ...remoteOnly, team: second.accountId, status: 'kicked' }], [{ ...first, members: [{ email: member.email }] }]), [member.id], 'removal from a different Team must not hide the target membership');
});

test('member identities are validated and repeated records are deduplicated per child and workspace', () => {
  const malformed = [null, {}, ...['', ' ', null, {}, 'child with spaces'].map((id) => ({ ...member, id })),
    ...['', 'invalid', 'member @fixture.test', 'member@@fixture.test', null, {}].map((email) => ({ ...member, email }))];
  assert.deepEqual(ids([...malformed, member, { ...member }], [first, { ...first }]), [member.id]);
  const original = structuredClone(member);
  const trimmed = { ...member, email: ` ${member.email} ` };
  assert.equal(teamMemberRemovalCandidates([trimmed], [first], first.id)[0].email, member.email);
  assert.deepEqual(member, original, 'selection does not mutate source account records');
});

const target = (childId) => ({ childId, motherId: first.id, workspaceId: first.accountId, email: `${childId}@fixture.test`, teamName: first.teamName });

test('batch removal attempts only the confirmed selection once and runs sequentially', async () => {
  const calls = [];
  const progress = [];
  let active = 0;
  const result = await runTeamMemberRemovalBatch([target('selected-b'), target('selected-a'), target('selected-b')], async (item) => {
    assert.equal(active, 0, 'no overlapping membership mutations');
    active += 1;
    calls.push(item.childId);
    await Promise.resolve();
    active -= 1;
    return { ok: true, account: { localDeletion: { eligible: true } } };
  }, (value) => progress.push(value));
  assert.deepEqual(calls, ['selected-b', 'selected-a']);
  assert.deepEqual(progress.map(({ completed, succeeded, failed }) => [completed, succeeded, failed]), [[1, 1, 0], [2, 2, 0]]);
  assert.equal(progress[0].results.length, 1, 'later completion cannot mutate earlier progress snapshots');
  assert.deepEqual({ total: result.total, completed: result.completed, succeeded: result.succeeded, failed: result.failed }, { total: 2, completed: 2, succeeded: 2, failed: 0 });
  const empty = await runTeamMemberRemovalBatch([], () => assert.fail('empty selection must never run'));
  assert.deepEqual(empty, { total: 0, completed: 0, succeeded: 0, failed: 0, results: [] });
});

test('consecutive removal failures do not retry or prevent later selected accounts from completing', async () => {
  const calls = [];
  const result = await runTeamMemberRemovalBatch(['throws', 'rejected', 'last'].map(target), async ({ childId }) => {
    calls.push(childId);
    if (childId === 'throws') throw new Error('连接失败');
    if (childId === 'rejected') return { ok: false, message: '服务器拒绝移除', account: { localDeletion: { eligible: true } } };
    return { ok: true, account: { localDeletion: { eligible: true } } };
  }, () => { throw new Error('presentation failure'); });
  assert.deepEqual(calls, ['throws', 'rejected', 'last']);
  assert.deepEqual(result.results.map(({ ok, error, canDelete }) => [ok, error, canDelete]), [
    [false, '连接失败', false], [false, '服务器拒绝移除', false], [true, '', true],
  ]);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.completed, 3);
});

test('successful target-Team removal unlocks deletion only when the server confirms no other memberships remain', async () => {
  const result = await runTeamMemberRemovalBatch(['last-team', 'other-team', 'no-deletion-status'].map(target), async ({ childId }) => ({
    ok: true,
    account: childId === 'no-deletion-status' ? {} : { localDeletion: { eligible: childId === 'last-team', reason: childId === 'other-team' ? '仍在其他 Team' : '' } },
  }));
  assert.equal(result.succeeded, 3);
  assert.deepEqual(result.results.map(({ childId, canDelete }) => [childId, canDelete]), [
    ['last-team', true], ['other-team', false], ['no-deletion-status', false],
  ]);
});
