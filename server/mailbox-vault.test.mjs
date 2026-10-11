import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailboxVaultRecord, exportMailboxVaultRecords, fullMailboxVaultRecord, importMailboxVaultRecords, markMailboxVaultRecordsExported, publicMailboxVaultRecord, selectMailboxVaultRecords, updateMailboxVaultRecord } from './mailbox-vault.mjs';
import { exportMailboxVaultText, parseMailboxVaultText } from '../shared/mailbox-vault-text.mjs';

const firstTime = '2026-10-10T01:00:00.000Z';
const secondTime = '2026-10-10T02:00:00.000Z';
const sample = { account: ' Mail@Example.test ', password: '  p----中文,|\t"\\\r\n  ', totp: 'opaque 2fa ---- value' };

test('mailbox metadata stays separate and edits preserve credentials and server identities', () => {
  const record = createMailboxVaultRecord({ ...sample, id: 'forged', createdAt: 'forged', note: 'ignored', exportedAt: firstTime }, [], firstTime);
  assert.match(record.id, /^mailbox_vault_/);
  assert.equal(record.account, 'Mail@Example.test');
  assert.equal(record.password, sample.password);
  assert.equal(record.totp, sample.totp);
  assert.equal(record.note, undefined);
  assert.deepEqual(publicMailboxVaultRecord(record), { id: record.id, account: record.account, hasPassword: true, hasTotp: true, createdAt: firstTime, updatedAt: firstTime, exportedAt: null });
  assert.deepEqual(fullMailboxVaultRecord(record), record);
  const updated = updateMailboxVaultRecord(record, { totp: '', id: 'forged' }, [record], secondTime);
  assert.equal(updated.password, sample.password);
  assert.equal(updated.totp, '');
  assert.equal(updated.id, record.id);
  assert.equal(updated.createdAt, firstTime);
  assert.equal(updated.updatedAt, secondTime);
  assert.throws(() => createMailboxVaultRecord({ account: 'mail@example.TEST' }, [record]), { status: 409 });
  const other = createMailboxVaultRecord({ account: 'other@example.test' }, [record]);
  assert.throws(() => updateMailboxVaultRecord(other, { account: 'MAIL@example.test' }, [record, other]), { status: 409 });
});

test('one batch recognizes mixed ----, Tab, pipe and CSV without trimming passwords', () => {
  const result = importMailboxVaultRecords({ text: '\uFEFF\n' + [
    'a@example.test---- pass,with|symbols" ---- 2fa ',
    'b@example.test\tpass----with|symbols,\ttoken',
    'c@example.test| pass----with,commas |token',
    '"d@example.test"," pass,----|with""quotes ","secret"',
    'e@example.test--------',
  ].join('\r\n') }, [], firstTime);
  assert.equal(result.added.length, 5);
  assert.deepEqual(result.added.map((record) => record.account), ['a@example.test', 'b@example.test', 'c@example.test', 'd@example.test', 'e@example.test']);
  assert.equal(result.added[0].password, ' pass,with|symbols" ');
  assert.equal(result.added[0].totp, ' 2fa ');
  assert.equal(result.added[1].password, 'pass----with|symbols,');
  assert.equal(result.added[2].password, ' pass----with,commas ');
  assert.equal(result.added[3].password, ' pass,----|with"quotes ');
  assert.equal(result.added[4].password, '');
  assert.equal(result.added[4].totp, '');
});

test('CSV headers and quoted multiline values import with correct source line numbers', () => {
  const parsed = parseMailboxVaultText('email,password,2fa\r\n"a@example.test","first\r\nsecond","2fa"\r\n\r\nb@example.test,p,t\r\n');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].line, 2);
  assert.equal(parsed[0].value.password, 'first\r\nsecond');
  assert.equal(parsed[1].line, 5);
  assert.equal(importMailboxVaultRecords({ text: '账号\t密码\t2FA\na@example.test\tp\tt' }, []).added.length, 1);
});

test('format detection checks complete columns when an email domain contains another separator', () => {
  const imported = importMailboxVaultRecords({ text: [
    'fixture@example.test----mail.test,p,t',
    'tab@example.test----mail.test\t pass,with|symbols \t2fa',
    'pipe@example.test----mail.test| pass,with-symbols |2fa',
    'normal@example.test---- pass,with|symbols ----2fa',
  ].join('\n') }, []).added;
  assert.equal(imported.length, 4);
  assert.equal(imported[0].account, 'fixture@example.test----mail.test');
  assert.equal(imported[0].password, 'p');
  assert.equal(imported[0].totp, 't');
  assert.equal(imported[1].account, 'tab@example.test----mail.test');
  assert.equal(imported[1].password, ' pass,with|symbols ');
  assert.equal(imported[2].account, 'pipe@example.test----mail.test');
  assert.equal(imported[2].password, ' pass,with-symbols ');
  assert.equal(imported[3].password, ' pass,with|symbols ');
  const restored = importMailboxVaultRecords({ text: exportMailboxVaultText(imported) }, []).added;
  assert.deepEqual(restored.map(({ account, password, totp }) => ({ account, password, totp })),
    imported.map(({ account, password, totp }) => ({ account, password, totp })));
});

