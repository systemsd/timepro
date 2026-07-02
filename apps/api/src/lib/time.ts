/**
 * Shared date / timezone / day-boundary math.
 *
 * One home for the primitives that were previously copy-pasted across routes
 * (`overlapSeconds` alone was defined 4×) and re-implemented inline in
 * timeline/roster. All calendar math is viewer-local: `tzOffsetMinutes` is the
 * browser `getTimezoneOffset()` value (minutes to ADD to local to reach UTC).
 *
 * NOTE: a single offset is applied across a whole range, so a range that spans a
 * DST transition is off by an hour on the far side — fine for the current no-DST
 * deployment; a known limitation to revisit if a DST org is onboarded.
 */

export const DAY_MS = 86_400_000;

/** Parse `YYYY-MM-DD` into numeric [year, month(1-12), day]. */
export function ymd(date: string): [number, number, number] {
  const parts = date.split('-');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** Local `YYYY-MM-DD` (00:00 wall-clock) → real UTC ms. */
export function localDateToUtcMs(date: string, tzOffsetMinutes: number): number {
  const [y, m, d] = ymd(date);
  return Date.UTC(y, m - 1, d) + tzOffsetMinutes * 60_000;
}

/** UTC ms → local `YYYY-MM-DD`. */
export function utcMsToLocalDate(ms: number, tzOffsetMinutes: number): string {
  const shifted = new Date(ms - tzOffsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isWeekendLocal(date: string): boolean {
  const [y, m, d] = ymd(date);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun, 6=Sat
  return dow === 0 || dow === 6;
}

/** Inclusive list of local dates from..to. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = ymd(from);
  const end = localDateToUtcMs(to, 0);
  for (let t = Date.UTC(fy, fm - 1, fd); t <= end; t += DAY_MS) {
    out.push(utcMsToLocalDate(t, 0));
  }
  return out;
}

/** Seconds of [start,end) that fall inside [winStart,winEnd), floored to whole seconds. */
export function overlapSeconds(start: number, end: number, winStart: number, winEnd: number): number {
  const s = Math.max(start, winStart);
  const e = Math.min(end, winEnd);
  return e > s ? Math.floor((e - s) / 1000) : 0;
}

/** Monday of the week containing `date` (viewer-local YYYY-MM-DD; pure calendar). */
export function weekStartLocal(date: string): string {
  const [y, m, d] = ymd(date);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = Monday
  return utcMsToLocalDate(Date.UTC(y, m - 1, d) - dow * DAY_MS, 0);
}

export function addCalendarDays(date: string, n: number): string {
  const [y, m, d] = ymd(date);
  return utcMsToLocalDate(Date.UTC(y, m - 1, d) + n * DAY_MS, 0);
}

/** Mon..Sun index (0..6) of `date` within its own week. */
export function dayIndexInWeek(date: string): number {
  const [y, m, d] = ymd(date);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * Split [startMs, endMs) across viewer-local day boundaries. Returns one
 * `{ date, seconds }` slice per day the interval touches (callers accumulate).
 * Replaces the hand-rolled day-splitting loop duplicated in reports/timeline.
 */
export function bucketSecondsByDay(
  startMs: number,
  endMs: number,
  tzOffsetMinutes: number,
): Array<{ date: string; seconds: number }> {
  const out: Array<{ date: string; seconds: number }> = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const date = utcMsToLocalDate(cursor, tzOffsetMinutes);
    const dayEnd = localDateToUtcMs(date, tzOffsetMinutes) + DAY_MS;
    out.push({ date, seconds: overlapSeconds(cursor, endMs, cursor, dayEnd) });
    cursor = dayEnd;
  }
  return out;
}
