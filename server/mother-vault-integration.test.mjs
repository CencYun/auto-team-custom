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

const serverScript = fileURLToPath(new URL('./index.mjs', import.meta.url));
async function fixture(t) {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mother-vault-integration-'));
  const stateFile = path.join(dataDir, 'state.json');
  await writeFile(stateFile, JSON.stringify({ version: 1, settings: { autoRefill: false },
    mothers: [{ id: 'mother-existing', email: 'real-owner@example.test', team: 'team-existing', rotationEnabled: false }],
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
    const preload = `globalThis.fetch = async () => { process.stderr.write('UNEXPECTED_VAULT_NETWORK_REQUEST'); throw new Error('isolated_network_disabled'); };`;
    app = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, serverScript], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), TEAM_ROTATION_DATA_DIR: dataDir,
        TEAM_ROTATION_DATA_KEY: '', TEAM_ROTATION_API_TOKEN: '', TEAM_ROTATION_LOGIN_PASSWORD: 'vault-fixture-password',
        DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.stdout.on('data', (chunk) => { output += chunk; });
    app.stderr.on('data', (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (app.exitCode !== null) throw new Error(`vault fixture exited: ${output}`);
      try { if ((await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Listener is starting. */ }
      await delay(25);
    }
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'vault-fixture-password' }) });
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

test('vault storage survives restart encrypted, hides secrets by default and never affects managed accounts or network', async (t) => {
  const app = await fixture(t);
  const before = await app.decoded();
  assert.deepEqual((await app.request('/api/mother-vault')).data.records, []);
  const values = { account: 'stored-only@example.test', password: '  private-vault-password----"\\\n  ', totp: 'private-vault-2FA-secret', note: '只存放\n----备注', remarkTime: '2026-10-20 18:00 到期' };
  const created = await app.request('/api/mother-vault', { method: 'POST', body: values });
  assert.equal(created.status, 201);
  const id = created.data.record.id;
  assert.equal(created.data.record.hasPassword, true);
  assert.equal(created.data.record.hasTotp, true);
  assert.equal(created.data.record.password, undefined);
  assert.equal(created.data.record.totp, undefined);
  const listed = await app.request('/api/mother-vault');
  assert.equal(listed.data.records.length, 1);
  assert.doesNotMatch(JSON.stringify(listed.data), /private-vault-/);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  for (const route of ['/api/state', '/api/state?includeHistory=false', '/api/history', '/api/account-exports']) {
    const publicResult = await app.request(route);
    assert.equal(publicResult.status, 200);
    assert.doesNotMatch(JSON.stringify(publicResult.data), /private-vault-|stored-only@example.test|motherVault/);
  }
  const detail = await app.request(`/api/mother-vault/${id}`);
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  for (const [key, value] of Object.entries(values)) assert.equal(detail.data.record[key], value);
  const raw = await app.saved();
  assert.equal(JSON.parse(raw).encrypted, true);
  assert.doesNotMatch(raw, /private-vault-|stored-only@example.test/);
  const decoded = await app.decoded();
  for (const field of ['mothers', 'children', 'history', 'settings']) assert.deepEqual(decoded[field], before[field], `${field} must stay independent`);
  await app.restart();
  assert.deepEqual((await app.request(`/api/mother-vault/${id}`)).data, detail.data);
  const edited = await app.request(`/api/mother-vault/${id}`, { method: 'PATCH', body: { note: '编辑备注', remarkTime: '' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.record.hasPassword, true);
  const afterEdit = (await app.request(`/api/mother-vault/${id}`)).data.record;
  assert.equal(afterEdit.password, values.password);
  assert.equal(afterEdit.totp, values.totp);
  assert.equal(afterEdit.createdAt, detail.data.record.createdAt);
  assert.equal(afterEdit.remarkTime, '');
  assert.doesNotMatch(app.output(), /UNEXPECTED_VAULT_NETWORK_REQUEST|private-vault-/);
});

test('vault API import/export and deletion use atomic exact selections, preserving duplicates and unrelated rows', async (t) => {
  const app = await fixture(t);
  const imported = await app.request('/api/mother-vault/import', { method: 'POST', body: { text: 'a@example.test----first-secret----2fa----备注----时间\nb@example.test----second-secret----2fa' } });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.imported, 2);
  const [a, b] = imported.data.records;
  const saved = await app.saved();
  const bad = await app.request('/api/mother-vault/import', { method: 'POST', body: { text: 'valid@example.test----new-secret----2fa\ninvalid-secret-line' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.errors[0].line, 2);
  assert.doesNotMatch(JSON.stringify(bad.data), /invalid-secret-line|new-secret/);
  assert.equal(await app.saved(), saved);
  const duplicate = await app.request('/api/mother-vault/import', { method: 'POST', body: { records: [{ account: 'A@example.test', password: 'overwrite' }] } });
  assert.equal(duplicate.data.imported, 0);
  assert.equal(duplicate.data.skipped, 1);
  assert.equal((await app.request(`/api/mother-vault/${a.id}`)).data.record.password, 'first-secret');
  assert.equal(await app.saved(), saved);
  const conflict = await app.request(`/api/mother-vault/${b.id}`, { method: 'PATCH', body: { account: 'a@example.test' } });
  assert.equal(conflict.status, 409);
  for (const action of ['export', 'batch-delete']) {
    for (const ids of [undefined, [], [a.id, a.id], [1]]) {
      assert.equal((await app.request(`/api/mother-vault/${action}`, { method: 'POST', body: { ids } })).status, 400);
    }
    assert.equal((await app.request(`/api/mother-vault/${action}`, { method: 'POST', body: { ids: [a.id, 'missing'] } })).status, 409);
  }
  assert.equal(await app.saved(), saved);
  const exported = await app.request('/api/mother-vault/export', { method: 'POST', body: { ids: [b.id] } });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('cache-control'), 'no-store');
  assert.equal(exported.data.records.length, 1);
  assert.equal(exported.data.records[0].password, 'second-secret');
  assert.equal((await app.request('/api/mother-vault/batch-delete', { method: 'POST', body: { ids: [b.id] } })).data.deleted, 1);
  assert.deepEqual((await app.request('/api/mother-vault')).data.records.map((record) => record.id), [a.id]);
  const restored = await app.request('/api/mother-vault/import', { method: 'POST', body: { text: JSON.stringify(exported.data) } });
  assert.equal(restored.data.imported, 1);
  assert.notEqual(restored.data.records[0].id, b.id);
  assert.equal((await app.request(`/api/mother-vault/${restored.data.records[0].id}`)).data.record.password, 'second-secret');
  assert.equal((await app.request(`/api/mother-vault/${a.id}`, { method: 'DELETE' })).data.deleted, 1);
  assert.equal((await app.request(`/api/mother-vault/${a.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await app.request('/api/mother-vault')).data.records.length, 1);
  assert.doesNotMatch(app.output(), /UNEXPECTED_VAULT_NETWORK_REQUEST/);
});

test('vault routes enforce existing authentication and origin protection including detail/export/delete', async (t) => {
  const app = await fixture(t);
  const created = await app.request('/api/mother-vault', { method: 'POST', body: { account: 'auth-check@example.test', password: 'secret' } });
  const id = created.data.record.id;
  const operations = [
    ['/api/mother-vault', 'GET'], [`/api/mother-vault/${id}`, 'GET'],
    ['/api/mother-vault', 'POST', { account: 'x' }], [`/api/mother-vault/${id}`, 'PATCH', { note: 'x' }],
    ['/api/mother-vault/import', 'POST', { records: [{ account: 'x' }] }],
    ['/api/mother-vault/export', 'POST', { ids: [id] }],
    ['/api/mother-vault/batch-delete', 'POST', { ids: [id] }], [`/api/mother-vault/${id}`, 'DELETE'],
  ];
  const saved = await app.saved();
  for (const [route, method, body] of operations) {
    assert.equal((await app.request(route, { method, body, authenticated: false })).status, 401);
    assert.equal((await app.request(route, { method, body, headers: { origin: 'https://untrusted.example.test' } })).status, 403);
  }
  assert.equal(await app.saved(), saved);
  assert.equal((await app.request('/api/mother-vault/missing')).status, 404);
});
