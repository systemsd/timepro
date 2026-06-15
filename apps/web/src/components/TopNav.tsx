'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clearSession, type WebSession } from '@/lib/session';
import { getTeamMembers, type Presence, type TeamMember } from '@/lib/api';
import { useRealtimePresence } from '@/lib/useRealtimePresence';
import { HomeIcon, LogOutIcon, SettingsIcon } from '@/components/icons';

interface Props {
  session: WebSession;
  active: 'home' | 'timeline' | 'reports' | 'team' | 'projects' | 'clients' | 'settings' | 'download' | 'account';
}

const isAdmin = (r: string) => r === 'owner' || r === 'admin';
const isManagerOrAdmin = (r: string) => isAdmin(r) || r === 'manager';

export function TopNav({ session, active }: Props) {
  const router = useRouter();
  const role = session.role;
  const initials = session.display_name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const firstName = session.display_name.split(' ')[0];

  const [timelineOpen, setTimelineOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const closeTimer = useRef<number | null>(null);
  const accountTimer = useRef<number | null>(null);
  const live = useRealtimePresence(); // realtime dots (B10 / 5E)

  const openAccount = () => {
    if (accountTimer.current) window.clearTimeout(accountTimer.current);
    setAccountOpen(true);
  };
  const scheduleAccountClose = () => {
    accountTimer.current = window.setTimeout(() => setAccountOpen(false), 180);
  };
  const logout = () => {
    clearSession();
    router.replace('/login');
  };

  // lazily load employees for the Timeline dropdown (admin/manager only)
  useEffect(() => {
    if (timelineOpen && members === null && isManagerOrAdmin(role)) {
      getTeamMembers()
        .then((r) => setMembers(r.members))
        .catch(() => setMembers([]));
    }
  }, [timelineOpen, members, role]);

  const openTimeline = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    setTimelineOpen(true);
  };
  const scheduleClose = () => {
    closeTimer.current = window.setTimeout(() => setTimelineOpen(false), 180);
  };

  const menuItems = [
    isAdmin(role) && { label: 'Projects', href: '/projects' },
    isAdmin(role) && { label: 'Clients', href: '/clients' },
    isAdmin(role) && { label: 'Settings', href: '/settings' },
    { label: 'Download', href: '/download' },
  ].filter(Boolean) as Array<{ label: string; href: string }>;

  return (
    <header className="topnav">
      <div className="topnav-inner">
        <div className="brand">
          <span className="brand-mark">▶</span>
          <span className="brand-text">TimePro</span>
        </div>
        <div className="account">
          <span className="hello">Hello, {firstName}</span>
          <div
            className="account-wrap"
            onMouseEnter={openAccount}
            onMouseLeave={scheduleAccountClose}
          >
            <button
              className="avatar"
              aria-label="Account menu"
              onClick={() => setAccountOpen((v) => !v)}
            >
              {initials}
            </button>
            {accountOpen && (
              <div className="nav-menu account-menu" onMouseEnter={openAccount} onMouseLeave={scheduleAccountClose}>
                <button
                  className="nav-menu-item"
                  onClick={() => {
                    setAccountOpen(false);
                    router.push('/dashboard');
                  }}
                >
                  <HomeIcon /> Dashboard
                </button>
                <button
                  className="nav-menu-item"
                  onClick={() => {
                    setAccountOpen(false);
                    router.push('/account');
                  }}
                >
                  <SettingsIcon /> My Account
                </button>
                <div className="nav-menu-sep" />
                <button className="nav-menu-item" onClick={logout}>
                  <LogOutIcon /> Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <nav className="topnav-tabs">
        <button
          className={`nav-tab ${active === 'home' ? 'active' : ''}`}
          onClick={() => router.push('/dashboard')}
        >
          My Home
        </button>

        {/* Timeline: dropdown of employees for admin/manager; direct for employee */}
        <div
          className="nav-tab-wrap"
          onMouseEnter={isManagerOrAdmin(role) ? openTimeline : undefined}
          onMouseLeave={isManagerOrAdmin(role) ? scheduleClose : undefined}
        >
          <button
            className={`nav-tab ${active === 'timeline' ? 'active' : ''}`}
            onClick={() =>
              isManagerOrAdmin(role)
                ? setTimelineOpen((v) => !v)
                : router.push(`/timeline/${session.user_id}`)
            }
          >
            Timeline {isManagerOrAdmin(role) && <span className="caret">▾</span>}
          </button>
          {timelineOpen && isManagerOrAdmin(role) && (
            <div className="nav-menu" onMouseEnter={openTimeline} onMouseLeave={scheduleClose}>
              {members === null ? (
                <div className="nav-menu-empty">Loading…</div>
              ) : members.length === 0 ? (
                <div className="nav-menu-empty">No employees</div>
              ) : (
                members.map((m) => {
                  const p: Presence = live[m.user_id] ?? m.presence;
                  return (
                    <button
                      key={m.user_id}
                      className="nav-menu-item"
                      onClick={() => {
                        setTimelineOpen(false);
                        router.push(`/timeline/${m.user_id}`);
                      }}
                    >
                      <span
                        className={`presence-dot ${p}`}
                        title={p === 'tracking' ? 'Tracking' : p === 'connected' ? 'Online' : 'Offline'}
                      />
                      {m.display_name || m.email}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        <button
          className={`nav-tab ${active === 'reports' ? 'active' : ''}`}
          onClick={() => router.push('/reports')}
        >
          Reports
        </button>

        {isManagerOrAdmin(role) && (
          <button
            className={`nav-tab ${active === 'team' ? 'active' : ''}`}
            onClick={() => router.push('/team')}
          >
            Team
          </button>
        )}

        {/* ☰ menu */}
        <div className="nav-tab-wrap" onMouseLeave={() => setMenuOpen(false)}>
          <button
            className={`nav-tab hamburger ${['projects', 'clients', 'settings', 'download'].includes(active) ? 'active' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="menu"
          >
            ☰
          </button>
          {menuOpen && (
            <div className="nav-menu">
              {menuItems.map((it) => (
                <button
                  key={it.href}
                  className="nav-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    router.push(it.href);
                  }}
                >
                  {it.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </nav>
    </header>
  );
}
