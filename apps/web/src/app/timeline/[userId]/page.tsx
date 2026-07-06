'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import { CheckIcon, CloseIcon, PencilIcon, TrashIcon } from '@/components/icons';
import { pad } from '@/lib/format';
import { todayLocal, tzLabel } from '@/lib/date';
import {
  deleteScreenshot,
  getMyEffectiveSettings,
  getTimeline,
  getTimelineActivity,
  getTimelineAppsUrls,
  screenshotUrl,
  type Timeline,
  type TimelineActivity,
  type TimelineAppsUrls,
} from '@/lib/api';
import { EditActivityModal } from '@/components/EditActivityModal';

// ---- calendar-strip helpers (viewer-local) ----
const DOW3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; // index = Date.getDay()
const FULL_DAY_SECONDS = 8 * 3600; // a "full" day bar = 8h tracked
// 24-hour ruler labels: 12am, 1am … 11pm
const HOURS = Array.from({ length: 24 }, (_, i) => `${i % 12 === 0 ? 12 : i % 12}${i < 12 ? 'am' : 'pm'}`);

function monthOf(date: string): string {
  return date.slice(0, 7);
}
function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const dt = new Date(y, m - 1 + n, 1);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
}
function monthYearLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function monthDays(ym: string): Array<{ date: string; day: number; dow: string; weekend: boolean }> {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const count = new Date(y, m, 0).getDate();
  const cells = [];
  for (let d = 1; d <= count; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    cells.push({ date: `${y}-${pad(m)}-${pad(d)}`, day: d, dow: DOW3[dow]!, weekend: dow === 0 || dow === 6 });
  }
  return cells;
}
/** Sum tracked seconds for the Mon–Sun week containing `date`, from the loaded month map. */
function weekSeconds(activity: Record<string, number>, date: string): number {
  const base = new Date(date + 'T00:00:00');
  const mondayOffset = (base.getDay() + 6) % 7; // 0=Mon … 6=Sun
  let total = 0;
  for (let i = -mondayOffset; i <= 6 - mondayOffset; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    total += activity[`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`] ?? 0;
  }
  return total;
}

