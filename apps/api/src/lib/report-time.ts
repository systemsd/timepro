/**
 * Report-domain grouping/rollup logic for the Reports engine (`routes/reports.ts`).
 * Pure (no Fastify/DB) so it's unit-testable. Shared date/overlap primitives live
 * in `lib/time.ts`.
 */

import {
  addCalendarDays,
  dayIndexInWeek,
  localDateToUtcMs,
  overlapSeconds,
  utcMsToLocalDate,
  weekStartLocal,
  DAY_MS,
} from './time';

export type ReportType = 'summary' | 'detailed' | 'weekly';
export type GroupDim = 'employee' | 'project' | 'client';

export interface FlatEntry {
  entryId: string;
  userId: string;
  displayName: string;
  projectId: string | null;
  projectName: string | null;
  clientId: string | null;
  clientName: string | null;
  note: string | null;
  startMs: number; // clipped to range
  endMs: number; // clipped to range
  seconds: number; // clipped duration
  isManual: boolean;
  // Activity attributed to this entry (from activity_samples via time_entry_id).
  activeSeconds: number;
  idleSeconds: number;
  scoreSum: number; // Σ activity_score over the entry's minute samples
  sampleCount: number; // number of samples (for the mean)
}

export interface ReportGroupNode {
  dim: GroupDim;
  key: string | null;
  label: string;
  seconds: number;
  activity_score: number | null;
  children?: ReportGroupNode[];
}

export interface ReportPivot {
  key: string | null;
  label: string;
  seconds: number;
  activity_score: number | null;
}

export interface WeekRow {
  key: string | null;
  label: string;
  seconds: number;
  activity_score: number | null;
  days: number[]; // length 7, Mon..Sun seconds
}

export interface WeekBlock {
  week_start: string;
  week_end: string;
  seconds: number;
  activity_score: number | null;
  rows: WeekRow[];
}

// ---- grouping ----

export const DEFAULT_GROUP_BY: Record<ReportType, GroupDim[]> = {
  summary: ['employee', 'project'],
  detailed: [],
  weekly: ['employee'],
};

/** Mean activity score (0-100) or null when there were no samples. */
export function meanScore(scoreSum: number, sampleCount: number): number | null {
  return sampleCount > 0 ? Math.round(scoreSum / sampleCount) : null;
}

function dimValue(e: FlatEntry, dim: GroupDim): { key: string | null; label: string } {
  if (dim === 'employee') return { key: e.userId, label: e.displayName };
  if (dim === 'project') return { key: e.projectId, label: e.projectName ?? 'No project' };
  return { key: e.clientId, label: e.clientName ?? 'No client' };
}

interface MutableNode {
  dim: GroupDim;
  key: string | null;
  label: string;
  seconds: number;
  scoreSum: number;
  sampleCount: number;
  children: Map<string, MutableNode>;
}

export function buildGroups(entries: FlatEntry[], groupBy: GroupDim[]): ReportGroupNode[] {
  const roots = new Map<string, MutableNode>();
  for (const e of entries) {
    let level = roots;
    for (const dim of groupBy) {
      const { key, label } = dimValue(e, dim);
      const mapKey = `${key ?? '∅'}`;
      let node = level.get(mapKey);
      if (!node) {
        node = { dim, key, label, seconds: 0, scoreSum: 0, sampleCount: 0, children: new Map() };
        level.set(mapKey, node);
      }
      node.seconds += e.seconds;
      node.scoreSum += e.scoreSum;
      node.sampleCount += e.sampleCount;
      level = node.children;
    }
  }
  const toArray = (m: Map<string, MutableNode>): ReportGroupNode[] =>
    Array.from(m.values())
      .sort((a, b) => b.seconds - a.seconds)
      .map((n) => ({
        dim: n.dim,
        key: n.key,
        label: n.label,
        seconds: n.seconds,
        activity_score: meanScore(n.scoreSum, n.sampleCount),
        ...(n.children.size > 0 ? { children: toArray(n.children) } : {}),
      }));
  return toArray(roots);
}

export function pivot(entries: FlatEntry[], dim: GroupDim): ReportPivot[] {
  const m = new Map<
    string,
    { key: string | null; label: string; seconds: number; scoreSum: number; sampleCount: number }
  >();
  for (const e of entries) {
    const { key, label } = dimValue(e, dim);
    const mk = `${key ?? '∅'}`;
    const cur = m.get(mk);
    if (cur) {
      cur.seconds += e.seconds;
      cur.scoreSum += e.scoreSum;
      cur.sampleCount += e.sampleCount;
    } else {
      m.set(mk, { key, label, seconds: e.seconds, scoreSum: e.scoreSum, sampleCount: e.sampleCount });
    }
  }
  return Array.from(m.values())
    .sort((a, b) => b.seconds - a.seconds)
    .map((n) => ({
      key: n.key,
      label: n.label,
      seconds: n.seconds,
      activity_score: meanScore(n.scoreSum, n.sampleCount),
    }));
}

// ---- weekly (ISO week, Monday-start) ----

interface WeekUser {
  key: string;
  label: string;
  days: number[]; // length 7, Mon..Sun seconds
  scoreSum: number;
  sampleCount: number;
}

/**
 * Real weekly report: split each entry's seconds across day boundaries into the
 * containing ISO week (so overnight/overlong entries land on the right week+day);
 * activity is attributed once, to the entry's start week. Rows are per employee.
 */
export function buildWeeks(entries: FlatEntry[], tz: number): WeekBlock[] {
  const weeks = new Map<string, Map<string, WeekUser>>();
  const userOf = (weekStart: string, e: FlatEntry): WeekUser => {
    let users = weeks.get(weekStart);
    if (!users) weeks.set(weekStart, (users = new Map()));
    let u = users.get(e.userId);
    if (!u) users.set(e.userId, (u = { key: e.userId, label: e.displayName, days: [0, 0, 0, 0, 0, 0, 0], scoreSum: 0, sampleCount: 0 }));
    return u;
  };

  for (const e of entries) {
    // seconds → split across day boundaries, each day into its own week
    let cursor = e.startMs;
    while (cursor < e.endMs) {
      const day = utcMsToLocalDate(cursor, tz);
      const dayEnd = localDateToUtcMs(day, tz) + DAY_MS;
      const slice = overlapSeconds(cursor, e.endMs, cursor, dayEnd);
      const u = userOf(weekStartLocal(day), e);
      u.days[dayIndexInWeek(day)]! += slice;
      cursor = dayEnd;
    }
    // activity → once, to the entry's start week
    const startWeek = weekStartLocal(utcMsToLocalDate(e.startMs, tz));
    const su = userOf(startWeek, e);
    su.scoreSum += e.scoreSum;
    su.sampleCount += e.sampleCount;
  }

  return Array.from(weeks.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([weekStart, users]) => {
      const rows = Array.from(users.values())
        .map((u) => ({
          key: u.key,
          label: u.label,
          seconds: u.days.reduce((t, s) => t + s, 0),
          activity_score: meanScore(u.scoreSum, u.sampleCount),
          days: u.days,
        }))
        .sort((a, b) => b.seconds - a.seconds);
      const seconds = rows.reduce((t, r) => t + r.seconds, 0);
      const scoreSum = Array.from(users.values()).reduce((t, u) => t + u.scoreSum, 0);
      const sampleCount = Array.from(users.values()).reduce((t, u) => t + u.sampleCount, 0);
      return {
        week_start: weekStart,
        week_end: addCalendarDays(weekStart, 6),
        seconds,
        activity_score: meanScore(scoreSum, sampleCount),
        rows,
      };
    });
}
