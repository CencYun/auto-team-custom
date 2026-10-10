const fields = [
  ['account', '账号'], ['password', '密码'], ['totp', '2FA'],
  ['note', '备注'], ['remarkTime', '备注时间'],
];

function fieldError(index, field, reason) {
  return new Error(`第 ${index + 1} 条的${field}${reason}，请改用 JSON 导出以完整保留内容。`);
}

// TXT intentionally has no escaping syntax: validate against the existing
// line importer instead of silently changing a credential or adding escapes.
export function exportMotherVaultText(records) {
  if (!Array.isArray(records) || !records.length) throw new Error('请先选择需要导出的账号。');
  const lines = records.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`第 ${index + 1} 条账号记录无效，请刷新列表后重试。`);
    }
    const values = fields.map(([key, label]) => {
      const value = record[key] === undefined ? '' : record[key];
      if (typeof value !== 'string') throw fieldError(index, label, '不是文本');
      if (/[\r\n]/.test(value) || value.includes('----')) {
        throw fieldError(index, label, '含有 TXT 无法保留的换行或分隔符');
      }
      return value;
    });
    if (!values[0] || values[0] !== values[0].trim() || values[0].includes('\u0000')) {
      throw fieldError(index, '账号', '无法按 TXT 格式原样导入');
    }
    // The importer treats a leading '[' or '{' as JSON, even for a TXT file.
    if (index === 0 && /^[\[{]/.test(values[0])) {
      throw fieldError(index, '账号', '开头与 JSON 格式冲突');
    }
    const line = values.join('----');
    const parsed = line.split('----');
    const changedField = values.findIndex((value, fieldIndex) => parsed[fieldIndex] !== value);
    if (changedField !== -1 || parsed.length !== values.length) {
      throw fieldError(index, fields[changedField < 0 ? 4 : changedField][1], '的连字符与 TXT 分隔符冲突');
    }
    return line;
  });
  return `${lines.join('\r\n')}\r\n`;
}
