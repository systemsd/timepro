'use client';

import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';

/**
 * Settings page — stub. The full settings catalog + org-default editor +
 * per-user overrides is Phase 1 (B6 settings engine).
 */
export default function SettingsPage() {
  const { session, checked } = useSession();
  if (!checked || !session) return <div className="center muted">Loading…</div>;

  return (
    <div className="page">
      <TopNav session={session} active="settings" />
      <div className="team-band"><h1>Settings</h1></div>
      <div className="content">
        <p className="muted">
          The settings catalog (screenshots cadence, activity / app &amp; URL tracking, weekly limit,
          auto-pause, currency, week-start, …) with org defaults and per-user overrides is coming in
          the next phase. This page is a placeholder.
        </p>
      </div>
    </div>
  );
}
