'use client';

import { useCallback, useEffect, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import {
  getTeamMember,
  getTeamMembers,
  inviteMember,
  removeMember,
  setMemberProjects,
  syncOpsCore,
  updateTeamMember,
  type MemberDetail,
  type TeamMember,
} from '@/lib/api';

const ROLE_OPTIONS: Array<{ value: string; label: string; desc: string }> = [
  { value: 'employee', label: 'User', desc: 'can see their own data only' },
  { value: 'manager', label: 'Manager', desc: "can see selected user's Timeline & Reports (but not rates)" },
  { value: 'admin', label: 'Admin', desc: 'full control over Team, Projects & Settings.' },
];

const SETTINGS_ORDER: Array<[string, string]> = [
  ['screenshots', 'Screenshots'],
  ['activity_level_tracking', 'Activity Level tracking'],
  ['app_url_tracking', 'App & URL tracking'],
  ['weekly_time_limit', 'Weekly time limit'],
  ['auto_pause_after', 'Auto-pause tracking after'],
  ['allow_offline_time', 'Allow adding Offline Time'],
  ['notify_on_screenshot', 'Notify when screenshot is taken'],
];

export default function TeamPage() {
  const { session, checked } = useSession();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [savingProjects, setSavingProjects] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const loadMembers = useCallback(async (selectFirst = false) => {
    try {
      const { members } = await getTeamMembers();
      setMembers(members);
      if (selectFirst && members.length > 0) {
        const firstNonOwner = members.find((m) => !m.is_owner) ?? members[0];
        if (firstNonOwner) setSelectedId(firstNonOwner.user_id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (checked && session) void loadMembers(true);
  }, [checked, session, loadMembers]);

  useEffect(() => {
    if (!selectedId) return;
    (async () => {
      try {
        setDetail(await getTeamMember(selectedId));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [selectedId]);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  const isOwner = detail?.is_owner ?? false;

  const changeRole = async (role: string) => {
    if (!detail || isOwner) return;
    try {
      await updateTeamMember(detail.user_id, { role });
      setDetail({ ...detail, role });
      void loadMembers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleProject = async (projectId: string, enabled: boolean) => {
    if (!detail || isOwner) return;
    setSavingProjects(true);
    // optimistic
    setDetail({
      ...detail,
      projects: detail.projects.map((p) => (p.id === projectId ? { ...p, enabled } : p)),
    });
    try {
      await setMemberProjects(detail.user_id, [{ project_id: projectId, enabled }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDetail(await getTeamMember(detail.user_id)); // resync on failure
    } finally {
      setSavingProjects(false);
    }
  };

  const setAllProjects = async (enabled: boolean) => {
    if (!detail || isOwner) return;
    const assignments = detail.projects.map((p) => ({ project_id: p.id, enabled }));
    setDetail({ ...detail, projects: detail.projects.map((p) => ({ ...p, enabled })) });
    try {
      await setMemberProjects(detail.user_id, assignments);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setStatus = async (status: string) => {
    if (!detail || isOwner) return;
    try {
      await updateTeamMember(detail.user_id, { status });
      setDetail({ ...detail, status });
      void loadMembers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDelete = async () => {
    if (!detail || isOwner) return;
    if (!confirm(`Remove ${detail.display_name} from the team?`)) return;
    try {
      await removeMember(detail.user_id);
      setSelectedId(null);
      setDetail(null);
      await loadMembers(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    try {
      await inviteMember(email);
      setInviteEmail('');
      void loadMembers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <TopNav session={session} active="team" />

      <div className="team-band">
        <h1>Team</h1>
      </div>

      <div className="team-layout">
        {/* Left: member list */}
        <aside className="team-list">
          {session.role !== 'manager' && (
            <button
              className="opscore-sync"
              disabled={syncing}
              onClick={async () => {
                setSyncing(true);
                setError(null);
                try {
                  const r = await syncOpsCore();
                  setSyncMsg(
                    `Synced ${r.users} users · ${r.projects} projects · ${r.clients} clients` +
                      (r.disabled > 0 ? ` · ${r.disabled} disabled` : ''),
                  );
                  await loadMembers(true);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setSyncing(false);
                }
              }}
            >
              {syncing ? 'Syncing…' : '⟳ Sync from OpsCore'}
            </button>
          )}
          {syncMsg && <div className="sync-msg">{syncMsg}</div>}
          <button className="create-group">+ Create user group</button>

          <ul>
            {members.map((m, i) => (
              <li
                key={m.user_id}
                className={[
                  'member-row',
                  selectedId === m.user_id ? 'selected' : '',
                  m.status === 'archived' ? 'archived' : '',
                ].join(' ')}
                onClick={() => setSelectedId(m.user_id)}
              >
                <span className="num">{i + 1}</span>
                <span className="mname">{m.display_name || m.email}</span>
                {m.is_owner && <span className="badge star" title="Owner">★</span>}
                {m.status === 'suspended' && <span className="badge pause" title="Paused">⏸</span>}
              </li>
            ))}
          </ul>

          <div className="invite">
            <input
              placeholder="Add new employee by email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doInvite()}
            />
            <button className="invite-btn" onClick={doInvite}>INVITE</button>
          </div>
        </aside>

        {/* Right: detail panel */}
        <section className="team-detail">
          {error && <div className="error">{error}</div>}

          {!detail ? (
            <div className="muted">Select a team member.</div>
          ) : (
            <>
              <div className="detail-head">
                <h2>{detail.display_name || detail.email}</h2>
                <div className="detail-actions">
                  <button onClick={() => setStatus('suspended')} disabled={isOwner}>⏸ Pause</button>
                  <button onClick={() => setStatus('archived')} disabled={isOwner}>🗄 Archive</button>
                  <button className="danger" onClick={doDelete} disabled={isOwner}>✕ Delete</button>
                </div>
              </div>
              <div className="detail-email">{detail.email} 🇺🇸</div>
              <div className="detail-links">
                <a>Set pay rate</a>
                <a>View timeline</a>
              </div>

              <h3 className="section-h">Role</h3>
              {isOwner ? (
                <div className="muted owner-note">This member is the organization owner.</div>
              ) : (
                <div className="roles">
                  {ROLE_OPTIONS.map((r) => (
                    <label key={r.value} className="role-row">
                      <input
                        type="radio"
                        name="role"
                        checked={detail.role === r.value}
                        onChange={() => changeRole(r.value)}
                      />
                      <span>
                        <strong>{r.label}</strong> <span className="muted">- {r.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}

              <div className="section-h-row">
                <h3 className="section-h">Projects</h3>
                <label className="per-rate muted">
                  <input type="checkbox" disabled /> Use per project pay rates
                </label>
              </div>
              <div className="proj-actions">
                <a onClick={() => setAllProjects(true)}>Add all</a>
                <a onClick={() => setAllProjects(false)}>Remove all</a>
                {savingProjects && <span className="muted small">saving…</span>}
              </div>
              <div className="proj-grid">
                {detail.projects.map((p) => (
                  <label key={p.id} className={`proj-row ${isOwner ? 'disabled' : ''}`}>
                    <span
                      className={`switch ${p.enabled ? 'on' : 'off'}`}
                      onClick={() => toggleProject(p.id, !p.enabled)}
                    >
                      <span className="knob">{p.enabled ? '✓' : '✕'}</span>
                    </span>
                    <span className={p.enabled ? '' : 'muted'}>{p.name}</span>
                  </label>
                ))}
              </div>

              <h3 className="section-h">Effective settings</h3>
              <div className="eff-settings">
                {SETTINGS_ORDER.map(([key, label]) => (
                  <div className="eff-row" key={key}>
                    <span className="eff-label">{label}</span>
                    <span className="eff-val">{detail.effective_settings[key] ?? '—'}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      <footer className="team-foot">
        Employees can see their own rates, but not the rates of others. You will not be billed for
        archived users. You will not be billed for owners unless they track their own time.
      </footer>
    </div>
  );
}
