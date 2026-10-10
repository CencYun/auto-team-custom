import assert from 'node:assert/strict';
import test from 'node:test';
import { isTeamJoinCandidate, teamAuthorizationState, teamAutoJsonState, teamAccountWorkflows, teamInviteCandidateState, teamMemberRemovalState } from '../shared/team-workflow-ui.mjs';

const teamId = 'fixture-workspace';
const mother = { accountId: teamId, email: 'owner@fixture.test' };
const account = { id: 'fixture-child', email: 'member@fixture.test', status: 'ready', credentialsStatus: { canAcquire: true, hasPassword: true, hasTotp: true } };
const activeMembership = { team: teamId, status: 'active', workspaceTokenStatus: 'pending', joinStatus: 'member_confirmed_token_pending' };

test('member removal follows the exact active Team without requiring OAuth or blocking banned seats', () => {
  const target = { ...mother, id: 'mother-removal' };
  const joined = { ...account, status: 'banned', team: 'other-team', joinedTeams: [activeMembership] };
  assert.equal(teamMemberRemovalState(joined, target).selectable, true);
  assert.equal(teamMemberRemovalState(joined, { ...target, accountId: 'absent-team' }).selectable, false);
  assert.equal(teamMemberRemovalState({ ...account, teamInvitations: [{ motherId: target.id, workspaceId: teamId, status: 'invited' }] }, target).selectable, false);
  assert.equal(teamMemberRemovalState({ ...account, joinedTeams: [{ ...activeMembership, status: 'kicked' }] }, target).selectable, false);
});

test('member removal protects a fixed primary owner but preserves existing rotating and ordinary owner policy', () => {
  const target = { ...mother, id: 'mother-removal', rotationMode: 'fixed' };
  const owner = { ...account, email: mother.email, joinedTeams: [activeMembership] };
  assert.equal(teamMemberRemovalState(owner, target).selectable, false);
  assert.equal(teamMemberRemovalState(owner, { ...target, rotationMode: 'rotating' }).selectable, true);
  assert.equal(teamMemberRemovalState({ ...owner, email: 'another-owner@fixture.test' }, target).selectable, true);
});

test('already joined members with ready pool status are not candidates and remain counted as pending Team authorization', () => {
  const joined = { ...account, workspaceHistory: [activeMembership], joinedTeams: [{ team: teamId, status: 'active' }] };
  assert.equal(isTeamJoinCandidate(joined, mother), false);
  assert.equal(teamAuthorizationState(joined, teamId)?.pending, true);
  assert.equal(teamAuthorizationState(joined, 'another-workspace'), null);
});

test('an email/password/2FA-only account may join without first manually obtaining Free JSON', () => {
  assert.equal(isTeamJoinCandidate(account, mother), true);
  assert.equal(isTeamJoinCandidate(account, mother, 'request'), true);
  assert.equal(isTeamJoinCandidate({ ...account, email: 'member@another.test' }, mother, 'request'), false);
  assert.equal(isTeamJoinCandidate({ ...account, email: 'spaces@business.test' }, { ...mother, email: 'owner@business.test' }, 'request'), true);
  assert.equal(isTeamJoinCandidate({ ...account, email: 'member @fixture.test' }, mother, 'request'), false);
  assert.equal(isTeamJoinCandidate({ ...account, workspaceHistory: [{ team: 'another-workspace', status: 'active' }] }, mother), true);
});

test('waiting browser verification, bans, remote members, and unexpired rejoin cooldowns are not ready candidates', () => {
  assert.equal(isTeamJoinCandidate({ ...account, status: 'login_pending', login: { browserRequired: true } }, mother), false);
  assert.equal(isTeamJoinCandidate({ ...account, banStatus: 'banned' }, mother), false);
  assert.equal(isTeamJoinCandidate(account, { ...mother, members: [{ email: account.email, role: 'standard-user' }] }), false);
  const cooldown = { ...account, workspaceHistory: [{ team: teamId, status: 'cooldown', retryAfter: '2099-01-01T00:00:00.000Z' }] };
  assert.equal(isTeamJoinCandidate(cooldown, mother, 'invite', Date.parse('2026-10-08')), false);
  assert.equal(isTeamJoinCandidate(cooldown, mother, 'invite', Date.parse('2100-01-01')), true);
});

