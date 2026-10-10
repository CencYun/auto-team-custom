import { randomUUID } from 'node:crypto';
import { MailboxVaultTextError, isMailboxAccount, parseMailboxVaultText } from '../shared/mailbox-vault-text.mjs';

export const MAILBOX_VAULT_FORMAT = 'auto-team-mailbox-vault';
const fields = ['account', 'password', 'totp'];
const limits = { account: 320, password: 4096, totp: 4096 };
const labels = { account: '邮箱', password: '密码', totp: '2FA' };
const accountKey = (value) => value.trim().toLowerCase();

export class MailboxVaultError extends Error {
  constructor(status, code, message, errors) {
    super(message);
    this.status = status;
    this.code = code;
    if (errors) this.errors = errors;
  }
}

function invalid(message) { throw new MailboxVaultError(400, 'mailbox_vault_invalid_record', message); }

function recordFields(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('邮箱记录必须是对象');
  const result = {};
  for (const field of fields) {
    const value = Object.hasOwn(input, field) ? input[field] : previous?.[field] ?? '';
    if (typeof value !== 'string') invalid(`${labels[field]}必须是文本`);
    if (value.length > limits[field]) invalid(`${labels[field]}过长`);
    result[field] = field === 'account' ? value.trim() : value;
  }
  if (!isMailboxAccount(result.account) || result.account.includes('\u0000')) invalid('请填写有效邮箱');
  return result;
}

export function publicMailboxVaultRecord(record) {
  return { id: record.id, account: record.account, hasPassword: Boolean(record.password), hasTotp: Boolean(record.totp),
    createdAt: record.createdAt, updatedAt: record.updatedAt };
}

export function fullMailboxVaultRecord(record) {
  return { id: record.id, ...Object.fromEntries(fields.map((field) => [field, record[field]])),
    createdAt: record.createdAt, updatedAt: record.updatedAt };
}

export function createMailboxVaultRecord(input, records, timestamp = new Date().toISOString()) {
  const values = recordFields(input);
  if (records.some((record) => accountKey(record.account) === accountKey(values.account))) {
    throw new MailboxVaultError(409, 'mailbox_vault_duplicate', '此邮箱已保存，请编辑已有记录');
  }
  return { id: `mailbox_vault_${randomUUID()}`, ...values, createdAt: timestamp, updatedAt: timestamp };
}

export function updateMailboxVaultRecord(previous, input, records, timestamp = new Date().toISOString()) {
  const values = recordFields(input, previous);
  if (records.some((record) => record.id !== previous.id && accountKey(record.account) === accountKey(values.account))) {
    throw new MailboxVaultError(409, 'mailbox_vault_duplicate', '此邮箱已保存，请编辑已有记录');
  }
  return { ...fullMailboxVaultRecord(previous), ...values, updatedAt: timestamp };
}

function importRows(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('请提供待导入的邮箱');
  if (Object.hasOwn(input, 'records') && Object.hasOwn(input, 'text')) invalid('请选择一种导入格式');
  let records = input.records;
  if (Object.hasOwn(input, 'text')) {
    if (typeof input.text !== 'string' || !input.text.trim()) invalid('请填写待导入的邮箱');
    const text = input.text.replace(/^\uFEFF/, '');
    if (/^\s*[\[{]/.test(text)) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { invalid('JSON 格式无效，请检查导入文件'); }
      if (Array.isArray(parsed)) records = parsed;
      else if (parsed?.format === MAILBOX_VAULT_FORMAT && parsed.version === 1) records = parsed.records;
      else invalid('不支持此 JSON 格式，请导入邮箱管理导出的文件或邮箱数组');
    } else {
      try { return parseMailboxVaultText(text); }
      catch (error) {
        if (!(error instanceof MailboxVaultTextError)) throw error;
        throw new MailboxVaultError(400, 'mailbox_vault_invalid_import', error.message, error.errors);
      }
    }
  }
  if (!Array.isArray(records)) invalid('请提供邮箱数组或导入文本');
  return records.map((value, index) => ({ line: index + 1, value }));
}

export function importMailboxVaultRecords(input, existing, timestamp = new Date().toISOString()) {
  const rows = importRows(input);
  if (!rows.length || rows.length > 2000) invalid('每次请导入 1 至 2000 条邮箱');
  const values = [];
  const errors = [];
  for (const row of rows) {
    try { values.push(recordFields(row.value)); }
    catch (error) {
      if (!(error instanceof MailboxVaultError)) throw error;
      errors.push({ line: row.line, message: error.message });
    }
  }
  if (errors.length) throw new MailboxVaultError(400, 'mailbox_vault_invalid_import', '导入数据有误，未保存任何邮箱', errors);
  const seen = new Set(existing.map((record) => accountKey(record.account)));
  const added = [];
  let skipped = 0;
  for (const value of values) {
    const key = accountKey(value.account);
    if (seen.has(key)) { skipped += 1; continue; }
    seen.add(key);
    added.push({ id: `mailbox_vault_${randomUUID()}`, ...value, createdAt: timestamp, updatedAt: timestamp });
  }
  return { added, skipped };
}

export function selectMailboxVaultRecords(records, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new MailboxVaultError(400, 'mailbox_vault_selection_required', '请勾选邮箱，且不要重复选择');
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  if (ids.some((id) => !byId.has(id))) throw new MailboxVaultError(409, 'mailbox_vault_selection_stale', '部分邮箱已删除，请刷新列表后重新选择');
  return ids.map((id) => byId.get(id));
}

export function exportMailboxVaultRecords(records, ids, timestamp = new Date().toISOString()) {
  return { format: MAILBOX_VAULT_FORMAT, version: 1, exportedAt: timestamp,
    records: selectMailboxVaultRecords(records, ids).map(fullMailboxVaultRecord) };
}
