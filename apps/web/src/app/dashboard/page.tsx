'use client';

import { useEffect, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import {
  getScreenshots,
  getScreenshotObjectUrl,
  getToday,
  type ScreenshotMeta,
  type TodaySummary,
} from '@/lib/api';

export default function DashboardPage() {
  const { session, checked } = useSession();
  const [today, setToday] = useState<TodaySummary | null>(null);
  const [shots, setShots] = useState<ScreenshotMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!checked || !session) return;
    (async () => {
      try {
        const [t, sc] = await Promise.all([getToday(), getScreenshots(24)]);
        setToday(t);
        setShots(sc.screenshots);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [checked, session]);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  return (
    <div className="page">
      <TopNav session={session} active="home" />

      <main className="content">
        <h1 className="title">My Home</h1>

        {error && <div className="error">{error}</div>}

        <div className="stats">
          <Stat label="Tracked today" value={formatHM(today?.tracked_seconds ?? 0)} />
          <Stat
            label="Status"
            value={today?.is_running ? 'Tracking' : 'Stopped'}
            tone={today?.is_running ? 'green' : 'muted'}
          />
          <Stat label="Screenshots today" value={String(today?.screenshot_count ?? 0)} />
          <Stat label="Sessions today" value={String(today?.entries.length ?? 0)} />
        </div>

        <section className="block">
          <h2 className="block-title">Recent screenshots</h2>
          {shots.length === 0 ? (
            <p className="muted">No screenshots yet. Start the timer in the desktop app.</p>
          ) : (
            <div className="grid">
              {shots.map((s) => (
                <Thumb key={s.id} shot={s} />
              ))}
            </div>
          )}
        </section>

        <section className="block">
          <h2 className="block-title">Recent activity</h2>
          {today && today.entries.length > 0 ? (
            <table className="entries">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Ended</th>
                  <th>Duration</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {today.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{new Date(e.started_at).toLocaleTimeString()}</td>
                    <td>{e.ended_at ? new Date(e.ended_at).toLocaleTimeString() : '— running —'}</td>
                    <td>{formatHM(e.duration_seconds)}</td>
                    <td className="muted">{e.description ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No activity recorded today.</p>
          )}
        </section>
      </main>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'muted' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

function Thumb({ shot }: { shot: ScreenshotMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked: string | null = null;
    (async () => {
      try {
        const u = await getScreenshotObjectUrl(shot.id);
        revoked = u;
        setUrl(u);
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [shot.id]);

  return (
    <figure className="thumb">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`Screenshot ${shot.id}`} />
      ) : (
        <div className={`thumb-ph ${failed ? 'failed' : ''}`}>{failed ? '!' : ''}</div>
      )}
      <figcaption>{new Date(shot.captured_at).toLocaleTimeString()}</figcaption>
    </figure>
  );
}

function formatHM(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
