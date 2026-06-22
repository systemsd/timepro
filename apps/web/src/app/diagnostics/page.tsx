'use client';

import { useEffect, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import { getAgentLogs, getTeamMembers, type AgentLog, type TeamMember } from '@/lib/api';

type LevelFilter = '' | 'info' | 'warn' | 'error';

export default function DiagnosticsPage() {
  const { session, checked } = useSession();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [userId, setUserId] = useState('');
  const [level, setLevel] = useState<LevelFilter>('');
  const [q, setQ] = useState('');
  const [logs, setLogs] = useState<AgentLog[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether this account may read diagnostics is decided by the API (owners/
  // admins + the developer allowlist), not the client — so just attempt the load
  // and surface a 403 as an error. The team-member dropdown is best-effort
  // (employees can't list the team, so it may stay empty — filtering by
  // level/search still works).
  useEffect(() => {
    if (!checked || !session) return;
    getTeamMembers()
      .then((r) => setMembers(r.members))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, session]);

  useEffect(() => {
    if (!checked || !session) return;
    setLoading(true);
    setError(null);
    getAgentLogs({ userId: userId || undefined, level: level || undefined, q: q || undefined })
      .then((r) => setLogs(r.logs))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, session, userId, level]);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  const reload = () =>
    getAgentLogs({ userId: userId || undefined, level: level || undefined, q: q || undefined })
      .then((r) => setLogs(r.logs))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  return (
    <div className="page">
      <TopNav session={session} active="diagnostics" />
      <main className="diag-band">
        <h1>Agent Diagnostics</h1>
        <p className="muted diag-sub">Desktop-agent logs shipped from each tracked machine (last 14 days).</p>

        <div className="diag-filters">
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">All users</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.display_name || m.email}
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
              if (e.key === 'Enter') void reload();
            }}
          />
          <button onClick={() => void reload()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        {logs && logs.length === 0 && !loading && (
          <p className="muted">No logs for this filter yet.</p>
        )}

        <div className="diag-logs">
          {logs?.map((l) => (
            <div key={l.id} className={`diag-row lvl-${l.level}`}>
              <span className="diag-ts">{new Date(l.ts).toLocaleString()}</span>
              <span className={`diag-level lvl-${l.level}`}>{l.level}</span>
              <span className="diag-event">{l.event.replace(/^timepro_agent_lib::/, '')}</span>
              <span className="diag-msg">
                {l.message}
                {Object.keys(l.fields).length > 0 && (
                  <span className="diag-fields"> {JSON.stringify(l.fields)}</span>
                )}
              </span>
              <span className="diag-meta">
                {[l.agentVersion, l.os].filter(Boolean).join(' · ')}
              </span>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
