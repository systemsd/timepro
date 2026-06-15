'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import { getScreenshotObjectUrl, getTimeline, getTimelineActivity, type Timeline } from '@/lib/api';

// ---- calendar-strip helpers (viewer-local) ----
const pad = (n: number) => String(n).padStart(2, '0');
const DOW = 'SMTWTFS'; // index 0=Sun … 6=Sat

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
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
    cells.push({ date: `${y}-${pad(m)}-${pad(d)}`, day: d, dow: DOW[dow]!, weekend: dow === 0 || dow === 6 });
  }
  return cells;
}

export default function TimelinePage() {
  const { session, checked } = useSession();
  const params = useParams();
  const userId = params.userId as string;
  const [date, setDate] = useState(todayLocal());
  const [viewMonth, setViewMonth] = useState(monthOf(todayLocal()));
  const [activeDays, setActiveDays] = useState<Set<string>>(new Set());
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!checked || !session) return;
    setLoading(true);
    getTimeline(userId, date)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [checked, session, userId, date]);

  useEffect(() => {
    if (!checked || !session) return;
    getTimelineActivity(userId, viewMonth)
      .then((r) => setActiveDays(new Set(r.days.filter((d) => d.seconds > 0).map((d) => d.date))))
      .catch(() => setActiveDays(new Set()));
  }, [checked, session, userId, viewMonth]);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  const today = todayLocal();
  const goToday = () => {
    setDate(today);
    setViewMonth(monthOf(today));
  };

  const pretty = new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  return (
    <div className="page">
      <TopNav session={session} active="timeline" />

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

      <div className="tl-band">
        <div className="tl-head">
          <span className="tl-who">{data?.display_name ?? '…'}</span>
          <span className="tl-date">{pretty}</span>
        </div>
        <div className="tl-totals">
          <div className="tl-total">{hm(data?.tracked_seconds ?? 0)}</div>
          {data?.activity_score != null && (
            <div className="tl-activity" title="Average activity">
              <span className="tl-act-bar"><span className="tl-act-fill" style={{ width: `${data.activity_score}%`, background: actColor(data.activity_score) }} /></span>
              <span className="tl-act-pct">{data.activity_score}%</span>
            </div>
          )}
        </div>
      </div>

      <div className="tl-body">
        {error && <div className="error">{error}</div>}
        {loading ? (
          <p className="muted">Loading…</p>
        ) : !data || data.slots.length === 0 ? (
          <p className="muted">No screenshots for this day.</p>
        ) : (
          data.slots.map((slot) => (
            <div className="tl-slot" key={slot.start}>
              <div className="tl-slot-time">
                <div>{time(slot.start)} – {time(slot.end)}</div>
                <div className="tl-slot-meta">
                  {slot.activity_score != null && (
                    <span className="tl-slot-act" style={{ color: actColor(slot.activity_score) }}>
                      ● {slot.activity_score}%
                    </span>
                  )}
                  {slot.app_name && <span className="tl-slot-app">{slot.app_name}</span>}
                </div>
              </div>
              <div className="tl-shots">
                {slot.screenshots.map((s) => <TLThumb key={s.id} id={s.id} at={s.captured_at} />)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TLThumb({ id, at }: { id: string; at: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    getScreenshotObjectUrl(id).then((u) => { revoked = u; setUrl(u); }).catch(() => {});
    return () => { if (revoked) URL.revokeObjectURL(revoked); };
  }, [id]);
  return (
    <figure className="tl-thumb">
      {url ? <img src={url} alt="" /> : <div className="tl-thumb-ph" />}
      <figcaption>{time(at)}</figcaption>
    </figure>
  );
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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
