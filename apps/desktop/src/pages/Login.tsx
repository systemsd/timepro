import { useState } from 'react';
import { ipc } from '../ipc';
import type { Session } from '../types';

interface Props {
  onLoggedIn: (s: Session) => void;
}

export function Login({ onLoggedIn }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const opscore = async () => {
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await ipc.opscoreLogin());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div>
        <div className="brand-name">TimePro</div>
        <div className="brand-sub">Sign in to start tracking</div>
      </div>

      {error && <div className="error">{error}</div>}

      <button type="button" className="opscore-signin primary" onClick={opscore} disabled={busy}>
        {busy ? 'Waiting for OpsCore…' : 'Sign in with OpsCore'}
      </button>

      <p className="hint">
        OpsCore opens your browser to sign in, then returns you to the app.
      </p>
    </div>
  );
}