test('a Team authorization action requires the same workspace and its independent browser-required official URL', () => {
  const freeUrl = 'https://auth.openai.com/oauth/authorize?state=fixture-free';
  const teamUrl = 'https://auth.openai.com/oauth/authorize?state=fixture-team';
  const joined = { ...account, workspaceHistory: [activeMembership], login: { browserRequired: true, authUrl: freeUrl }, teamLogin: { workspaceId: teamId, status: 'browser_verification_required', browserRequired: true, needsInput: true, authUrl: teamUrl } };
  assert.equal(teamAuthorizationState(joined, teamId)?.authUrl, teamUrl);
  assert.equal(teamAuthorizationState({ ...joined, teamLogin: null }, teamId)?.authUrl, null, 'the Free URL is never substituted');
  assert.equal(teamAuthorizationState(joined, 'another-workspace'), null);
  assert.equal(teamAuthorizationState({ ...joined, teamLogin: { ...joined.teamLogin, browserRequired: false } }, teamId)?.authUrl, null);
  assert.equal(teamAuthorizationState({ ...joined, teamLogin: { ...joined.teamLogin, status: 'ready', browserRequired: false, authUrl: null } }, teamId)?.pending, false);
});

test('Team authorization rejects executable URLs, external hosts, malformed URLs, and URLs after account suspension', () => {
  for (const authUrl of ['javascript:alert(1)', 'https://external.example/authorize', 'not-a-url', 'https://auth.openai.com@external.example/authorize']) {
    assert.equal(teamAuthorizationState({ ...account, teamLogin: { workspaceId: teamId, status: 'verification_required', browserRequired: true, authUrl } }, teamId)?.authUrl, null);
  }
  assert.equal(teamAuthorizationState({ ...account, banStatus: 'banned', teamLogin: { workspaceId: teamId, status: 'verification_required', browserRequired: true, authUrl: 'https://auth.openai.com/oauth/authorize?state=fixture' } }, teamId)?.authUrl, null);
});

const invitationMother = { ...mother, id: 'mother-fixture' };
const invitation = { motherId: invitationMother.id, workspaceId: teamId, status: 'invited' };
const authorization = { motherId: invitationMother.id, workspaceId: teamId, ready: true, hasAccessToken: true, hasRefreshToken: true, expiresAt: '2099-01-01T00:00:00.000Z' };

test('administrator invitation permits recipients without credentials and recipients waiting for login verification', () => {
  const recipient = { id: account.id, email: account.email };
  assert.deepEqual(teamInviteCandidateState(recipient, invitationMother), { selectable: true, reason: '', alreadyMember: false, invited: false });
  for (const login of [{ status: 'waiting_code' }, { status: 'phone_verification_required' }, { status: 'verification_required', browserRequired: true }]) {
    assert.equal(teamInviteCandidateState({ ...recipient, status: 'login_pending', login }, invitationMother).selectable, true);
  }
});

test('invitation selection rejects existing target members and pending invites without restricting other Teams', () => {
  assert.equal(teamInviteCandidateState({ ...account, joinedTeams: [{ team: teamId, status: 'active' }] }, invitationMother).alreadyMember, true);
  assert.equal(teamInviteCandidateState(account, { ...invitationMother, members: [{ email: account.email }] }).selectable, false);
  assert.equal(teamInviteCandidateState(account, { ...invitationMother, members: [{ email: account.email, deactivatedTime: '2026-01-01' }] }).selectable, true);
  const otherMembership = { ...account, joinedTeams: [{ team: 'another-workspace', status: 'active' }] };
  assert.equal(teamInviteCandidateState(otherMembership, invitationMother).selectable, true);
  const invited = teamInviteCandidateState({ ...account, teamInvitations: [invitation] }, invitationMother);
  assert.equal(invited.invited, true);
  assert.equal(invited.selectable, false);
  for (const pending of [{ ...invitation, workspaceId: 'another-workspace' }, { ...invitation, motherId: 'another-mother' }, { ...invitation, status: 'joined' }]) {
    assert.equal(teamInviteCandidateState({ ...account, teamInvitations: [pending] }, invitationMother).selectable, true);
  }
});

