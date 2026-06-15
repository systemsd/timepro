'use client';

import { useEffect, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import { createClient, getClients, type ClientRow } from '@/lib/api';

export default function ClientsPage() {
  const { session, checked } = useSession();
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    getClients()
      .then((r) => setClients(r.clients))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => { if (checked && session) void load(); }, [checked, session]);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      await createClient(n);
      setName('');
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <TopNav session={session} active="clients" />
      <div className="team-band"><h1>Clients</h1></div>

      <div className="content">
        {error && <div className="error">{error}</div>}

        {clients.length === 0 ? (
          <div className="clients-empty">
            <p>No clients yet. Start by creating one.</p>
            <p className="muted">Then assign projects to clients and you&apos;ll be able to run reports to see time spent on each client.</p>
          </div>
        ) : (
          <table className="entries" style={{ marginBottom: 18 }}>
            <thead><tr><th>Client</th><th>Projects</th></tr></thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="muted">{c.project_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="invite" style={{ maxWidth: 640 }}>
          <input
            placeholder="New client name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <button className="invite-btn" onClick={create}>CREATE</button>
        </div>
        <p className="hint">
          Clients sync from OpsCore business partners once connected; local create is interim. The
          project↔client mapping comes from OpsCore.
        </p>
      </div>
    </div>
  );
}
