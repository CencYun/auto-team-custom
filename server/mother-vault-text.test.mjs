import assert from 'node:assert/strict';
import test from 'node:test';
import { exportMotherVaultText } from '../shared/mother-vault-text.mjs';
import { importMotherVaultRecords } from './mother-vault.mjs';

const keys = ['account', 'password', 'totp', 'note', 'remarkTime'];
const clean = { account: 'owner@example.test', password: 'secret', totp: 'OPAQUE2FA', note: '母号备注', remarkTime: '2026-10-31 到期' };
const valuesOnly = (record) => Object.fromEntries(keys.map((key) => [key, record[key] ?? '']));

test('TXT uses five fields and Windows CRLF and round-trips Chinese notes, empty fields and verbatim secrets', () => {
  const records = [
    { ...clean, password: '  密码\\!"-- $ value  ', totp: ' 2FA opaque ', note: '中文备注\\保留', remarkTime: '2026-10-31 18:00' },
    { account: 'empty@example.test' },
    { account: 'last@example.test', password: '', totp: 'opaque', note: '', remarkTime: '' },
  ];
  const before = structuredClone(records);
  const text = exportMotherVaultText(records);
  assert.equal(text, 'owner@example.test----  密码\\!"-- $ value  ---- 2FA opaque ----中文备注\\保留----2026-10-31 18:00\r\nempty@example.test----------------\r\nlast@example.test--------opaque--------\r\n');
  assert.equal(text.charCodeAt(0), 'o'.charCodeAt(0), 'no BOM');
  assert.equal(text.split('\r\n').length, 4);
  assert.deepEqual(importMotherVaultRecords({ text }, []).added.map(valuesOnly), records.map(valuesOnly));
  assert.deepEqual(records, before);
});

test('TXT rejects embedded separators and CR/LF with row/field-only errors and JSON fallback advice', () => {
  const labels = ['账号', '密码', '2FA', '备注', '备注时间'];
  for (const [fieldIndex, key] of keys.entries()) {
    for (const special of ['\n', '\r', '\r\n', '----']) {
      const input = { ...clean, [key]: `private-sensitive${special}content` };
      assert.throws(() => exportMotherVaultText([clean, input]), (error) => {
        assert.match(error.message, /第 2 条/);
        assert.ok(error.message.includes(labels[fieldIndex]));
        assert.match(error.message, /JSON/);
        assert.doesNotMatch(error.message, /private-sensitive|content/);
        return true;
      });
    }
  }
});

test('TXT rejects hyphen boundaries that would shift a field, including adjacent empty fields', () => {
  for (const record of [
    { ...clean, account: 'owner@example.test-' },
    { ...clean, password: 'secret-', totp: '-opaque' },
    { ...clean, password: '-' },
    { ...clean, password: '', totp: '-', note: '' },
    { ...clean, note: '备注---', remarkTime: '' },
  ]) {
    assert.throws(() => exportMotherVaultText([record]), /第 1 条.*连字符.*JSON/);
  }
  const safe = { ...clean, password: '-secret', totp: '--opaque', note: 'a--b', remarkTime: '-2026-10-31-' };
  const text = exportMotherVaultText([safe]);
  assert.deepEqual(importMotherVaultRecords({ text }, []).added.map(valuesOnly), [safe]);
});

test('TXT does not emit an empty selection, invalid field types or an account prefix misread as JSON', () => {
  assert.throws(() => exportMotherVaultText([]), /选择/);
  assert.throws(() => exportMotherVaultText(null), /选择/);
  assert.throws(() => exportMotherVaultText([null]), /第 1 条/);
  assert.throws(() => exportMotherVaultText([{ ...clean, password: 123 }]), /第 1 条.*密码.*JSON/);
  assert.throws(() => exportMotherVaultText([{ ...clean, account: '[owner]' }]), /第 1 条.*账号.*JSON/);
  assert.throws(() => exportMotherVaultText([{ ...clean, account: ' owner ' }]), /第 1 条.*账号.*JSON/);
});
