import { pad } from './format';

/** Viewer-local date helpers shared across pages (were copy-pasted per-file). */

/** Date → local "YYYY-MM-DD". */
export function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today as local "YYYY-MM-DD". */
export function todayLocal(): string {
  return fmt(new Date());
}

/** Shift a "YYYY-MM-DD" by n days (viewer-local). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return fmt(new Date(y, m - 1, d + n));
}

/** Monday of the week containing `date` (viewer-local). */
export function weekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7; // 0 = Monday
  return addDays(date, -dow);
}

export type Preset =
  | 'today' | 'yesterday' | 'this_week' | 'last_week'
  | 'this_month' | 'last_month' | 'this_year' | 'last_year';

export function presetRange(p: Preset): { from: string; to: string } {
  const now = new Date();
  const t = todayLocal();
  switch (p) {
    case 'today': return { from: t, to: t };
    case 'yesterday': return { from: addDays(t, -1), to: addDays(t, -1) };
    case 'this_week': { const ws = weekStart(t); return { from: ws, to: addDays(ws, 6) }; }
    case 'last_week': { const ws = addDays(weekStart(t), -7); return { from: ws, to: addDays(ws, 6) }; }
    case 'this_month': {
      const from = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
      const to = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0));
      return { from, to };
    }
    case 'last_month': {
      const from = fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      const to = fmt(new Date(now.getFullYear(), now.getMonth(), 0));
      return { from, to };
    }
    case 'this_year': return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
    case 'last_year': return { from: `${now.getFullYear() - 1}-01-01`, to: `${now.getFullYear() - 1}-12-31` };
  }
}

/**
 * A viewer-local "YYYY-MM-DD" + "HH:MM" → absolute ISO (viewer tz). Tolerates a
 * blank `<input type="date|time">` (parts become NaN) by falling back to a safe
 * default, so clearing a field renders a duration instead of throwing.
 */
export function localDateTimeIso(date: string, hm: string): string {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return new Date((y || 1970), (mo || 1) - 1, (d || 1), (h || 0), (mi || 0), 0, 0).toISOString();
}

/**
 * Resolve a manual-entry "date + start HH:MM + end HH:MM" into absolute ISO
 * timestamps (viewer tz). An end wall-clock STRICTLY earlier than the start is
 * read as an overnight shift and rolled to the next calendar day — so e.g.
 * 19:00→01:00 is a ~6h entry, not a rejected "start after end".
 *
 * Equal start/end does NOT roll: it stays a zero-length same-day range and is
 * reported `invalid`, so a mistyped equal time can never silently become a 24h
 * entry. The day is rolled on the local calendar (`addDays`), not by adding
 * 86400s, so the real duration stays correct across a DST transition night.
 */
export function manualTimeRange(
  date: string,
  start: string,
  end: string,
): { startIso: string; endIso: string; crossesMidnight: boolean; invalid: boolean; durSecs: number } {
  const startIso = localDateTimeIso(date, start);
  const sameDayEndIso = localDateTimeIso(date, end);
  const crossesMidnight = Date.parse(sameDayEndIso) < Date.parse(startIso);
  const endIso = crossesMidnight ? localDateTimeIso(addDays(date, 1), end) : sameDayEndIso;
  const durSecs = (Date.parse(endIso) - Date.parse(startIso)) / 1000;
  const invalid = Date.parse(endIso) <= Date.parse(startIso);
  return { startIso, endIso, crossesMidnight, invalid, durSecs };
}

/** Viewer timezone as a "UTC±HH:MM" label (unifies 4 drifting per-page variants). */
export function tzLabel(): string {
  const offMin = -new Date().getTimezoneOffset(); // minutes east of UTC
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