test('ambiguous separator combinations reject without guessing and export uses quoted CSV', () => {
  const input = 'ambiguous@example.test----mail.test| private----password |2fa';
  assert.throws(() => importMailboxVaultRecords({ text: input }, []), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.errors[0].message, /多种分隔/);
    assert.doesNotMatch(JSON.stringify(error), /ambiguous@example|private|password/);
    return true;
  });
  const records = [createMailboxVaultRecord({ account: 'ambiguous@example.test', password: 'two,commas,here', totp: '2fa' }, [])];
  const exported = exportMailboxVaultText(records);
  assert.match(exported, /^"ambiguous@example.test",/);
  const restored = importMailboxVaultRecords({ text: exported }, []).added[0];
  assert.equal(restored.password, records[0].password);
  assert.equal(importMailboxVaultRecords({ text: '"ambiguous@example.test----mail.test"," private----password ","2fa"' }, []).added[0].password, ' private----password ');
});

test('TXT export round-trips delimiters, quotes, whitespace, trailing hyphens and newlines', () => {
  const records = [
    createMailboxVaultRecord({ account: 'simple@example.test', password: ' p,|" ', totp: 'TOTP' }, []),
    createMailboxVaultRecord(sample, []),
    createMailboxVaultRecord({ account: 'hyphen@example.test', password: '-start-', totp: '-end-' }, []),
  ];
  const text = exportMailboxVaultText(records);
  assert.match(text, /^simple@example.test----/);
  assert.match(text, /"Mail@Example.test",/);
  const imported = importMailboxVaultRecords({ text }, []).added;
  assert.equal(imported.length, records.length);
  for (let index = 0; index < records.length; index += 1) {
    for (const field of ['account', 'password', 'totp']) assert.equal(imported[index][field], records[index][field]);
  }
  assert.throws(() => exportMailboxVaultText([]));
  assert.throws(() => exportMailboxVaultText([{ account: 'bad', password: 'sensitive-password' }]), (error) => !error.message.includes('sensitive-password'));
});

test('JSON export restores credentials and duplicated emails skip without overwriting', () => {
  const existing = createMailboxVaultRecord(sample, [], firstTime);
  const exported = exportMailboxVaultRecords([existing], [existing.id], secondTime);
  const restored = importMailboxVaultRecords({ text: JSON.stringify(exported) }, [], secondTime).added[0];
  for (const key of ['account', 'password', 'totp']) assert.equal(restored[key], existing[key]);
  assert.notEqual(restored.id, existing.id);
  assert.equal(restored.createdAt, secondTime);
  const before = structuredClone(existing);
  const result = importMailboxVaultRecords({ records: [
    { account: 'MAIL@example.test', password: 'overwrite' },
    { account: 'new@example.test', password: 'first' },
    { account: 'NEW@example.test', password: 'second' },
  ] }, [existing]);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].password, 'first');
  assert.equal(result.skipped, 2);
  assert.deepEqual(existing, before);
});

test('malformed input rejects the entire batch and reports positions without credentials', () => {
  const existing = [createMailboxVaultRecord(sample, [])];
  const before = structuredClone(existing);
  for (const input of [
    { text: 'ok@example.test----secret----2fa\ninvalid-secret-line' },
    { text: 'ok@example.test----secret----2fa\n\nbad@example.test|private|value|extra' },
    { text: 'ok@example.test----secret----2fa\n"bad@example.test","private-unclosed,2fa' },
    { records: [{ account: 'ok@example.test' }, { account: '', password: 'private-field-value' }] },
  ]) {
    assert.throws(() => importMailboxVaultRecords(input, existing), (error) => {
      assert.equal(error.status, 400);
      assert.ok(error.errors[0].line >= 1);
      assert.doesNotMatch(JSON.stringify(error), /invalid-secret-line|private|secret/);
      return true;
    });
  }
  assert.deepEqual(existing, before);
});

