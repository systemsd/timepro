'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import { getScreenshotObjectUrl, getTimeline, type Timeline } from '@/lib/api';

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export default function TimelinePage() {
  const { session, checked } = useSession();
  const params = useParams();
  const userId = params.userId as string;
  const [date, setDate] = useState(todayLocal());
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

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  const pretty = new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  return (
    <div className="page">
      <TopNav session={session} active="timeline" />
      <div className="tl-band">
        <div className="tl-nav">
          <button onClick={() => setDate(shiftDate(date, -1))}>‹</button>
          <input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} />
          <button onClick={() => setDate(shiftDate(date, 1))} disabled={date >= todayLocal()}>›</button>
        </div>
        <div className="tl-head">
          <span className="tl-who">{data?.display_name ?? '…'}</span>
          <span className="tl-date">{pretty}</span>
        </div>
        <div className="tl-total">{hm(data?.tracked_seconds ?? 0)}</div>
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
                {time(slot.start)} – {time(slot.end)}
              </div>
              <div className="tl-shots">
                {slot.screenshots.map((s) => <TLThumb key={s.id} id={s.id} at={s.captured_at} />)}
              </div>
            </div>
          ))
        )}
        {/* Activity strip + per-slot activity % come with activity tracking (Phase 4). */}
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
