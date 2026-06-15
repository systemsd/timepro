'use client';

import { useCallback, useEffect, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import {
  getManagedProjects,
  getProjectMembers,
  setProjectMembers,
  type ManagedProject,
} from '@/lib/api';

type Member = { user_id: string; display_name: string; enabled: boolean };

export default function ProjectsPage() {
  const { session, checked } = useSession();
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async (selectFirst = false) => {
    try {
      const { projects } = await getManagedProjects();
      setProjects(projects);
      if (selectFirst && projects.length > 0) setSelectedId(projects[0]!.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { if (checked && session) void loadProjects(true); }, [checked, session, loadProjects]);

  useEffect(() => {
    if (!selectedId) return;
    getProjectMembers(selectedId)
      .then((r) => setMembers(r.members))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [selectedId]);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  const selected = projects.find((p) => p.id === selectedId) ?? null;

  const toggle = async (userId: string, enabled: boolean) => {
    if (!selectedId) return;
    setMembers((ms) => ms.map((m) => (m.user_id === userId ? { ...m, enabled } : m)));
    try {
      await setProjectMembers(selectedId, [{ user_id: userId, enabled }]);
      void loadProjects(); // refresh member-count badges
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const setAll = async (enabled: boolean) => {
    if (!selectedId) return;
    const assignments = members.map((m) => ({ user_id: m.user_id, enabled }));
    setMembers((ms) => ms.map((m) => ({ ...m, enabled })));
    try {
      await setProjectMembers(selectedId, assignments);
      void loadProjects();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <TopNav session={session} active="projects" />
      <div className="team-band"><h1>Projects</h1></div>

      <div className="team-layout">
        <aside className="team-list">
          <ul>
            {projects.map((p, i) => (
              <li
                key={p.id}
                className={`member-row ${selectedId === p.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(p.id)}
              >
                <span className="num">{i + 1}</span>
                <span className="mname">{p.name}</span>
                <span className="badge pause" title="Members">👤 {p.member_count}</span>
              </li>
            ))}
          </ul>
          <p className="hint" style={{ marginTop: 14 }}>
            Project catalog is managed in OpsCore once connected — create/archive/delete happen there.
          </p>
        </aside>

        <section className="team-detail">
          {error && <div className="error">{error}</div>}
          {!selected ? (
            <div className="muted">Select a project.</div>
          ) : (
            <>
              <div className="detail-head">
                <h2><span style={{ display: 'inline-block', width: 16, height: 16, borderRadius: 4, background: selected.color, marginRight: 10, verticalAlign: 'middle' }} />{selected.name}</h2>
              </div>

              <h3 className="section-h">Project members</h3>
              <div className="proj-actions">
                <a onClick={() => setAll(true)}>Add all</a>
                <a onClick={() => setAll(false)}>Remove all</a>
              </div>
              <div className="proj-grid">
                {members.map((m) => (
                  <label key={m.user_id} className="proj-row">
                    <span
                      className={`switch ${m.enabled ? 'on' : 'off'}`}
                      onClick={() => toggle(m.user_id, !m.enabled)}
                    >
                      <span className="knob">{m.enabled ? '✓' : '✕'}</span>
                    </span>
                    <span className={m.enabled ? '' : 'muted'}>{m.display_name}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
