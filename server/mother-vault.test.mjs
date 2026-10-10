import assert from 'node:assert/strict';
import test from 'node:test';
import { createMotherVaultRecord, exportMotherVaultRecords, fullMotherVaultRecord, importMotherVaultRecords, publicMotherVaultRecord, selectMotherVaultRecords, updateMotherVaultRecord } from './mother-vault.mjs';

const firstTime = '2026-10-10T01:00:00.000Z';
const secondTime = '2026-10-10T02:00:00.000Z';
const sample = { account: ' Owner@Example.test ', password: '  password----中文\n"\\  ', totp: '2FA opaque ---- value', note: '备注\n第二行----x', remarkTime: '2026-10-15 到期' };

test('vault stores credentials verbatim, trims only account, and exposes metadata separately', () => {
  const record = createMotherVaultRecord({ ...sample, id: 'forged', createdAt: 'forged', accessToken: 'ignored' }, [], firstTime);
  assert.match(record.id, /^vault_/);
  assert.equal(record.account, 'Owner@Example.test');
  assert.equal(record.password, sample.password);
  assert.equal(record.totp, sample.totp);
  assert.equal(record.note, sample.note);
  assert.equal(record.remarkTime, sample.remarkTime);
  assert.equal(record.createdAt, firstTime);
  assert.equal(record.updatedAt, firstTime);
  assert.equal(record.accessToken, undefined);
  assert.deepEqual(publicMotherVaultRecord(record), { id: record.id, account: record.account, hasPassword: true, hasTotp: true, note: sample.note, remarkTime: sample.remarkTime, createdAt: firstTime, updatedAt: firstTime });
  assert.deepEqual(fullMotherVaultRecord(record), record);
});

test('partial edits preserve existing credentials and reject duplicate renamed accounts', () => {
  const a = createMotherVaultRecord(sample, [], firstTime);
  const b = createMotherVaultRecord({ account: 'second@example.test' }, [a], firstTime);
  const updated = updateMotherVaultRecord(a, { note: '新的备注', remarkTime: '', id: b.id, createdAt: 'forged' }, [a, b], secondTime);
  assert.equal(updated.password, sample.password);
  assert.equal(updated.totp, sample.totp);
  assert.equal(updated.id, a.id);
  assert.equal(updated.createdAt, firstTime);
  assert.equal(updated.updatedAt, secondTime);
  assert.equal(updated.remarkTime, '');
  assert.equal(updated.note, '新的备注');
  assert.throws(() => updateMotherVaultRecord(a, { account: ' SECOND@example.test ' }, [a, b]), { status: 409 });
  assert.throws(() => createMotherVaultRecord({ account: ' owner@example.TEST ' }, [a]), { status: 409 });
});

test('line imports preserve whitespace in secrets and support optional empty fields', () => {
  const imported = importMotherVaultRecords({ text: '\n a@example.test ---- pass with spaces ---- 2FA opaque ----备注----到期时间\n\nb@example.test--------\n' }, [], firstTime);
  assert.equal(imported.added.length, 2);
  assert.equal(imported.added[0].account, 'a@example.test');
  assert.equal(imported.added[0].password, ' pass with spaces ');
  assert.equal(imported.added[0].totp, ' 2FA opaque ');
  assert.equal(imported.added[0].remarkTime, '到期时间');
  assert.equal(imported.added[1].password, '');
  assert.equal(imported.added[1].totp, '');
  assert.equal(imported.added[1].note, '');
});

test('JSON exports round-trip special characters without identity/timestamp injection', () => {
  const a = createMotherVaultRecord(sample, [], firstTime);
  const exported = exportMotherVaultRecords([a], [a.id], secondTime);
  const imported = importMotherVaultRecords({ text: JSON.stringify(exported) }, [], secondTime).added[0];
  for (const key of ['account', 'password', 'totp', 'note', 'remarkTime']) assert.equal(imported[key], a[key]);
  assert.notEqual(imported.id, a.id);
  assert.equal(imported.createdAt, secondTime);
  assert.equal(imported.updatedAt, secondTime);
  assert.equal(importMotherVaultRecords({ text: JSON.stringify([sample]) }, []).added.length, 1);
  assert.equal(importMotherVaultRecords({ records: [sample] }, []).added.length, 1);
});

test('duplicate imports skip existing and repeated accounts without overwriting secrets', () => {
  const existing = createMotherVaultRecord(sample, [], firstTime);
  const before = structuredClone(existing);
  const result = importMotherVaultRecords({ records: [
    { account: 'owner@example.test', password: 'replace' },
    { account: 'new@example.test', password: 'first' },
    { account: 'NEW@example.test', password: 'second' },
  ] }, [existing]);
  assert.equal(result.skipped, 2);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].password, 'first');
  assert.deepEqual(existing, before);
});

test('invalid rows reject whole input with row numbers and no secret content', () => {
  const records = [createMotherVaultRecord(sample, [], firstTime)];
  const before = structuredClone(records);
  for (const input of [
    { records: [{ account: 'valid@example.test' }, { account: '', password: 'sensitive-test-value' }] },
    { text: 'valid@example.test----secret----2fa\n\nsensitive-test-value' },
    { text: 'a----b----c----d----e----sensitive-test-value' },
  ]) {
    assert.throws(() => importMotherVaultRecords(input, records), (error) => {
      assert.equal(error.status, 400);
      assert.ok(error.errors[0].line >= 1);
      assert.doesNotMatch(JSON.stringify(error), /sensitive-test-value|secret/);
      return true;
    });
  }
  assert.deepEqual(records, before);
});

test('invalid shapes, versions, field types and oversized inputs are rejected', () => {
  for (const input of [null, [], { records: [] }, { text: '' }, { text: '{invalid' }, { text: '{"format":"auto-team-mother-vault","version":2,"records":[]}' }, { text: 'x', records: [] }, { records: [null] }, { records: [{ account: 'ok', password: 123 }] }, { records: [{ account: 'line\nbreak' }] }, { records: [{ account: 'ok', note: 'x'.repeat(10001) }] }, { records: Array.from({ length: 2001 }, () => ({ account: 'ok' })) }]) {
    assert.throws(() => importMotherVaultRecords(input, []), { status: 400 });
  }
});

test('selection is explicit, exact, ordered and cannot silently become export/delete all', () => {
  const a = createMotherVaultRecord({ account: 'a' }, []);
  const b = createMotherVaultRecord({ account: 'b' }, []);
  assert.deepEqual(selectMotherVaultRecords([a, b], [b.id]), [b]);
  assert.deepEqual(exportMotherVaultRecords([a, b], [b.id, a.id]).records.map((record) => record.id), [b.id, a.id]);
  for (const ids of [undefined, [], [a.id, a.id], [1], [''], 'all']) {
    assert.throws(() => selectMotherVaultRecords([a, b], ids), { status: 400 });
  }
  assert.throws(() => selectMotherVaultRecords([a, b], [a.id, 'missing']), { status: 409 });
});
