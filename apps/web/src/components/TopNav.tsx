'use client';

import { useRouter } from 'next/navigation';
import { clearSession, type WebSession } from '@/lib/session';

interface Props {
  session: WebSession;
  active: 'home' | 'timeline' | 'reports' | 'team';
}

export function TopNav({ session, active }: Props) {
  const router = useRouter();
  const initials = session.display_name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const firstName = session.display_name.split(' ')[0];

  const tab = (key: Props['active'], label: string, href?: string, dropdown?: boolean) => (
    <button
      className={`nav-tab ${active === key ? 'active' : ''} ${href ? '' : 'disabled'}`}
      onClick={() => href && router.push(href)}
      disabled={!href}
    >
      {label}
      {dropdown && <span className="caret">▾</span>}
    </button>
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
          <button
            className="avatar"
            title="Sign out"
            onClick={() => {
              clearSession();
              router.replace('/login');
            }}
          >
            {initials}
          </button>
        </div>
      </div>

      <nav className="topnav-tabs">
        {tab('home', 'My Home', '/dashboard')}
        {tab('timeline', 'Timeline', undefined, true)}
        {tab('reports', 'Reports', undefined, true)}
        {tab('team', 'Team', '/team')}
      </nav>
    </header>
  );
}
