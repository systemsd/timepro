import { useEffect, useState } from 'react';
import { Login } from './pages/Login';
import { Timer } from './pages/Timer';
import { Settings } from './pages/Settings';
import { ipc } from './ipc';
import type { Session } from './types';

type View = 'track' | 'settings';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>('track');
  const [bootError, setBootError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // The API base is baked into the binary (see Rust `default_api_base`),
  // so boot only needs to restore an existing session.
  useEffect(() => {
    (async () => {
      try {
        setSession(await ipc.currentSession());
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e));
      } finally {
        setReady(true);
      }
    })();
  }, []);

  if (!ready) return <div className="centered">Loading…</div>;
  if (bootError) return <div className="centered"><div className="error">Boot error: {bootError}</div></div>;

  if (!session) {
    return <Login onLoggedIn={(s) => { setSession(s); setView('track'); }} />;
  }

  if (view === 'settings') {
    return <Settings onClose={() => setView('track')} />;
  }

  return (
    <Timer
      session={session}
      onOpenSettings={() => setView('settings')}
      onLogout={async () => {
        await ipc.logout();
        setSession(null);
      }}
    />
  );
}