test('invitation selection enforces bans, valid email and only the target Team rejoin cooldown', () => {
  for (const email of ['', 'invalid', 'space @fixture.test', 'member@@fixture.test']) {
    assert.equal(teamInviteCandidateState({ ...account, email }, invitationMother).selectable, false);
  }
  for (const ban of [{ status: 'banned' }, { banStatus: 'banned' }]) {
    assert.equal(teamInviteCandidateState({ ...account, ...ban }, invitationMother).selectable, false);
  }
  const nowMs = Date.parse('2026-10-09T00:00:00Z');
  const cooldown = { team: teamId, status: 'cooldown', retryAfter: '2026-10-10T00:00:00Z' };
  assert.equal(teamInviteCandidateState({ ...account, joinedTeams: [cooldown] }, invitationMother, nowMs).selectable, false);
  assert.equal(teamInviteCandidateState({ ...account, joinedTeams: [{ ...cooldown, team: 'another-workspace' }] }, invitationMother, nowMs).selectable, true);
  assert.equal(teamInviteCandidateState({ ...account, joinedTeams: [{ ...cooldown, retryAfter: '2026-10-08T00:00:00Z' }] }, invitationMother, nowMs).selectable, true);
  const unknownReset = { team: teamId, status: 'kicked', reason: 'quota_7d' };
  assert.equal(teamInviteCandidateState({ ...account, joinedTeams: [unknownReset] }, invitationMother, nowMs).selectable, false);
  assert.equal(teamInviteCandidateState({ ...account, joinedTeams: [{ ...unknownReset, rejoinEligible: true }] }, invitationMother, nowMs).selectable, true);
});

test('Team JSON readiness does not inherit Free credentials or another workspace or mother authorization', () => {
  const joined = { ...account, joinedTeams: [activeMembership], hasAccessToken: true, sub2apiStatus: { exportable: true }, credentialsStatus: { hasAccessToken: true, hasRefreshToken: true }, login: { status: 'ready' } };
  assert.equal(teamAutoJsonState(joined, invitationMother).ready, false);
  for (const other of [{ ...authorization, workspaceId: 'another-workspace' }, { ...authorization, motherId: 'another-mother' }]) {
    const state = teamAutoJsonState({ ...joined, teamAuthorizations: [other] }, invitationMother);
    assert.equal(state.ready, false);
    assert.equal(state.authorization, null);
  }
  assert.equal(teamAutoJsonState({ ...joined, teamAuthorizations: [authorization] }, invitationMother).ready, true);
});

test('Team JSON ready requires complete unexpired target credentials and actual membership', () => {
  const joined = { ...account, joinedTeams: [activeMembership] };
  for (const partial of [{ ready: false }, { hasAccessToken: false }, { hasRefreshToken: false }, { expiresAt: '' }, { expiresAt: 'invalid' }, { expiresAt: '2020-01-01T00:00:00Z' }]) {
    assert.equal(teamAutoJsonState({ ...joined, teamAuthorizations: [{ ...authorization, ...partial }] }, invitationMother).ready, false);
  }
  const pending = teamAutoJsonState({ ...account, teamInvitations: [invitation], teamAuthorizations: [authorization] }, invitationMother);
  assert.equal(pending.invited, true);
  assert.equal(pending.related, true);
  assert.equal(pending.member, false);
  assert.equal(pending.ready, false, 'an unaccepted invitation cannot expose stale Team credentials as ready');
  assert.equal(teamAutoJsonState({ ...account, teamAuthorizations: [authorization] }, { ...invitationMother, members: [{ email: account.email }] }).ready, true);
});

