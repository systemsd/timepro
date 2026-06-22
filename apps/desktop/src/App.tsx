import { useEffect, useState } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { ask } from '@tauri-apps/plugin-dialog';
import { Login } from './pages/Login';
import { Timer } from './pages/Timer';
import { Settings } from './pages/Settings';
import { ipc } from './ipc';
import type { Session } from './types';

type View = 'track' | 'settings';

/** Check for an app update on launch; if one exists, offer to install + restart.
 *  Best-effort — any failure (offline, no update) is silently ignored. */
async function checkForUpdate() {
  try {
    const update = await check();
    if (!update) return;
    const yes = await ask(
      `TimePro ${update.version} is available (you have ${update.currentVersion}).\n\nInstall now? The app will restart.`,
      { title: 'Update available', kind: 'info', okLabel: 'Update', cancelLabel: 'Later' },
    );
    if (!yes) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch {
    // updater is best-effort; ignore (offline, no manifest, etc.)
  }
}

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
    // Offer an update if one is available (non-blocking).
    void checkForUpdate();
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
