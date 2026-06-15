import { useState } from 'react';
import { ipc } from '../ipc';
import type { Session } from '../types';

interface Props {
  onLoggedIn: (s: Session) => void;
}

export function Login({ onLoggedIn }: Props) {
  const [email, setEmail] = useState('owner@timepro.local');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await ipc.devLogin(email));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

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

      <form onSubmit={submit}>
        <label>
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            autoFocus
            required
          />
        </label>

        {error && <div className="error">{error}</div>}

        <button type="submit" className="signin" disabled={busy || !email}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <div className="login-or"><span>or</span></div>

        <button type="button" className="opscore-signin" onClick={opscore} disabled={busy}>
          {busy ? 'Waiting for OpsCore…' : 'Sign in with OpsCore'}
        </button>

        <p className="hint">
          OpsCore opens your browser to sign in, then returns you here. Email
          login is a non-prod shim for already-synced users.
        </p>
      </form>
    </div>
  );
}
