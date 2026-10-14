'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clearSession, type WebSession } from '@/lib/session';
import { getTeamMembers, type Presence, type TeamMember } from '@/lib/api';
import { useRealtimePresence } from '@/lib/useRealtimePresence';
import { roleAccess, useAccess } from '@/lib/useAccess';
import { HomeIcon, LogOutIcon, SettingsIcon } from '@/components/icons';

interface Props {
  session: WebSession;
  active: 'home' | 'timeline' | 'reports' | 'team' | 'projects' | 'clients' | 'settings' | 'diagnostics' | 'download' | 'account';
}

const isAdmin = (r: string) => r === 'owner' || r === 'admin';

export function TopNav({ session, active }: Props) {
  const router = useRouter();
  const role = session.role;
  // Hierarchy/grants can let anyone see others, so the employee picker follows
  // the visibility scope; the Team page stays with team-management roles.
  const access = useAccess(session) ?? roleAccess(session);
  const seesTeam = access.can_view_others;
  const managesTeam = access.can_manage_team;
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileTimelineOpen, setMobileTimelineOpen] = useState(false);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const closeTimer = useRef<number | null>(null);
  const accountTimer = useRef<number | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const accountRef = useRef<HTMLDivElement | null>(null);
  const mobileToggleRef = useRef<HTMLButtonElement | null>(null);
  const mobilePanelRef = useRef<HTMLElement | null>(null);
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

  const closeAll = () => {
    setTimelineOpen(false);
    setMenuOpen(false);
    setAccountOpen(false);
    setMobileOpen(false);
  };
  const go = (href: string) => {
    closeAll();
    router.push(href);
  };

  // touch/keyboard safety net: hover-close never fires on touch devices,
  // so close any open menu on an outside pointerdown or Escape
  useEffect(() => {
    if (!timelineOpen && !menuOpen && !accountOpen && !mobileOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (
        timelineRef.current?.contains(t) ||
        menuRef.current?.contains(t) ||
        accountRef.current?.contains(t) ||
        mobileToggleRef.current?.contains(t) ||
        mobilePanelRef.current?.contains(t)
      )
        return;
      closeAll();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [timelineOpen, menuOpen, accountOpen, mobileOpen]);

  // lazily load employees for the Timeline dropdown / mobile disclosure (admin/manager only)
  useEffect(() => {
    const wantsMembers = timelineOpen || (mobileOpen && mobileTimelineOpen);
    if (wantsMembers && members === null && seesTeam) {
      getTeamMembers()
        .then((r) => setMembers(r.members))
        .catch(() => setMembers([]));
    }
  }, [timelineOpen, mobileOpen, mobileTimelineOpen, members, seesTeam]);

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
    isAdmin(role) && { label: 'Diagnostics', href: '/diagnostics' },
    { label: 'Download', href: '/download' },
  ].filter(Boolean) as Array<{ label: string; href: string }>;

  const memberList = (onPick: (userId: string) => void) =>
    members === null ? (
      <div className="nav-menu-empty">Loading…</div>
    ) : members.length === 0 ? (
      <div className="nav-menu-empty">No employees</div>
    ) : (
      members.map((m) => {
        const p: Presence = live[m.user_id] ?? m.presence;
        return (
          <button key={m.user_id} className="nav-menu-item" onClick={() => onPick(m.user_id)}>
            <span
              className={`presence-dot ${p}`}
              title={p === 'tracking' ? 'Tracking' : p === 'connected' ? 'Online' : 'Offline'}
            />
            {m.display_name || m.email}
          </button>
        );
      })
    );

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
            ref={accountRef}
            onMouseEnter={openAccount}
            onMouseLeave={scheduleAccountClose}
          >
            <button
              className="avatar"
              aria-label="Account menu"
              aria-expanded={accountOpen}
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
          <button
            className="topnav-mobile-toggle"
            ref={mobileToggleRef}
            aria-label="Main menu"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((v) => !v)}
          >
            ☰
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav className="topnav-mobile-menu" aria-label="Main menu" ref={mobilePanelRef}>
          <button
            className={`nav-menu-item ${active === 'home' ? 'active' : ''}`}
            onClick={() => go('/dashboard')}
          >
            My Home
          </button>
          {seesTeam ? (
            <>
              <button
                className={`nav-menu-item ${active === 'timeline' ? 'active' : ''}`}
                aria-expanded={mobileTimelineOpen}
                onClick={() => setMobileTimelineOpen((v) => !v)}
              >
                Timeline <span className="caret">{mobileTimelineOpen ? '▴' : '▾'}</span>
              </button>
              {mobileTimelineOpen && (
                <div className="topnav-mobile-sub">
                  {memberList((userId) => go(`/timeline/${userId}`))}
                </div>
              )}
            </>
          ) : (
            <button
              className={`nav-menu-item ${active === 'timeline' ? 'active' : ''}`}
              onClick={() => go(`/timeline/${session.user_id}`)}
            >
              Timeline
            </button>
          )}
          <button
            className={`nav-menu-item ${active === 'reports' ? 'active' : ''}`}
            onClick={() => go('/reports')}
          >
            Reports
          </button>
          {managesTeam && (
            <button
              className={`nav-menu-item ${active === 'team' ? 'active' : ''}`}
              onClick={() => go('/team')}
            >
              Team
            </button>
          )}
          <div className="nav-menu-sep" />
          {menuItems.map((it) => (
            <button
              key={it.href}
              className={`nav-menu-item ${active === it.href.slice(1) ? 'active' : ''}`}
              onClick={() => go(it.href)}
            >
              {it.label}
            </button>
          ))}
          <div className="nav-menu-sep" />
          <button
            className={`nav-menu-item ${active === 'account' ? 'active' : ''}`}
            onClick={() => go('/account')}
          >
            <SettingsIcon /> My Account
          </button>
          <button className="nav-menu-item" onClick={logout}>
            <LogOutIcon /> Log out
          </button>
        </nav>
      )}

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
          ref={timelineRef}
          onMouseEnter={seesTeam ? openTimeline : undefined}
          onMouseLeave={seesTeam ? scheduleClose : undefined}
        >
          <button
            className={`nav-tab ${active === 'timeline' ? 'active' : ''}`}
            aria-expanded={seesTeam ? timelineOpen : undefined}
            onClick={() =>
              seesTeam
                ? setTimelineOpen((v) => !v)
                : router.push(`/timeline/${session.user_id}`)
            }
          >
            Timeline {seesTeam && <span className="caret">▾</span>}
          </button>
          {timelineOpen && seesTeam && (
            <div className="nav-menu" onMouseEnter={openTimeline} onMouseLeave={scheduleClose}>
              {memberList((userId) => {
                setTimelineOpen(false);
                router.push(`/timeline/${userId}`);
              })}
            </div>
          )}
        </div>

        <button
          className={`nav-tab ${active === 'reports' ? 'active' : ''}`}
          onClick={() => router.push('/reports')}
        >
          Reports
        </button>

        {managesTeam && (
          <button
            className={`nav-tab ${active === 'team' ? 'active' : ''}`}
            onClick={() => router.push('/team')}
          >
            Team
          </button>
        )}

        {/* ☰ menu */}
        <div className="nav-tab-wrap" ref={menuRef} onMouseLeave={() => setMenuOpen(false)}>
          <button
            className={`nav-tab hamburger ${['projects', 'clients', 'settings', 'diagnostics', 'download'].includes(active) ? 'active' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="menu"
            aria-expanded={menuOpen}
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
