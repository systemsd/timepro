'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import { useRealtimePresence } from '@/lib/useRealtimePresence';
import {
  getRoster,
  getRosterActivity,
  getScreenshots,
  getScreenshotObjectUrl,
  getToday,
  type Presence,
  type Roster,
  type RosterRow,
  type ScreenshotMeta,
  type TodaySummary,
} from '@/lib/api';

const isManagerOrAdmin = (r: string) => ['owner', 'admin', 'manager'].includes(r);

export default function DashboardPage() {
  const { session, checked } = useSession();
  if (!checked || !session) return <div className="center muted">Loading…</div>;
  return isManagerOrAdmin(session.role) ? (
    <ManagerHome />
  ) : (
    <EmployeeHome />
  );
}

/* ─────────── Manager / Admin: team roster (S2) ─────────── */

function ManagerHome() {
  const { session } = useSession();
  const router = useRouter();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(todayLocal()); // selected day
  const [viewMonth, setViewMonth] = useState(monthOf(todayLocal())); // strip month (YYYY-MM)
  const [activeDays, setActiveDays] = useState<Set<string>>(new Set());
  const live = useRealtimePresence(); // realtime dots (B10 / 5E)

  useEffect(() => {
    const fetchRoster = () =>
      getRoster({ period: 'day', date }).then(setRoster).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void fetchRoster();
    // presence arrives over the websocket; the poll only refreshes time totals
    const id = setInterval(fetchRoster, 60_000);
    return () => clearInterval(id);
  }, [date]);

  useEffect(() => {
    getRosterActivity(viewMonth)
      .then((r) => setActiveDays(new Set(r.days.filter((d) => d.seconds > 0).map((d) => d.date))))
      .catch(() => setActiveDays(new Set()));
  }, [viewMonth]);

  if (!session) return null;
  const tzLabel = `UTC${offsetLabel()}`;
  const presenceOf = (r: RosterRow): Presence => live[r.user_id] ?? r.presence;
  const online = roster
    ? roster.rows.reduce((n, r) => (presenceOf(r) !== 'offline' ? n + 1 : n), 0)
    : 0;
  const worked = (roster?.totals.period_seconds ?? 0) > 0;
  const headline =
    online > 0 ? `${online} online` : worked ? 'Team activity' : 'No one online, no time tracked';

  const today = todayLocal();
  const goToday = () => {
    setDate(today);
    setViewMonth(monthOf(today));
  };

  return (
    <div className="page">
      <TopNav session={session} active="home" />
      <div className="mh-band">
        <h1>Manager Dashboard</h1>
        <span className="tz">All times are {tzLabel}</span>
      </div>

      <div className="cal">
        <div className="cal-head">
          <button className="cal-nav" onClick={() => setViewMonth(shiftMonth(viewMonth, -1))} aria-label="Previous month">‹</button>
          <span className="cal-month">{monthYearLabel(viewMonth)}</span>
          <button className="cal-nav" onClick={() => setViewMonth(shiftMonth(viewMonth, 1))} aria-label="Next month">›</button>
          <button className="cal-today" onClick={goToday}>Today</button>
        </div>
        <div className="cal-strip">
          {monthDays(viewMonth).map((c) => {
            const future = c.date > today;
            return (
              <button
                key={c.date}
                className={`cal-day${c.date === date ? ' selected' : ''}${c.date === today ? ' today' : ''}${c.weekend ? ' weekend' : ''}${future ? ' future' : ''}`}
                onClick={() => !future && setDate(c.date)}
                disabled={future}
              >
                <span className="cal-dow">{c.dow}</span>
                <span className="cal-num">{c.day}</span>
                <span className={`cal-dot${activeDays.has(c.date) ? ' on' : ''}`} />
              </button>
            );
          })}
        </div>
      </div>

      {error && <div className="error" style={{ margin: '16px 28px' }}>{error}</div>}

      <div className="roster">
        <table>
          <thead>
            <tr>
              <th className="l">Employee</th>
              <th className="l">Last active</th>
              <th>Tracked</th>
            </tr>
          </thead>
          <tbody>
            <tr className="summary">
              <td className="l" colSpan={2}>{headline}</td>
              <td className="val">{fmt(roster?.totals.period_seconds)}</td>
            </tr>
            {(roster?.rows ?? []).map((r) => (
              <RosterRowView key={r.user_id} row={r} presence={presenceOf(r)} onOpen={() => router.push(`/timeline/${r.user_id}`)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RosterRowView({ row, presence, onOpen }: { row: RosterRow; presence: Presence; onOpen: () => void }) {
  return (
    <tr>
      <td className="l">
        <div className="emp">
          <span className={`presence-dot ${presence}`} title={presenceLabel(presence)} />
          <div>
            <button className="emp-name" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'block' }} onClick={onOpen}>
              {row.display_name}
              {row.over_limit && (
                <span className="emp-overlimit" title={`Over weekly limit (${row.weekly_limit_hours}h)`}>over limit</span>
              )}
            </button>
            {row.last_app && <div className="emp-app">{row.last_app}</div>}
          </div>
        </div>
      </td>
      <td className="l thumb-cell">
        {row.last_screenshot_id ? (
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }} onClick={onOpen}>
            <RosterThumb id={row.last_screenshot_id} at={row.last_active} />
          </button>
        ) : (
          <span className="muted-2">…</span>
        )}
      </td>
      <td className={row.period_seconds ? 'val' : 'dash'}>{fmt(row.period_seconds)}</td>
    </tr>
  );
}

function RosterThumb({ id, at }: { id: string; at: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    getScreenshotObjectUrl(id).then((u) => { revoked = u; setUrl(u); }).catch(() => {});
    return () => { if (revoked) URL.revokeObjectURL(revoked); };
  }, [id]);
  return (
    <figure style={{ margin: 0, position: 'relative' }}>
      {url ? <img src={url} alt="" /> : <div className="thumb-ph" />}
      {at && <figcaption style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{relative(at)}</figcaption>}
    </figure>
  );
}

/* ─────────── Employee: personal dashboard ─────────── */

function EmployeeHome() {
  const { session } = useSession();
  const [today, setToday] = useState<TodaySummary | null>(null);
  const [shots, setShots] = useState<ScreenshotMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [t, sc] = await Promise.all([getToday(), getScreenshots(24)]);
        setToday(t);
        setShots(sc.screenshots);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  if (!session) return null;
  return (
    <div className="page">
      <TopNav session={session} active="home" />
      <main className="content">
        <h1 className="title">My Home</h1>
        {error && <div className="error">{error}</div>}
        {today?.over_limit && (
          <div className="limit-banner">
            ⚠ You&apos;ve passed your weekly time limit of {today.weekly_limit_hours}h
            ({hm(today.week_seconds)} tracked). New timers are blocked until next week.
          </div>
        )}
        <div className="stats">
          <Stat label="Tracked today" value={hm(today?.tracked_seconds ?? 0)} />
          <Stat
            label="This week"
            value={
              hm(today?.week_seconds ?? 0) +
              ((today?.weekly_limit_hours ?? 0) > 0 ? ` / ${today!.weekly_limit_hours}h` : '')
            }
            tone={today?.over_limit ? 'red' : undefined}
          />
          <Stat label="Status" value={today?.is_running ? 'Tracking' : 'Stopped'} tone={today?.is_running ? 'green' : 'muted'} />
          <Stat label="Screenshots today" value={String(today?.screenshot_count ?? 0)} />
        </div>
        <section className="block">
          <h2 className="block-title">Recent screenshots</h2>
          {shots.length === 0 ? (
            <p className="muted">No screenshots yet. Start the timer in the desktop app.</p>
          ) : (
            <div className="grid">{shots.map((s) => <PersonalThumb key={s.id} shot={s} />)}</div>
          )}
        </section>
      </main>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'muted' | 'red' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

function PersonalThumb({ shot }: { shot: ScreenshotMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    getScreenshotObjectUrl(shot.id).then((u) => { revoked = u; setUrl(u); }).catch(() => {});
    return () => { if (revoked) URL.revokeObjectURL(revoked); };
  }, [shot.id]);
  return (
    <figure className="thumb">
      {url ? <img src={url} alt="" /> : <div className="thumb-ph" />}
      <figcaption>{new Date(shot.captured_at).toLocaleTimeString()}</figcaption>
    </figure>
  );
}

/* ─────────── helpers ─────────── */

function fmt(seconds?: number): string {
  if (!seconds) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, '0')}m`;
}
function hm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, '0')}m`;
}
function relative(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const days = Math.floor(diff / 86_400_000);
  if (days >= 1) return `${days} day${days > 1 ? 's' : ''} ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.floor(diff / 60_000);
  return mins >= 1 ? `${mins}m ago` : 'just now';
}
function offsetLabel(): string {
  const off = -new Date().getTimezoneOffset() / 60;
  return off >= 0 ? `+${off}` : `${off}`;
}
function presenceLabel(p: string): string {
  return p === 'tracking' ? 'Tracking' : p === 'connected' ? 'Online (app open)' : 'Offline';
}

// ---- calendar-strip helpers (viewer-local) ----
const pad = (n: number) => String(n).padStart(2, '0');
const DOW = 'SMTWTFS'; // index 0=Sun … 6=Sat

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** `YYYY-MM-DD` → `YYYY-MM`. */
function monthOf(date: string): string {
  return date.slice(0, 7);
}
/** Shift a `YYYY-MM` by n months. */
function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const dt = new Date(y, m - 1 + n, 1);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
}
function monthYearLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
/** Day cells for a `YYYY-MM`. */
function monthDays(ym: string): Array<{ date: string; day: number; dow: string; weekend: boolean }> {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const count = new Date(y, m, 0).getDate();
  const cells = [];
  for (let d = 1; d <= count; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    cells.push({ date: `${y}-${pad(m)}-${pad(d)}`, day: d, dow: DOW[dow]!, weekend: dow === 0 || dow === 6 });
  }
  return cells;
}
