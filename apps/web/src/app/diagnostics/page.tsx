'use client';

import { useEffect, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import { getAgentLogs, type AgentLog } from '@/lib/api';

type LevelFilter = '' | 'info' | 'warn' | 'error';

export default function DiagnosticsPage() {
  const { session, checked } = useSession();
  const [userId, setUserId] = useState('');
  const [level, setLevel] = useState<LevelFilter>('');
  const [q, setQ] = useState('');
  const [logs, setLogs] = useState<AgentLog[] | null>(null);
  // userId -> display label, accumulated from logs (no team-list call needed,
  // so it works for allowlisted developers who aren't org admins).
  const [users, setUsers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    return getAgentLogs({ userId: userId || undefined, level: level || undefined, q: q || undefined })
      .then((r) => {
        setLogs(r.logs);
        setUsers((prev) => {
          const next = { ...prev };
          for (const l of r.logs) next[l.userId] = l.displayName || l.email || l.userId;
          return next;
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  // Authorization is decided by the API (owners/admins + developer allowlist);
  // a 403 surfaces as an error rather than a client-side gate.
  useEffect(() => {
    if (!checked || !session) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, session, userId, level]);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  return (
    <div className="page">
      <TopNav session={session} active="diagnostics" />
      <main className="diag-band">
        <h1>Agent Diagnostics</h1>
        <p className="muted diag-sub">Desktop-agent logs shipped from each tracked machine (last 14 days).</p>

        <div className="diag-filters">
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">All users</option>
            {Object.entries(users).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select value={level} onChange={(e) => setLevel(e.target.value as LevelFilter)}>
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <input
            placeholder="Search message…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load();
            }}
          />
          <button onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        {logs && logs.length === 0 && !loading && <p className="muted">No logs for this filter yet.</p>}

        <div className="diag-logs">
          {logs?.map((l) => (
            <div key={l.id} className={`diag-row lvl-${l.level}`}>
              <span className="diag-ts">{new Date(l.ts).toLocaleString()}</span>
              <span className={`diag-level lvl-${l.level}`}>{l.level}</span>
              <span className="diag-user" title={l.email ?? l.userId}>
                {l.displayName || l.email || l.userId.slice(0, 8)}
              </span>
              <span className="diag-event">{l.event.replace(/^timepro_agent_lib::/, '')}</span>
              <span className="diag-msg">
                {l.message}
                {Object.keys(l.fields).length > 0 && (
                  <span className="diag-fields"> {JSON.stringify(l.fields)}</span>
                )}
              </span>
              <span className="diag-meta">{[l.agentVersion, l.os].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
