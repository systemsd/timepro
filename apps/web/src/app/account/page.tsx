'use client';

import { useEffect, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import { getProfile, type Profile } from '@/lib/api';
import { KeyIcon, MailIcon, ShieldIcon, TrashIcon, UserIcon } from '@/components/icons';

/** Browser timezone as `UTC±HH:MM` (C6 — viewer timezone). */
function tzLabel(): string {
  const off = -new Date().getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const hh = String(Math.floor(a / 60)).padStart(2, '0');
  const mm = String(a % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

// Account actions backed by real password/JWT auth — arrives in Phase 6.
const SOON = 'Available once account auth ships (Phase 6)';
const ACTIONS = [
  { label: 'Edit profile', Icon: UserIcon },
  { label: 'Change password', Icon: KeyIcon },
  { label: 'Change email', Icon: MailIcon },
  { label: 'Two-Factor Authentication (2FA) & Passkeys', Icon: ShieldIcon },
  { label: 'Delete my account', Icon: TrashIcon },
];

export default function AccountPage() {
  const { session, checked } = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!checked || !session) return;
    getProfile()
      .then(setProfile)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [checked, session]);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  const name = profile?.display_name || session.display_name;
  const org = profile?.organization_name || session.organization_name;
  const email = profile?.email ?? '';

  return (
    <div className="page">
      <TopNav session={session} active="account" />

      <div className="acct-band">
        <h1>My Account</h1>
      </div>

      <main className="acct-wrap">
        {error && <div className="error">{error}</div>}

        {/* Profile */}
        <section className="acct-section">
          <h2 className="acct-name">{name}</h2>
          <div className="acct-meta">{org}</div>
          {email && <div className="acct-meta">{email}</div>}
          <div className="acct-meta">{tzLabel()}</div>

          <div className="acct-actions">
            {ACTIONS.map(({ label, Icon }) => (
              <button key={label} className="acct-action" disabled title={SOON}>
                <Icon /> {label}
              </button>
            ))}
          </div>
          <p className="acct-hint">{SOON}.</p>
        </section>

        {/* Company plan */}
        <section className="acct-section">
          <h2 className="acct-h">Company plan</h2>
          <p className="acct-text">
            If you track time for other companies you don&apos;t need a plan and don&apos;t have to pay —
            your company pays for you. Your role here is <strong>{profile?.role ?? session.role}</strong>.
          </p>
        </section>

        {/* API access */}
        <section className="acct-section">
          <h2 className="acct-h">TimePro API</h2>
          <p className="acct-text">
            A REST API to read and manage your data. Requests authenticate with a personal API token in
            the <code>x-api-token</code> header.
          </p>
          <div className="acct-token">
            <span className="acct-token-label">API token</span>
            <button className="acct-action" disabled title={SOON}>
              <KeyIcon /> Generate token
            </button>
          </div>
          <p className="acct-hint">Personal API tokens arrive with account auth (Phase 6).</p>
        </section>
      </main>
    </div>
  );
}
