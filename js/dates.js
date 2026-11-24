// Date helpers.
// All dates are stored as plain "YYYY-MM-DD" strings (no time, no time zone),
// and converted to whole "day numbers" (days since 1970-01-01) for arithmetic.
// This avoids daylight-saving and time-zone bugs.

const MS_PER_DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

/** "2026-11-24" -> day number */
export function toDay(str) {
  const [y, m, d] = str.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** day number -> "2026-11-24" */
export function fromDay(n) {
  const dt = new Date(n * MS_PER_DAY);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Today's date on the phone, as "YYYY-MM-DD" */
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const addDays = (str, n) => fromDay(toDay(str) + n);

/** Number of days from a to b (b - a) */
export const diffDays = (a, b) => toDay(b) - toDay(a);

/** "2026-11-24" -> "20261124" (calendar file format) */
export const compact = (str) => str.replaceAll('-', '');

/** Local midnight of a date, in milliseconds (used by the Android calendar link) */
export function localMidnightMs(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

const utcDate = (str) => new Date(toDay(str) * MS_PER_DAY);

// Dates are written in the page's language (<html lang="en">) so they match the rest of the text
const LOCALE = globalThis.document?.documentElement?.lang || undefined;

/** "25/11/2026" by default; pass opts for other styles (weekday, month name) */
export function fmt(str, opts) {
  if (!opts) {
    const [y, m, d] = str.split('-');
    return `${d}/${m}/${y}`;
  }
  return new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone: 'UTC' }).format(utcDate(str));
}

/** "24/11 – 26/11/2026" (year written once when both dates are in the same year) */
export function fmtRange(a, b) {
  if (a === b) return fmt(a);
  if (a.slice(0, 4) === b.slice(0, 4)) return `${fmt(a).slice(0, 5)} – ${fmt(b)}`;
  return `${fmt(a)} – ${fmt(b)}`;
}

/** "November 2026" */
export const fmtMonth = (ym) => fmt(`${ym}-01`, { month: 'long', year: 'numeric' });

/** Short weekday names starting Monday, in the phone's language */
export function weekdayNames() {
  // 2024-01-01 was a Monday
  return Array.from({ length: 7 }, (_, i) => fmt(fromDay(toDay('2024-01-01') + i), { weekday: 'narrow' }));
}
