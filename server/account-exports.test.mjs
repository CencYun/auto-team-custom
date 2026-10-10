import assert from 'node:assert/strict';
import test from 'node:test';
import { OPENAI_OAUTH_CLIENT_ID } from './openai-auth.mjs';
import { buildAccountExportCandidates, savedExportCredential, selectAccountExports } from './account-exports.mjs';

const nowMs = Date.parse('2026-10-10T00:00:00.000Z');
const email = 'saved@example.test';

function jwt(fields = {}) {
  return `fixture.${Buffer.from(JSON.stringify({
    exp: nowMs / 1000 + 3600, sub: 'saved-user', client_id: OPENAI_OAUTH_CLIENT_ID,
    'https://api.openai.com/auth': { chatgpt_account_id: 'personal', chatgpt_plan_type: 'free', chatgpt_user_id: 'saved-user' },
    'https://api.openai.com/profile': { email }, ...fields,
  })).toString('base64url')}.private-fixture-signature`;
}
function record(fields = {}, claims = {}) {
  return { email, accessToken: jwt(claims), refreshToken: 'private-fixture-rt', chatgptUserId: 'saved-user', accountId: 'personal', ...fields };
}

test('saved JSON requires complete Codex OAuth credentials and verified local identity', () => {
  assert.ok(savedExportCredential(record(), { scope: 'free', nowMs }));
  for (const invalid of [
    record({ refreshToken: '' }), record({ accessToken: '' }), record({ accessToken: 'not-a-jwt' }),
    record({}, { client_id: 'chatgpt-web-session' }), record({}, { client_id: undefined }),
    record({}, { exp: undefined }), record({}, { exp: 1e300 }),
    record({ email: 'other@example.test' }), record({ chatgptUserId: 'other-user' }),
    record({ accountId: 'other-workspace' }), record({ status: 'banned' }),
    record({ chatgptUserId: '' }, { 'https://api.openai.com/profile': {} }),
  ]) assert.equal(savedExportCredential(invalid, { scope: 'free', nowMs }), null);
});

test('an expired saved AT with its RT remains exportable without claiming a live refresh', () => {
  const saved = savedExportCredential(record({}, { exp: nowMs / 1000 - 60 }), { scope: 'free', nowMs });
  assert.equal(saved.accessTokenExpired, true);
  assert.equal(saved.refreshToken, 'private-fixture-rt');
  assert.equal(savedExportCredential(record({ refreshToken: '' }, { exp: nowMs / 1000 - 60 }), { scope: 'free', nowMs }), null);
});

test('ID-token-only email must belong to the access token subject', () => {
  const noEmail = { 'https://api.openai.com/profile': {} };
  assert.ok(savedExportCredential(record({ chatgptUserId: '', idToken: jwt() }, noEmail), { scope: 'free', nowMs }));
  for (const idToken of [jwt({ 'https://api.openai.com/profile': { email: 'other@example.test' } }), jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'other-user' } })]) {
    assert.equal(savedExportCredential(record({ chatgptUserId: '', idToken }, noEmail), { scope: 'free', nowMs }), null);
  }
});

test('Team JSON requires actual Team plan and exact workspace; personal export never inherits current Team', () => {
  assert.equal(savedExportCredential(record({ team: 'joined-team' }), { scope: 'free', nowMs }).team, undefined);
  for (const plan of ['team', 'business', 'self_serve_business_prolite']) {
    const saved = record({ accountId: 'team-a' }, { 'https://api.openai.com/auth': { chatgpt_account_id: 'team-a', chatgpt_plan_type: plan, chatgpt_user_id: 'saved-user' } });
    assert.ok(savedExportCredential(saved, { scope: 'team', workspaceId: 'team-a', nowMs }));
    assert.equal(savedExportCredential(saved, { scope: 'free', nowMs }), null);
    assert.equal(savedExportCredential(saved, { scope: 'team', workspaceId: 'team-b', nowMs }), null);
  }
  assert.equal(savedExportCredential(record(), { scope: 'team', workspaceId: 'personal', nowMs }), null);
});

test('candidate IDs are stable per scope, account identity and workspace; duplicate sources choose freshest credential', () => {
  const sources = [{ scope: 'free', childId: 'child-a', record: record() }, { scope: 'team', motherId: 'mother-a', workspaceId: 'team-a', record: record({ accountId: 'team-a' }, { 'https://api.openai.com/auth': { chatgpt_account_id: 'team-a', chatgpt_plan_type: 'team', chatgpt_user_id: 'saved-user' } }) }];
  const candidates = buildAccountExportCandidates(sources, (value) => ({ email: value.email, credentials: { access_token: value.accessToken } }), { nowMs });
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0].metadata.id, candidates[1].metadata.id);
  assert.deepEqual(buildAccountExportCandidates([...sources].reverse(), (r) => r, { nowMs }).map((item) => item.metadata.id).sort(), candidates.map((item) => item.metadata.id).sort());
  assert.doesNotMatch(JSON.stringify(candidates.map((item) => item.metadata)), /private-fixture|access_token|refresh_token/);
  const duplicate = { ...sources[0], record: record({}, { exp: nowMs / 1000 - 60 }) };
  assert.equal(buildAccountExportCandidates([...sources, duplicate], (r) => r, { nowMs })[0].metadata.accessTokenExpired, false);
});

test('empty, duplicate and stale selections fail atomically, never default to exporting all', () => {
  const candidates = [{ metadata: { id: 'free:a' }, payload: { name: 'a' } }, { metadata: { id: 'team:b' }, payload: { name: 'b' } }];
  for (const ids of [undefined, null, [], 'free:a', [null], [1], [' '], ['free:a', 'free:a']]) {
    assert.equal(selectAccountExports(candidates, ids).status, 400);
  }
  assert.equal(selectAccountExports(candidates, ['free:a', 'stale']).status, 409);
  assert.deepEqual(selectAccountExports(candidates, ['team:b', 'free:a']).accounts, [{ name: 'b' }, { name: 'a' }]);
  assert.equal(selectAccountExports([], ['free:a']).status, 409);
});