test('invalid shapes, field types, unsupported versions and oversized batches reject', () => {
  for (const input of [null, [], { text: '' }, { records: [] }, { text: '{invalid' },
    { text: '{"format":"auto-team-mailbox-vault","version":2,"records":[]}' },
    { text: 'x', records: [] }, { records: [null] }, { records: [{ account: 'no-email' }] },
    { records: [{ account: 'ok@example.test', password: 123 }] },
    { records: [{ account: 'ok@example.test', totp: 'x'.repeat(4097) }] },
    { records: Array.from({ length: 2001 }, () => ({ account: 'ok@example.test' })) },
  ]) assert.throws(() => importMailboxVaultRecords(input, []), { status: 400 });
});

test('export/delete selections are explicit, ordered and reject stale or repeated IDs atomically', () => {
  const a = createMailboxVaultRecord({ account: 'a@example.test' }, []);
  const b = createMailboxVaultRecord({ account: 'b@example.test' }, []);
  assert.deepEqual(selectMailboxVaultRecords([a, b], [b.id]), [b]);
  assert.deepEqual(exportMailboxVaultRecords([a, b], [b.id, a.id]).records.map((record) => record.id), [b.id, a.id]);
  for (const ids of [undefined, [], [a.id, a.id], [1], [''], 'all']) assert.throws(() => selectMailboxVaultRecords([a, b], ids), { status: 400 });
  assert.throws(() => selectMailboxVaultRecords([a, b], [a.id, 'missing']), { status: 409 });
});

test('marking exported mailboxes validates every identity without changing unselected or stale records', () => {
  const a = createMailboxVaultRecord({ account: 'a@example.test' }, [], firstTime);
  const b = createMailboxVaultRecord({ account: 'b@example.test' }, [], firstTime);
  const records = [a, b];
  const before = structuredClone(records);
  const selection = [{ id: b.id, account: ' B@EXAMPLE.TEST ' }];
  const marked = markMailboxVaultRecordsExported(records, selection, secondTime);
  assert.deepEqual(marked, [{ ...b, exportedAt: secondTime, updatedAt: secondTime }]);
  assert.deepEqual(records, before);
  for (const invalid of [undefined, null, [], {}, [null], [[b.id]], [{ id: b.id }],
    [{ id: b.id, account: 123 }], [{ id: b.id, account: 'invalid' }],
    [{ account: b.account }], [{ id: 123, account: b.account }],
    [{ id: b.id, account: b.account }, { id: b.id, account: b.account }]]) {
    assert.throws(() => markMailboxVaultRecordsExported(records, invalid), { status: 400 });
  }
  for (const stale of [
    [{ id: a.id, account: a.account }, { id: b.id, account: 'changed@example.test' }],
    [{ id: a.id, account: a.account }, { id: 'deleted', account: b.account }],
  ]) assert.throws(() => markMailboxVaultRecordsExported(records, stale), { status: 409 });
  assert.deepEqual(records, before);
});

test('export markers survive credential edits, clear for new addresses, and never import from caller metadata', () => {
  const record = createMailboxVaultRecord(sample, [], firstTime);
  const marked = markMailboxVaultRecordsExported([record], [{ id: record.id, account: record.account }], secondTime)[0];
  const updated = updateMailboxVaultRecord(marked, { account: 'mail@example.test', password: 'new', totp: 'new2fa', exportedAt: null }, [marked]);
  assert.equal(updated.exportedAt, secondTime);
  assert.equal(updateMailboxVaultRecord(updated, { account: 'new@example.test', exportedAt: secondTime }, [updated]).exportedAt, null);
  const legacy = { ...record };
  delete legacy.exportedAt;
  assert.equal(publicMailboxVaultRecord(legacy).exportedAt, null);
  assert.equal(fullMailboxVaultRecord(legacy).exportedAt, null);
  assert.equal(updateMailboxVaultRecord(legacy, { password: 'edited' }, [legacy]).exportedAt, null);
  const exported = exportMailboxVaultRecords([marked], [marked.id]);
  assert.equal(exported.records[0].exportedAt, secondTime);
  assert.equal(marked.exportedAt, secondTime);
  const restored = importMailboxVaultRecords({ text: JSON.stringify(exported) }, []).added[0];
  assert.equal(restored.exportedAt, null);
  assert.equal(importMailboxVaultRecords({ records: [marked] }, []).added[0].exportedAt, null);
  const txtRestored = importMailboxVaultRecords({ text: exportMailboxVaultText(exported.records) }, []).added[0];
  for (const key of ['account', 'password', 'totp']) assert.equal(txtRestored[key], marked[key]);
  assert.equal(txtRestored.exportedAt, null);
});
