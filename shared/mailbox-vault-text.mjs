const fields = [['account', '邮箱'], ['password', '密码'], ['totp', '2FA']];
const delimiters = ['----', '\t', '|', ','];
export const isMailboxAccount = (value) => typeof value === 'string'
  && /^[^\s@\u0000<>,";|]+@[^\s@\u0000<>,";|]+\.[^\s@\u0000<>,";|]+$/.test(value);

export class MailboxVaultTextError extends Error {
  constructor(errors) {
    super('导入格式有误，未保存任何邮箱');
    this.errors = errors;
  }
}

const formatMessage = '每条应为邮箱、密码、2FA 三列，支持 ----、Tab、| 或 CSV 分隔';
const accountHeader = (value) => /^(account|email|邮箱|账号)$/i.test(value.trim());
const isHeader = (values) => values.length === 3 && accountHeader(values[0])
  && /^(password|密码)$/i.test(values[1].trim()) && /^(totp|2fa|2fa密钥)$/i.test(values[2].trim());

function readRow(text, start, firstLine) {
  let malformed;
  const candidates = [];
  for (const delimiter of delimiters) {
    const index = firstLine.indexOf(delimiter);
    if (index < 0) continue;
    let account = firstLine.slice(0, index).trim();
    if (delimiter === ',' && /^"(?:[^"]|"")*"$/.test(account)) account = account.slice(1, -1).replaceAll('""', '"');
    if (!isMailboxAccount(account) && !accountHeader(account)) continue;
    const parsed = readRecord(text, start, delimiter);
    malformed ??= parsed;
    // A separator may be part of an email or password. Prefer a complete
    // three-column record before deciding which input format the row uses.
    if (!parsed.invalid && parsed.values.length === 3
      && (isMailboxAccount(parsed.values[0].trim()) || isHeader(parsed.values))) candidates.push(parsed);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return { invalid: true, end: candidates[0].end,
      message: '此行可匹配多种分隔格式，请使用带引号的 CSV 三列，避免改变邮箱或密码' };
  }
  return malformed;
}

// CSV quotes preserve separators, whitespace, double quotes and embedded
// newlines. Other formats keep every password character verbatim.
function readRecord(text, start, delimiter) {
  const values = [];
  let value = '';
  let inQuotes = false;
  let closedQuote = false;
  let fieldStart = true;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (inQuotes) {
      if (character === '"') {
        if (text[cursor + 1] === '"') { value += '"'; cursor += 1; }
        else { inQuotes = false; closedQuote = true; }
      } else value += character;
      continue;
    }
    if (delimiter === ',' && fieldStart && character === '"') {
      inQuotes = true;
      fieldStart = false;
      continue;
    }
    if (text.startsWith(delimiter, cursor)) {
      values.push(value);
      value = '';
      fieldStart = true;
      closedQuote = false;
      cursor += delimiter.length - 1;
      continue;
    }
    if (character === '\r' || character === '\n') {
      const end = cursor + (character === '\r' && text[cursor + 1] === '\n' ? 2 : 1);
      return { values: [...values, value], end };
    }
    if (closedQuote) return { invalid: true, end: text.length };
    value += character;
    fieldStart = false;
  }
  return { values: [...values, value], end: text.length, invalid: inQuotes };
}

export function parseMailboxVaultText(input) {
  if (typeof input !== 'string' || !input.trim()) throw new MailboxVaultTextError([{ line: 1, message: '请填写待导入的邮箱' }]);
  const text = input.replace(/^\uFEFF/, '');
  const rows = [];
  const errors = [];
  let cursor = 0;
  let line = 1;
  let contentSeen = false;
  while (cursor < text.length) {
    const nextNewline = text.slice(cursor).search(/[\r\n]/);
    const physicalEnd = nextNewline < 0 ? text.length : cursor + nextNewline;
    const firstLine = text.slice(cursor, physicalEnd);
    const newlineWidth = text[physicalEnd] === '\r' && text[physicalEnd + 1] === '\n' ? 2 : 1;
    if (!firstLine.trim()) { cursor = Math.min(text.length, physicalEnd + newlineWidth); line += 1; continue; }
    const parsed = readRow(text, cursor, firstLine);
    if (!parsed) {
      errors.push({ line, message: formatMessage });
      cursor = Math.min(text.length, physicalEnd + newlineWidth);
      line += 1;
      contentSeen = true;
      continue;
    }
    if (parsed.invalid || parsed.values.length !== 3) errors.push({ line, message: parsed.message || formatMessage });
    else if (!contentSeen && isHeader(parsed.values)) { /* Optional CSV/TXT column header. */ }
    else rows.push({ line, value: Object.fromEntries(fields.map(([field], index) => [field, parsed.values[index]])) });
    contentSeen = true;
    line += (text.slice(cursor, parsed.end).match(/\r\n|\r|\n/g) || []).length;
    cursor = parsed.end;
  }
  if (errors.length) throw new MailboxVaultTextError(errors);
  return rows;
}

export function exportMailboxVaultText(records) {
  if (!Array.isArray(records) || !records.length) throw new Error('请先选择需要导出的邮箱。');
  const lines = records.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`第 ${index + 1} 条邮箱记录无效，请刷新列表后重试。`);
    const values = fields.map(([key, label]) => {
      const value = record[key] === undefined ? '' : record[key];
      if (typeof value !== 'string') throw new Error(`第 ${index + 1} 条的${label}必须是文本。`);
      return value;
    });
    if (!isMailboxAccount(values[0]) || values[0] !== values[0].trim()) throw new Error(`第 ${index + 1} 条邮箱无效，请编辑后重试。`);
    const simple = values.join('----');
    const split = simple.split('----');
    if (values.every((value) => !/[\r\n]/.test(value)) && split.length === 3 && split.every((value, field) => value === values[field])) {
      const parsed = readRow(simple, 0, simple);
      if (!parsed.invalid && parsed.values.every((value, field) => value === values[field])) return simple;
    }
    return values.map((value) => `"${value.replaceAll('"', '""')}"`).join(',');
  });
  return `${lines.join('\r\n')}\r\n`;
}