test('old joined invitations and removed membership history do not stay related to a target Team', () => {
  const removed = { ...account, team: teamId, joinedTeams: [{ team: teamId, status: 'kicked' }], teamInvitations: [{ ...invitation, status: 'joined' }], teamAuthorizations: [authorization] };
  const state = teamAutoJsonState(removed, invitationMother);
  assert.equal(state.member, false);
  assert.equal(state.invited, false);
  assert.equal(state.related, false);
  assert.equal(state.ready, false);
  for (const pending of [{ ...invitation, workspaceId: 'another-workspace' }, { ...invitation, motherId: 'another-mother' }]) {
    assert.equal(teamAutoJsonState({ ...account, teamInvitations: [pending] }, invitationMother).related, false);
  }
});

test('Team login state comes exclusively from target authorization metadata', () => {
  const login = { workspaceId: teamId, status: 'verification_required', browserRequired: true, authUrl: 'https://auth.openai.com/oauth/authorize?state=fixture-team' };
  const target = { ...account, teamInvitations: [invitation], teamLogin: login, login: { status: 'ready' } };
  assert.equal(teamAutoJsonState(target, invitationMother).login, null);
  assert.deepEqual(teamAutoJsonState({ ...target, teamAuthorizations: [{ ...authorization, login }] }, invitationMother).login, login);
  assert.equal(teamAutoJsonState({ ...target, teamAuthorizations: [{ ...authorization, login: { ...login, workspaceId: 'another-workspace' } }] }, invitationMother).login, null);
  assert.equal(teamAutoJsonState(null, null).related, false);
  assert.equal(teamInviteCandidateState(null, null).selectable, false);
});

test('stale ready login metadata cannot claim complete Team authorization with expired or partial JSON', () => {
  const login = { workspaceId: teamId, status: 'ready', code: 'ready', message: '之前已授权' };
  const joined = { ...account, joinedTeams: [activeMembership] };
  for (const invalid of [{ hasRefreshToken: false }, { hasAccessToken: false }, { expiresAt: '2020-01-01T00:00:00Z' }, { ready: false }]) {
    const state = teamAutoJsonState({ ...joined, teamAuthorizations: [{ ...authorization, ...invalid, login }] }, invitationMother);
    assert.equal(state.ready, false);
    assert.equal(state.login.status, 'login_required');
    assert.equal(state.login.code, 'team_json_incomplete');
    assert.equal(state.login.authUrl, null);
    assert.equal(teamAuthorizationState({ ...joined, teamLogin: state.login }, teamId)?.pending, true);
    assert.equal(login.status, 'ready', 'normalization must not mutate server metadata');
  }
  const valid = teamAutoJsonState({ ...joined, teamAuthorizations: [{ ...authorization, login }] }, invitationMother);
  assert.equal(valid.login.status, 'ready');
  const challenge = { workspaceId: teamId, status: 'browser_verification_required', browserRequired: true, needsInput: true, authUrl: 'https://auth.openai.com/oauth/authorize?state=fixture-team' };
  assert.deepEqual(teamAutoJsonState({ ...joined, teamAuthorizations: [{ ...authorization, ready: false, login: challenge }] }, invitationMother).login, challenge);
});

