import assert from 'node:assert/strict';
import test from 'node:test';
import { teamQuotaBatchTargets } from '../shared/team-quota-batch.mjs';

const first = { id: 'mother-first', accountId: 'workspace-first', name: 'First Team' };
const second = { id: 'mother-second', accountId: 'workspace-second', name: 'Second Team' };
const mothers = [first, second];
function savedAccount(id, teams = mothers) {
  return { id, email: `${id}@example.test`, status: 'ready',
    joinedTeams: teams.map(mother => ({ team: mother.accountId, status: 'active' })),
    teamAuthorizations: teams.map(mother => ({ motherId: mother.id, workspaceId: mother.accountId,
      ready: true, hasAccessToken: true, hasRefreshToken: true, expiresAt: '2099-01-01T00:00:00Z' })) };
}

test('overview refreshes every saved account and Team; explicit scope never substitutes another Team', () => {
  const accounts = [savedAccount('a'), savedAccount('b', [second])];
  const overview = teamQuotaBatchTargets(accounts, mothers);
  assert.deepEqual(overview.map(t => [t.childId, t.motherId, t.workspaceId]), [
    ['a', first.id, first.accountId], ['a', second.id, second.accountId], ['b', second.id, second.accountId],
  ]);
  assert.equal(overview[0].email, 'a@example.test');
  assert.equal(overview[0].teamName, 'First Team');
  assert.deepEqual(teamQuotaBatchTargets(accounts, mothers, first.id), [overview[0]]);
  assert.deepEqual(teamQuotaBatchTargets(accounts, mothers, 'missing-mother'), []);
});

test('expired saved JSON remains refreshable without starting authorization', () => {
  const account = savedAccount('expired', [first]);
  Object.assign(account.teamAuthorizations[0], { ready: false, expiresAt: '2020-01-01T00:00:00Z' });
  assert.equal(teamQuotaBatchTargets([account], mothers).length, 1);
});

test('missing or incomplete Team JSON and unrelated pool credentials do not enter the batch', () => {
  for (const patch of [{ hasAccessToken: false }, { hasRefreshToken: false }, { motherId: 'other-mother' }, { workspaceId: 'other-workspace' }]) {
    const account = savedAccount('partial', [first]);
    Object.assign(account.teamAuthorizations[0], patch);
    assert.deepEqual(teamQuotaBatchTargets([account], mothers), []);
  }
  const account = { ...savedAccount('pool', [first]), teamAuthorizations: [],
    credentialsStatus: { hasAccessToken: true, hasRefreshToken: true } };
  assert.deepEqual(teamQuotaBatchTargets([account], mothers), []);
});

test('removed members stay excluded even when the remote member cache is stale', () => {
  for (const status of ['kicked', 'cooldown', 'invited']) {
    const account = savedAccount('removed', [first]);
    account.joinedTeams[0].status = status;
    const cachedMother = { ...first, members: [{ email: account.email }] };
    assert.deepEqual(teamQuotaBatchTargets([account], [cachedMother]), []);
  }
  const absent = { ...savedAccount('absent', [first]), joinedTeams: [] };
  assert.deepEqual(teamQuotaBatchTargets([absent], [{ ...first, members: [{ email: absent.email }] }]), []);
});

test('bans exclude accounts but removal from one Team does not block another active Team', () => {
  for (const patch of [{ status: 'banned' }, { banStatus: 'banned' }]) {
    assert.deepEqual(teamQuotaBatchTargets([{ ...savedAccount('banned'), ...patch }], mothers), []);
  }
  const account = savedAccount('mixed');
  account.joinedTeams[0].status = 'kicked';
  assert.deepEqual(teamQuotaBatchTargets([account], mothers).map(t => t.workspaceId), [second.accountId]);
});

test('duplicate rows or mother records for one workspace trigger only one quota query', () => {
  const alias = { ...first, id: 'mother-alias' };
  const account = savedAccount('duplicate', [first, alias]);
  assert.equal(teamQuotaBatchTargets([account, account], [first, alias]).length, 1);
  assert.equal(teamQuotaBatchTargets([account], [first, alias], alias.id)[0].motherId, alias.id);
  assert.deepEqual(teamQuotaBatchTargets(), []);
});
