function remarkDateKey(value) {
  const text = String(value || '').trim().replace(/[–—－]/g, '-');
  const match = text.match(/(?:^|[^\d])(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:日)?(?=$|[^\d])/);
  if (!match) return Infinity;
  const [, y, m, d] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return Infinity;
  return year * 10000 + month * 100 + day;
}

// Sort a display copy by calendar date, leaving credentials and entered text
// untouched. Equal dates keep their original order; unrecognized dates stay last
// in either direction.
export function sortMotherVaultByRemarkDate(records = [], direction = 'ascending') {
  const multiplier = direction === 'descending' ? -1 : 1;
  return records.map((record, index) => ({ record, index, date: remarkDateKey(record.remarkTime) }))
    .sort((a, b) => {
      if (a.date === b.date) return a.index - b.index;
      if (!Number.isFinite(a.date)) return 1;
      if (!Number.isFinite(b.date)) return -1;
      return (a.date - b.date) * multiplier;
    })
    .map(({ record }) => record);
}