test('multi-Team overview preserves independent ready and pending authorization for the same account', () => {
  const secondMother = { id: 'mother-second', accountId: 'workspace-second', email: 'owner2@fixture.test' };
  const pendingLogin = { workspaceId: secondMother.accountId, status: 'verification_required', browserRequired: true, authUrl: 'https://auth.openai.com/oauth/authorize?state=second' };
  const joined = {
    ...account,
    joinedTeams: [activeMembership, { team: secondMother.accountId, status: 'active' }],
    teamAuthorizations: [authorization, { motherId: secondMother.id, workspaceId: secondMother.accountId, ready: false, hasAccessToken: false, hasRefreshToken: false, login: pendingLogin }],
  };
  const workflows = teamAccountWorkflows(joined, [invitationMother, secondMother]);
  assert.deepEqual(workflows.map(({ mother: target, workspaceId, ready }) => [target.id, workspaceId, ready]), [
    [invitationMother.id, teamId, true],
    [secondMother.id, secondMother.accountId, false],
  ]);
  assert.equal(workflows[0].login, null);
  assert.equal(workflows[1].login, pendingLogin);
  assert.deepEqual(teamAccountWorkflows(joined, [invitationMother, secondMother], secondMother.id), [workflows[1]]);
});

test('multi-Team overview includes invitations and removed history without showing stale authorization as ready', () => {
  const removedMother = { id: 'mother-removed', accountId: 'workspace-removed' };
  const unrelatedMother = { id: 'mother-unrelated', accountId: 'workspace-unrelated' };
  const historicalMother = { id: 'mother-history', accountId: 'workspace-history' };
  const recipient = {
    ...account,
    teamInvitations: [invitation],
    joinedTeams: [{ team: removedMother.accountId, status: 'kicked' }, { team: historicalMother.accountId, status: 'cooldown' }],
    teamAuthorizations: [{ ...authorization, motherId: removedMother.id, workspaceId: removedMother.accountId }],
  };
  const workflows = teamAccountWorkflows(recipient, [invitationMother, removedMother, unrelatedMother, historicalMother]);
  assert.deepEqual(workflows.map((workflow) => workflow.mother.id), [invitationMother.id, removedMother.id, historicalMother.id]);
  assert.equal(workflows[0].invited, true);
  assert.equal(workflows[0].related, true);
  assert.equal(workflows[1].ready, false);
  assert.equal(workflows[1].related, false);
  assert.equal(workflows[1].membership.status, 'kicked');
  assert.equal(workflows[2].membership.status, 'cooldown');
  assert.equal(workflows[2].authorization, null);
});

test('explicit Team selection includes uninvited accounts while absent or unknown targets never choose a first Team', () => {
  const unrelatedMother = { id: 'mother-unrelated', accountId: 'workspace-unrelated' };
  assert.deepEqual(teamAccountWorkflows(account, [invitationMother, unrelatedMother]), []);
  const selected = teamAccountWorkflows(account, [invitationMother, unrelatedMother], unrelatedMother.id);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].mother, unrelatedMother);
  assert.equal(selected[0].related, false);
  assert.equal(selected[0].ready, false);
  assert.deepEqual(teamAccountWorkflows(account, [invitationMother, unrelatedMother], 'missing-mother'), []);
  assert.deepEqual(teamAccountWorkflows(account), []);
  assert.deepEqual(teamAccountWorkflows(account, null), []);
});

test('Free credentials and unassociated Team metadata cannot create ready authorization in a multi-Team overview', () => {
  const secondMother = { id: 'mother-second', accountId: 'workspace-second' };
  const pooled = {
    ...account,
    hasAccessToken: true,
    credentialsStatus: { hasAccessToken: true, hasRefreshToken: true },
    sub2apiStatus: { exportable: true },
    login: { status: 'ready' },
    teamInvitations: [invitation],
    teamAuthorizations: [{ ...authorization, motherId: secondMother.id, workspaceId: secondMother.accountId }],
  };
  const workflows = teamAccountWorkflows(pooled, [invitationMother, secondMother]);
  assert.equal(workflows.length, 2, 'authorization-only metadata remains visible for inspection');
  assert.equal(workflows.every((workflow) => !workflow.ready), true);
  assert.equal(workflows[0].authorization, null, 'another Team authorization cannot replace invited Team authorization');
  assert.equal(workflows[1].related, false, 'credentials alone cannot prove current membership');
});
