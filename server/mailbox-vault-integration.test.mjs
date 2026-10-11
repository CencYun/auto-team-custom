import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createStateStorage } from './security.mjs';
import { exportMailboxVaultText } from '../shared/mailbox-vault-text.mjs';

const serverScript = fileURLToPath(new URL('./index.mjs', import.meta.url));
async function fixture(t) {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mailbox-vault-integration-'));
  const stateFile = path.join(dataDir, 'state.json');
  await writeFile(stateFile, JSON.stringify({ version: 1, settings: { autoRefill: false },
    mothers: [{ id: 'mother-existing', email: 'owner@example.test', team: 'team-existing', rotationEnabled: false }],
    motherVault: [{ id: 'vault-existing', account: 'stored-only@example.test', password: 'mother-fixture-password', totp: '', note: '', remarkTime: '' }],
    children: [{ id: 'child-existing', email: 'member@example.test' }],
    history: [{ id: 'history-existing', action: '保留记录', detail: '原有数据' }],
  }));
  const base = `http://127.0.0.1:${port}`;
  let app;
  let output = '';
  let cookie;
  async function stop() {
    if (app?.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await exited;
    }
  }
  async function start() {
    const preload = `globalThis.fetch = async () => { process.stderr.write('UNEXPECTED_MAILBOX_NETWORK_REQUEST'); throw new Error('isolated_network_disabled'); };`;
    app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), TEAM_ROTATION_DATA_DIR: dataDir,
        TEAM_ROTATION_DATA_KEY: '', TEAM_ROTATION_API_TOKEN: '', TEAM_ROTATION_LOGIN_PASSWORD: 'mailbox-fixture-password',
        DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.stdout.on('data', (chunk) => { output += chunk; });
    app.stderr.on('data', (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (app.exitCode !== null) throw new Error(`mailbox fixture exited: ${output}`);
      try { if ((await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Listener is starting. */ }
      await delay(25);
    }
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'mailbox-fixture-password' }) });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';', 1)[0];
  }
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  await start();
  const storage = await createStateStorage(dataDir);
  return {
    async request(route, { method = 'GET', body, authenticated = true, headers = {} } = {}) {
      const response = await fetch(`${base}${route}`, { method,
        headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, data: await response.json(), headers: response.headers };
    },
    restart: async () => { await stop(); await start(); },
    saved: () => readFile(stateFile, 'utf8'),
    decoded: async () => storage.decode(await readFile(stateFile, 'utf8')),
    output: () => output,
  };
}

test('mailbox vault persists encrypted, survives restart and stays isolated from mother/Free management', async (t) => {
  const app = await fixture(t);
  const before = await app.decoded();
  assert.deepEqual((await app.request('/api/mailbox-vault')).data.records, []);
  const values = { account: 'stored-only@example.test', password: ' private-mailbox-password----"\\\r\n ', totp: 'private-mailbox-2FA-secret' };
  const created = await app.request('/api/mailbox-vault', { method: 'POST', body: values });
  assert.equal(created.status, 201);
  const id = created.data.record.id;
  assert.equal(created.data.record.hasPassword, true);
  assert.equal(created.data.record.hasTotp, true);
  assert.equal(created.data.record.password, undefined);
  assert.equal(created.data.record.totp, undefined);
  const listed = await app.request('/api/mailbox-vault');
  assert.equal(listed.data.records.length, 1);
  assert.doesNotMatch(JSON.stringify(listed.data), /private-mailbox-/);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  for (const route of ['/api/state', '/api/state?includeHistory=false', '/api/history', '/api/account-exports']) {
    const result = await app.request(route);
    assert.equal(result.status, 200);
    assert.doesNotMatch(JSON.stringify(result.data), /private-mailbox-|stored-only@example.test|mailboxVault/);
  }
  const detail = await app.request(`/api/mailbox-vault/${id}`);
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  for (const [key, value] of Object.entries(values)) assert.equal(detail.data.record[key], value);
  const raw = await app.saved();
  assert.equal(JSON.parse(raw).encrypted, true);
  assert.doesNotMatch(raw, /private-mailbox-|stored-only@example.test/);
  const decoded = await app.decoded();
  for (const field of ['mothers', 'motherVault', 'children', 'history', 'settings']) assert.deepEqual(decoded[field], before[field], `${field} stays independent`);
  await app.restart();
  assert.deepEqual((await app.request(`/api/mailbox-vault/${id}`)).data, detail.data);
  assert.equal((await app.request(`/api/mailbox-vault/${id}`, { method: 'PATCH', body: { totp: '' } })).status, 200);
  const edited = (await app.request(`/api/mailbox-vault/${id}`)).data.record;
  assert.equal(edited.password, values.password);
  assert.equal(edited.totp, '');
  assert.equal(edited.createdAt, detail.data.record.createdAt);
  assert.doesNotMatch(app.output(), /UNEXPECTED_MAILBOX_NETWORK_REQUEST|private-mailbox-/);
});

