import { randomUUID } from 'node:crypto';

export const MOTHER_VAULT_FORMAT = 'auto-team-mother-vault';
const fields = ['account', 'password', 'totp', 'note', 'remarkTime'];
const limits = { account: 320, password: 4096, totp: 4096, note: 10000, remarkTime: 200 };
const labels = { account: '账号', password: '密码', totp: '2FA', note: '备注', remarkTime: '备注时间' };
const accountKey = (value) => value.trim().toLowerCase();

export class MotherVaultError extends Error {
  constructor(status, code, message, errors) {
    super(message);
    this.status = status;
    this.code = code;
    if (errors) this.errors = errors;
  }
}

function invalid(message) {
  throw new MotherVaultError(400, 'mother_vault_invalid_record', message);
}

function recordFields(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('账号记录必须是对象');
  const result = {};
  for (const field of fields) {
    const value = Object.hasOwn(input, field) ? input[field] : previous?.[field] ?? '';
    if (typeof value !== 'string') invalid(`${labels[field]}必须是文本`);
    if (value.length > limits[field]) invalid(`${labels[field]}过长`);
    // Passwords and 2FA secrets are stored verbatim; only the account key is trimmed.
    result[field] = field === 'account' ? value.trim() : value;
  }
  if (!result.account || /[\r\n\u0000]/.test(result.account)) invalid('请填写有效账号');
  return result;
}

export function publicMotherVaultRecord(record) {
  return {
    id: record.id, account: record.account,
    hasPassword: Boolean(record.password), hasTotp: Boolean(record.totp),
    note: record.note, remarkTime: record.remarkTime,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

export function fullMotherVaultRecord(record) {
  return { id: record.id, ...Object.fromEntries(fields.map((field) => [field, record[field]])),
    createdAt: record.createdAt, updatedAt: record.updatedAt };
}

export function createMotherVaultRecord(input, records, timestamp = new Date().toISOString()) {
  const values = recordFields(input);
  if (records.some((record) => accountKey(record.account) === accountKey(values.account))) {
    throw new MotherVaultError(409, 'mother_vault_duplicate', '此账号已保存，请编辑已有记录');
  }
  return { id: `vault_${randomUUID()}`, ...values, createdAt: timestamp, updatedAt: timestamp };
}

export function updateMotherVaultRecord(previous, input, records, timestamp = new Date().toISOString()) {
  const values = recordFields(input, previous);
  if (records.some((record) => record.id !== previous.id && accountKey(record.account) === accountKey(values.account))) {
    throw new MotherVaultError(409, 'mother_vault_duplicate', '此账号已保存，请编辑已有记录');
  }
  return { ...fullMotherVaultRecord(previous), ...values, updatedAt: timestamp };
}

function importRows(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('请提供待导入的账号');
  if (Object.hasOwn(input, 'records') && Object.hasOwn(input, 'text')) invalid('请选择一种导入格式');
  let records = input.records;
  if (Object.hasOwn(input, 'text')) {
    if (typeof input.text !== 'string' || !input.text.trim()) invalid('请填写待导入的账号');
    const text = input.text.replace(/^\uFEFF/, '');
    if (/^[\s]*[\[{]/.test(text)) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { invalid('JSON 格式无效，请检查导入文件'); }
      if (Array.isArray(parsed)) records = parsed;
      else if (parsed?.format === MOTHER_VAULT_FORMAT && parsed.version === 1) records = parsed.records;
      else invalid('不支持此 JSON 格式，请导入母号管理导出的文件或账号数组');
    } else {
      const rows = [];
      const errors = [];
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        const values = line.split('----');
        if (values.length < 3 || values.length > 5) {
          errors.push({ line: index + 1, message: '格式应为账号----密码----2FA----备注----备注时间（后三项可留空）' });
          continue;
        }
        rows.push({ line: index + 1, value: Object.fromEntries(fields.map((field, i) => [field, values[i] ?? ''])) });
      }
      if (errors.length) throw new MotherVaultError(400, 'mother_vault_invalid_import', '导入格式有误，未保存任何账号', errors);
      return rows;
    }
  }
  if (!Array.isArray(records)) invalid('请提供账号数组或导入文本');
  return records.map((value, index) => ({ line: index + 1, value }));
}

// Validate the entire input before creating any records. Duplicates never overwrite secrets.
export function importMotherVaultRecords(input, existing, timestamp = new Date().toISOString()) {
  const rows = importRows(input);
  if (!rows.length || rows.length > 2000) invalid('每次请导入 1 至 2000 条账号');
  const errors = [];
  const values = [];
  for (const row of rows) {
    try { values.push(recordFields(row.value)); }
    catch (error) {
      if (!(error instanceof MotherVaultError)) throw error;
      errors.push({ line: row.line, message: error.message });
    }
  }
  if (errors.length) throw new MotherVaultError(400, 'mother_vault_invalid_import', '导入数据有误，未保存任何账号', errors);
  const seen = new Set(existing.map((record) => accountKey(record.account)));
  const added = [];
  let skipped = 0;
  for (const value of values) {
    const key = accountKey(value.account);
    if (seen.has(key)) { skipped += 1; continue; }
    seen.add(key);
    added.push({ id: `vault_${randomUUID()}`, ...value, createdAt: timestamp, updatedAt: timestamp });
  }
  return { added, skipped };
}

export function selectMotherVaultRecords(records, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new MotherVaultError(400, 'mother_vault_selection_required', '请勾选账号，且不要重复选择');
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  if (ids.some((id) => !byId.has(id))) {
    throw new MotherVaultError(409, 'mother_vault_selection_stale', '部分账号已删除，请刷新列表后重新选择');
  }
  return ids.map((id) => byId.get(id));
}

export function exportMotherVaultRecords(records, ids, timestamp = new Date().toISOString()) {
  return { format: MOTHER_VAULT_FORMAT, version: 1, exportedAt: timestamp,
    records: selectMotherVaultRecords(records, ids).map(fullMotherVaultRecord) };
}
