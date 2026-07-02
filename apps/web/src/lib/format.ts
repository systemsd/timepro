/** Pure display formatters shared across pages (were copy-pasted per-file). */

/** Zero-pad to two digits. */
export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Seconds → "Hh MMm" / "Mm" / "<1m" / "0m". */
export function hm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0 && m === 0) return seconds > 0 ? '<1m' : '0m';
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m`;
}

/** ISO timestamp → local "1:05 PM". */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "YYYY-MM-DD" → "DD/MM/YY". */
export function dmy(date: string): string {
  const [y, m, d] = date.split('-') as [string, string, string];
  return `${d}/${m}/${y.slice(2)}`;
}

/** "YYYY-MM-DD" → localized short weekday ("Mon"). */
export function weekdayShort(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' });
}

/** Activity score → "74%" (or "—" when there were no samples). */
export function actPct(score: number | null): string {
  return score == null ? '—' : `${score}%`;
}