export default function TimelinePage() {
  const { session, checked } = useSession();
  const params = useParams();
  const userId = params.userId as string;
  const [date, setDate] = useState(todayLocal());
  const [viewMonth, setViewMonth] = useState(monthOf(todayLocal()));
  const [dayActivity, setDayActivity] = useState<Record<string, number>>({}); // date → tracked seconds
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null); // day tooltip
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shotIndex, setShotIndex] = useState<number | null>(null); // open screenshot (index into allShots)
  const [usage, setUsage] = useState<TimelineAppsUrls | null>(null);
  const [usageTab, setUsageTab] = useState<'apps' | 'urls' | 'tasks'>('tasks');
  const [refreshTick, setRefreshTick] = useState(0); // bumped after a screenshot / activity edit
  const [allowSelfDelete, setAllowSelfDelete] = useState(false);
  const [allowSelfEdit, setAllowSelfEdit] = useState(false);
  const [editing, setEditing] = useState<TimelineActivity | null>(null); // open Edit-Time modal
  const [toast, setToast] = useState<string | null>(null); // transient bottom-left toast
  const [flashId, setFlashId] = useState<string | null>(null); // activity briefly highlighted after a task jump

  // admins/managers can delete; an employee can delete their own only when the
  // screenshots.allow_self_delete policy is on (C9). Mirrors the API's RBAC.
  const isSelf = session?.user_id === userId;
  const canDeleteShots = session?.role !== 'employee' || (isSelf && allowSelfDelete);
  // editing activities mirrors the same RBAC, gated by time.allow_self_edit.
  const canEditTime = session?.role !== 'employee' || (isSelf && allowSelfEdit);

  // all of the day's screenshots, flattened + chronological — for modal nav
  const allShots = (data?.activities ?? [])
    .flatMap((a) => a.screenshots)
    .sort((a, b) => (a.captured_at < b.captured_at ? -1 : 1));

  useEffect(() => {
    if (!checked || !session) return;
    setLoading(true);
    getTimeline(userId, date)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [checked, session, userId, date, refreshTick]);

  useEffect(() => {
    if (!checked || !session) return;
    getTimelineActivity(userId, viewMonth)
      .then((r) => setDayActivity(Object.fromEntries(r.days.map((d) => [d.date, d.seconds]))))
      .catch(() => setDayActivity({}));
  }, [checked, session, userId, viewMonth]);

  useEffect(() => {
    if (!checked || !session) return;
    getTimelineAppsUrls(userId, date)
      .then(setUsage)
      .catch(() => setUsage(null));
  }, [checked, session, userId, date]);

  useEffect(() => {
    if (!checked || !session || session.role !== 'employee') return;
    getMyEffectiveSettings()
      .then((e) => {
        setAllowSelfDelete(!!e['screenshots.allow_self_delete']);
        setAllowSelfEdit(e['time.allow_self_edit'] !== false); // default on
      })
      .catch(() => { setAllowSelfDelete(false); setAllowSelfEdit(false); });
  }, [checked, session]);

  // clear the task-jump highlight shortly after it fires
  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), 1500);
    return () => clearTimeout(t);
  }, [flashId]);

  // auto-dismiss the toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  const today = todayLocal();
  const goToday = () => {
    setDate(today);
    setViewMonth(monthOf(today));
  };
  const stepDay = (n: number) => {
    const d = new Date(date + 'T00:00:00');
    d.setDate(d.getDate() + n);
    const next = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (next > today) return;
    setDate(next);
    setViewMonth(monthOf(next));
  };

  const bandDate = new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const monthSeconds = Object.values(dayActivity).reduce((a, b) => a + b, 0);
  const weekSecs = weekSeconds(dayActivity, date);
  // Report deep-links for the Week/Month totals (Mon–Sun week of the selected
  // day; full viewed month) → open Reports pre-filtered to this user + period.
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const wkBase = new Date(date + 'T00:00:00');
  const wkMon = new Date(wkBase);
  wkMon.setDate(wkBase.getDate() - ((wkBase.getDay() + 6) % 7));
  const wkSun = new Date(wkMon);
  wkSun.setDate(wkMon.getDate() + 6);
  const [vy, vm] = viewMonth.split('-').map(Number) as [number, number];
  const monthFrom = `${vy}-${pad(vm)}-01`;
  const monthTo = `${vy}-${pad(vm)}-${pad(new Date(vy, vm, 0).getDate())}`;
  const reportHref = (from: string, to: string) =>
    `/reports?from=${from}&to=${to}&user=${userId}&run=1`;
  // local midnight ms — for placing slot segments on the 24h ruler
  const dayStartMs = new Date(date + 'T00:00:00').getTime();
  const usageRows = (usageTab === 'apps'
    ? (usage?.apps ?? []).map((a) => ({ label: a.name, seconds: a.seconds }))
    : usageTab === 'urls'
    ? (usage?.urls ?? []).map((u) => ({ label: u.domain, seconds: u.seconds }))
    : (usage?.tasks ?? []).map((t) => ({ label: t.description, seconds: t.seconds }))
  );
  const usageMax = usageRows.reduce((m, r) => Math.max(m, r.seconds), 0) || 1;

  // Clicking a task scrolls to the first activity with that description + flashes it.
  const jumpToActivity = (description: string) => {
    const target = data?.activities.find((a) => (a.description ?? '') === description);
    if (!target) return;
    setFlashId(target.id);
    document.getElementById(`act-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="page">
      <TopNav session={session} active="timeline" />

      <div className="tl-user">
        <span className="tl-user-dot" />
        <span className="tl-user-name">{data?.display_name ?? '…'}</span>
        <span className="tl-user-tz">All times are {tzLabel()}</span>
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
            const secs = dayActivity[c.date] ?? 0;
            const pct = secs > 0 ? Math.max(8, Math.min(100, (secs / FULL_DAY_SECONDS) * 100)) : 0;
            return (
              <button
                key={c.date}
                className={`cal-day${c.date === date ? ' selected' : ''}${c.date === today ? ' today' : ''}${c.weekend ? ' weekend' : ''}${future ? ' future' : ''}`}
                onClick={() => !future && setDate(c.date)}
                disabled={future}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTip({ text: hhmm(secs), x: r.left + r.width / 2, y: r.top });
                }}
                onMouseLeave={() => setTip(null)}
              >
                <span className="cal-dow">{c.dow}</span>
                <span className="cal-num">{c.day}</span>
                <span className="cal-bar"><span className="cal-bar-fill" style={{ width: `${pct}%` }} /></span>
              </button>
            );
          })}
        </div>
        {tip && (
          <div className="cal-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>
        )}
      </div>

      <div className="tl-card">
        <div className="tl-card-main">
          <div className="tl-card-date">
            {bandDate}
            {data?.activity_score != null && (
              <span
                className="tl-act-dot"
                style={{ background: actColor(data.activity_score) }}
                title={`Average Activity Level: ${data.activity_score}%`}
              />
            )}
          </div>
          <div className="tl-total-row">
            <span className="tl-total">{hm(data?.tracked_seconds ?? 0)}</span>
            {data?.activity_score != null && <ActivityDonut score={data.activity_score} />}
          </div>
          <div className="tl-subtotals">
            <Link className="tl-sublink" href={reportHref(ymd(wkMon), ymd(wkSun))} title="Open this week in Reports">
              Week <b>{hm(weekSecs)}</b>
            </Link>
            <span className="tl-dot-sep">•</span>
            <Link className="tl-sublink" href={reportHref(monthFrom, monthTo)} title="Open this month in Reports">
              Month <b>{hm(monthSeconds)}</b>
            </Link>
          </div>
        </div>
        <div className="tl-card-side">
          <div className="tl-tabs">
            <button className={usageTab === 'tasks' ? 'on' : ''} onClick={() => setUsageTab('tasks')}>Tasks</button>
            <button className={usageTab === 'apps' ? 'on' : ''} onClick={() => setUsageTab('apps')}>Apps</button>
            <button className={usageTab === 'urls' ? 'on' : ''} onClick={() => setUsageTab('urls')}>URLs</button>
          </div>
          <div className="tl-usage">
            {usageRows.length === 0 ? (
              <p className="muted tl-usage-empty">
                No {usageTab === 'apps' ? 'app' : usageTab === 'urls' ? 'URL' : 'task'} activity for this day.
              </p>
            ) : (
              usageRows.map((r) => {
                // Task rows jump to their matching activity block on the page.
                const canJump =
                  usageTab === 'tasks' &&
                  !!data?.activities.some((a) => (a.description ?? '') === r.label);
                return (
                  <div className="tl-usage-row" key={r.label}>
                    {canJump ? (
                      <button
                        type="button"
                        className="tl-usage-label tl-usage-jump"
                        title={`Jump to “${r.label}”`}
                        onClick={() => jumpToActivity(r.label)}
                      >
                        {r.label}
                      </button>
                    ) : (
                      <span className="tl-usage-label" title={r.label}>{r.label}</span>
                    )}
                    <span className="tl-usage-time">{hm(r.seconds)}</span>
                    <span className="tl-usage-bar"><i style={{ width: `${(r.seconds / usageMax) * 100}%` }} /></span>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <button className="tl-step prev" onClick={() => stepDay(-1)} aria-label="Previous day">‹</button>
        <button className="tl-step next" onClick={() => stepDay(1)} disabled={date >= today} aria-label="Next day">›</button>
      </div>

      <div className="tl-hours-wrap">
        <div className="tl-hours">
          {HOURS.map((h) => <span className="tl-hour" key={h}>{h}</span>)}
          <div className="tl-track">
            {(data?.intervals ?? []).map((iv) => {
              const startMs = new Date(iv.start).getTime();
              const left = ((startMs - dayStartMs) / 86_400_000) * 100;
              const width = Math.max(0.3, ((new Date(iv.end).getTime() - startMs) / 86_400_000) * 100);
              if (left < 0 || left >= 100) return null;
              const from = time(iv.start), to = time(iv.end);
              return <span className="tl-seg" key={iv.start} style={{ left: `${left}%`, width: `${width}%` }} title={`${from} – ${to}`} />;
            })}
          </div>
        </div>
      </div>

      <div className="tl-body">
        {error && <div className="error">{error}</div>}
        {loading ? (
          <p className="muted">Loading…</p>
        ) : !data || data.activities.length === 0 ? (
          <p className="muted">No activity for this day.</p>
        ) : (
          data.activities.map((a) => {
            const head = (
              <>
                <span className="tl-act-time">{time(a.started_at)} – {a.ended_at ? time(a.ended_at) : 'now'}</span>
                {a.activity_score != null && (
                  <span className="tl-act-level" style={{ background: actColor(a.activity_score) }} title={`${a.activity_score}% activity`} />
                )}
                <span className="tl-act-proj">{a.project_name ?? 'No project'}</span>
                {a.description && <span className="tl-act-desc">{a.description}</span>}
                {a.is_manual && <span className="tl-act-edited">edited</span>}
                {canEditTime && <span className="tl-act-pencil" aria-hidden="true"><PencilIcon size={14} /></span>}
                <span className="tl-act-dur">{hm(a.seconds)}</span>
              </>
            );
            return (
              <div className={`tl-act-group${flashId === a.id ? ' tl-act-flash' : ''}`} id={`act-${a.id}`} key={a.id}>
                {canEditTime ? (
                  <button type="button" className="tl-act-head" onClick={() => setEditing(a)} title="Edit this activity">{head}</button>
                ) : (
                  <div className="tl-act-head read-only">{head}</div>
                )}
                {a.screenshots.length > 0 && (
                  <div className="tl-shots">
                    {a.screenshots.map((s) => (
                      <TLThumb
                        key={s.id}
                        id={s.id}
                        at={s.captured_at}
                        app={s.app_name}
                        score={s.activity_score}
                        token={data?.image_token ?? ''}
                        onOpen={() => setShotIndex(allShots.findIndex((x) => x.id === s.id))}
                        canDelete={canDeleteShots}
                        onDeleted={() => { setRefreshTick((t) => t + 1); setToast('Screenshot deleted'); }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {shotIndex !== null && allShots[shotIndex] && (
        <ScreenshotModal
          shots={allShots}
          index={shotIndex}
          token={data?.image_token ?? ''}
          onIndex={setShotIndex}
          onClose={() => setShotIndex(null)}
        />
      )}

      {editing && (
        <EditActivityModal
          activity={editing}
          userId={userId}
          onClose={() => setEditing(null)}
          onSaved={() => setRefreshTick((t) => t + 1)}
        />
      )}

      {toast && (
        <div className="tl-toast" role="status">
          <span className="tl-toast-check"><CheckIcon size={15} /></span>
          {toast}
        </div>
      )}
    </div>
  );
}

/** Lightbox with prev/next navigation across the day's screenshots. */
function ScreenshotModal({
  shots,
  index,
  token,
  onIndex,
  onClose,
}: {
  shots: Array<{ id: string; captured_at: string }>;
  index: number;
  token: string;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const cur = shots[index]!;
  const hasPrev = index > 0;
  const hasNext = index < shots.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && hasPrev) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && hasNext) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, hasPrev, hasNext, onIndex, onClose]);

  return (
    <div className="ss-modal" onClick={onClose} role="dialog" aria-modal="true">
      <button className="ss-nav prev" disabled={!hasPrev} aria-label="Previous"
        onClick={(e) => { e.stopPropagation(); onIndex(index - 1); }}>‹</button>
      <div className="ss-modal-inner" onClick={(e) => e.stopPropagation()}>
        <div className="ss-modal-bar">
          <span>{new Date(cur.captured_at).toLocaleString()}</span>
          <span className="ss-count">{index + 1} / {shots.length}</span>
          <button className="ss-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon size={20} />
          </button>
        </div>
        <img src={screenshotUrl(cur.id, token, 'raw')} alt="Screenshot" decoding="async" />
      </div>
      <button className="ss-nav next" disabled={!hasNext} aria-label="Next"
        onClick={(e) => { e.stopPropagation(); onIndex(index + 1); }}>›</button>
    </div>
  );
}

function TLThumb({
  id, at, app, score, token, onOpen, canDelete, onDeleted,
}: {
  id: string;
  at: string;
  app: string | null;
  score: number | null;
  token: string;
  onOpen: () => void;
  canDelete: boolean;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const del = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try { await deleteScreenshot(id); onDeleted(); } catch { setBusy(false); }
  };
  return (
    <figure className="tl-thumb">
      <div className="tl-thumb-bar">
        <span className="tl-thumb-meta">
          <span className="tl-thumb-time">{time(at)}</span>
          {app && <span className="tl-thumb-app">{app}</span>}
        </span>
        <span className="tl-thumb-meta">
          {score != null && (
            <span className="tl-thumb-dot" style={{ background: actColor(score) }} title={`${score}% activity`} />
          )}
          {canDelete && (
            <button type="button" className="tl-thumb-del" onClick={del} disabled={busy}
              title="Delete screenshot" aria-label="Delete screenshot">
              <TrashIcon size={15} />
            </button>
          )}
        </span>
      </div>
      <button type="button" className="tl-thumb-btn" onClick={onOpen} title="Open screenshot">
        <img src={screenshotUrl(id, token, 'thumb')} alt="" loading="lazy" decoding="async" />
      </button>
    </figure>
  );
}

/** Small donut showing the day's average activity level. */
function ActivityDonut({ score }: { score: number }) {
  const r = 17;
  const circ = 2 * Math.PI * r;
  const on = (Math.max(0, Math.min(100, score)) / 100) * circ;
  return (
    <svg className="tl-donut" width="46" height="46" viewBox="0 0 46 46" role="img"
      aria-label={`Average activity ${score}%`}>
      <title>Average Activity Level: {score}%</title>
      <circle cx="23" cy="23" r={r} fill="none" stroke="#e3e5e8" strokeWidth="7" />
      <circle cx="23" cy="23" r={r} fill="none" stroke={actColor(score)} strokeWidth="7"
        strokeDasharray={`${on} ${circ - on}`} strokeLinecap="round" transform="rotate(-90 23 23)" />
      <text x="23" y="23" textAnchor="middle" dominantBaseline="central"
        fontSize="11" fontWeight="600" fill="#5a6068">{score}%</text>
    </svg>
  );
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}
/** Zero-padded `00h 00m` (calendar-strip day tooltip). */
function hhmm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${pad(h)}h ${pad(m)}m`;
}
function hm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
function actColor(score: number): string {
  if (score >= 60) return '#5bbf3a';
  if (score >= 30) return '#e6a700';
  return '#e2604f';
}
