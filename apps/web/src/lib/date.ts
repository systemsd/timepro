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

/** Viewer timezone as a "UTC±HH:MM" label (unifies 4 drifting per-page variants). */
export function tzLabel(): string {
  const offMin = -new Date().getTimezoneOffset(); // minutes east of UTC
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