test('mailbox bulk import/export/delete is atomic and TXT exports reimport without losing special passwords', async (t) => {
  const app = await fixture(t);
  const imported = await app.request('/api/mailbox-vault/import', { method: 'POST', body: { text: 'a@example.test----first-secret----2fa\nb@example.test|second,secret|2fa\nc@example.test\tthird-secret\t2fa' } });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.imported, 3);
  const [a, b, c] = imported.data.records;
  const saved = await app.saved();
  const bad = await app.request('/api/mailbox-vault/import', { method: 'POST', body: { text: 'valid@example.test----new-secret----2fa\ninvalid-secret-line' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.errors[0].line, 2);
  assert.doesNotMatch(JSON.stringify(bad.data), /invalid-secret-line|new-secret/);
  assert.equal(await app.saved(), saved);
  const duplicate = await app.request('/api/mailbox-vault/import', { method: 'POST', body: { text: 'A@example.test----overwrite----2fa' } });
  assert.equal(duplicate.data.imported, 0);
  assert.equal(duplicate.data.skipped, 1);
  assert.equal((await app.request(`/api/mailbox-vault/${a.id}`)).data.record.password, 'first-secret');
  assert.equal(await app.saved(), saved);
  assert.equal((await app.request(`/api/mailbox-vault/${b.id}`, { method: 'PATCH', body: { account: 'a@example.test' } })).status, 409);
  for (const action of ['export', 'batch-delete']) {
    for (const ids of [undefined, [], [a.id, a.id], [1]]) {
      assert.equal((await app.request(`/api/mailbox-vault/${action}`, { method: 'POST', body: { ids } })).status, 400);
    }
    assert.equal((await app.request(`/api/mailbox-vault/${action}`, { method: 'POST', body: { ids: [a.id, 'missing'] } })).status, 409);
  }
  assert.equal(await app.saved(), saved);
  const exported = await app.request('/api/mailbox-vault/export', { method: 'POST', body: { ids: [b.id, a.id] } });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('cache-control'), 'no-store');
  assert.deepEqual(exported.data.records.map((record) => record.id), [b.id, a.id]);
  assert.equal((await app.request('/api/mailbox-vault/batch-delete', { method: 'POST', body: { ids: [a.id, b.id] } })).data.deleted, 2);
  assert.deepEqual((await app.request('/api/mailbox-vault')).data.records.map((record) => record.id), [c.id]);
  const restored = await app.request('/api/mailbox-vault/import', { method: 'POST', body: { text: exportMailboxVaultText(exported.data.records) } });
  assert.equal(restored.data.imported, 2);
  assert.notEqual(restored.data.records[0].id, b.id);
  assert.equal((await app.request(`/api/mailbox-vault/${restored.data.records[0].id}`)).data.record.password, 'second,secret');
  assert.equal((await app.request(`/api/mailbox-vault/${c.id}`, { method: 'DELETE' })).data.deleted, 1);
  assert.equal((await app.request(`/api/mailbox-vault/${c.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await app.request('/api/mailbox-vault')).data.records.length, 2);
  assert.deepEqual((await app.decoded()).motherVault, [{ id: 'vault-existing', account: 'stored-only@example.test', password: 'mother-fixture-password', totp: '', note: '', remarkTime: '' }]);
  assert.doesNotMatch(app.output(), /UNEXPECTED_MAILBOX_NETWORK_REQUEST/);
});

test('every mailbox route enforces existing authentication, origin checks and fresh selections', async (t) => {
  const app = await fixture(t);
  const created = await app.request('/api/mailbox-vault', { method: 'POST', body: { account: 'auth-check@example.test', password: 'secret' } });
  const id = created.data.record.id;
  const operations = [
    ['/api/mailbox-vault', 'GET'], [`/api/mailbox-vault/${id}`, 'GET'],
    ['/api/mailbox-vault', 'POST', { account: 'x@example.test' }], [`/api/mailbox-vault/${id}`, 'PATCH', { password: 'x' }],
    ['/api/mailbox-vault/import', 'POST', { text: 'x@example.test----p----t' }],
    ['/api/mailbox-vault/export', 'POST', { ids: [id] }],
    ['/api/mailbox-vault/mark-exported', 'POST', { records: [{ id, account: created.data.record.account }] }],
    ['/api/mailbox-vault/batch-delete', 'POST', { ids: [id] }], [`/api/mailbox-vault/${id}`, 'DELETE'],
  ];
  const saved = await app.saved();
  for (const [route, method, body] of operations) {
    assert.equal((await app.request(route, { method, body, authenticated: false })).status, 401);
    assert.equal((await app.request(route, { method, body, headers: { origin: 'https://untrusted.example.test' } })).status, 403);
  }
  assert.equal(await app.saved(), saved);
  assert.equal((await app.request('/api/mailbox-vault/missing')).status, 404);
});

test('mailbox export marking is explicit, atomic, persistent and permits exporting used emails again', async (t) => {
  const app = await fixture(t);
  const imported = await app.request('/api/mailbox-vault/import', { method: 'POST', body: { records: [
    { account: 'a@example.test', password: 'a----secret', totp: 'first-2fa', exportedAt: 'forged' },
    { account: 'b@example.test', password: ' b,secret ', totp: 'second-2fa' },
    { account: 'c@example.test', password: 'c-secret', totp: '' },
  ] } });
  assert.equal(imported.status, 200);
  const [a, b, c] = imported.data.records;
  assert.ok(imported.data.records.every((record) => record.exportedAt === null));
  const saved = await app.saved();
  const before = await app.decoded();
  const exported = await app.request('/api/mailbox-vault/export', { method: 'POST', body: { ids: [b.id, a.id] } });
  assert.equal(exported.status, 200);
  assert.ok(exported.data.records.every((record) => record.exportedAt === null));
  assert.ok((await app.request('/api/mailbox-vault')).data.records.every((record) => record.exportedAt === null));
  assert.equal((await app.request(`/api/mailbox-vault/${a.id}`)).data.record.exportedAt, null);
  assert.equal(await app.saved(), saved, 'loading list, credentials and export never mark mailboxes');
  for (const records of [undefined, [], [null], [{ id: a.id }], [{ id: a.id, account: 123 }],
    [{ id: a.id, account: a.account }, { id: a.id, account: a.account }]]) {
    assert.equal((await app.request('/api/mailbox-vault/mark-exported', { method: 'POST', body: { records } })).status, 400);
  }
  for (const records of [
    [{ id: a.id, account: a.account }, { id: b.id, account: 'old@example.test' }],
    [{ id: a.id, account: a.account }, { id: 'missing', account: b.account }],
  ]) assert.equal((await app.request('/api/mailbox-vault/mark-exported', { method: 'POST', body: { records } })).status, 409);
  assert.equal(await app.saved(), saved, 'invalid selections do not partially mark records');
  const marked = await app.request('/api/mailbox-vault/mark-exported', { method: 'POST', body: {
    records: [{ id: b.id, account: 'B@EXAMPLE.TEST' }, { id: a.id, account: a.account }],
  } });
  assert.equal(marked.status, 200);
  assert.deepEqual(marked.data.records.map((record) => record.id), [b.id, a.id]);
  assert.ok(marked.data.records.every((record) => Number.isFinite(Date.parse(record.exportedAt))));
  assert.ok(marked.data.records.every((record) => !('password' in record) && !('totp' in record)));
  const stamp = marked.data.records[0].exportedAt;
  const listed = (await app.request('/api/mailbox-vault')).data.records;
  assert.equal(listed.find((record) => record.id === c.id).exportedAt, null);
  assert.equal(listed.find((record) => record.id === a.id).exportedAt, stamp);
  assert.equal(JSON.parse(await app.saved()).encrypted, true);
  const decoded = await app.decoded();
  for (const field of ['mothers', 'motherVault', 'children', 'history', 'settings']) assert.deepEqual(decoded[field], before[field]);
  await app.restart();
  assert.deepEqual((await app.request('/api/mailbox-vault')).data.records, listed);
  assert.equal((await app.request(`/api/mailbox-vault/${a.id}`)).data.record.exportedAt, stamp);
  const repeated = await app.request('/api/mailbox-vault/export', { method: 'POST', body: { ids: [b.id, a.id] } });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.records[0].exportedAt, stamp);
  assert.equal(exportMailboxVaultText(repeated.data.records), exportMailboxVaultText(exported.data.records));
  assert.equal((await app.request('/api/mailbox-vault/mark-exported', { method: 'POST', body: {
    records: repeated.data.records.map(({ id, account }) => ({ id, account })),
  } })).status, 200);
  const bStamp = (await app.request(`/api/mailbox-vault/${b.id}`)).data.record.exportedAt;
  const edited = await app.request(`/api/mailbox-vault/${b.id}`, { method: 'PATCH', body: {
    account: 'B@example.test', password: 'new-password', totp: 'new-2fa', exportedAt: null,
  } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.record.exportedAt, bStamp);
  const changed = await app.request(`/api/mailbox-vault/${b.id}`, { method: 'PATCH', body: { account: 'changed@example.test', exportedAt: bStamp } });
  assert.equal(changed.data.record.exportedAt, null);
  const afterEdit = await app.saved();
  assert.equal((await app.request('/api/mailbox-vault/mark-exported', { method: 'POST', body: {
    records: [{ id: a.id, account: a.account }, { id: b.id, account: b.account }],
  } })).status, 409);
  assert.equal(await app.saved(), afterEdit);
  assert.doesNotMatch(app.output(), /UNEXPECTED_MAILBOX_NETWORK_REQUEST|a----secret|new-password/);
});
