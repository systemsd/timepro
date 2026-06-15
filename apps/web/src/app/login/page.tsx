'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { login } from '@/lib/api';
import { saveSession } from '@/lib/session';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('owner@timepro.local');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await login(email);
      saveSession(session);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <div className="card login-card">
        <div className="login-brand">
          <span className="brand-mark big">▶</span>
          <span>TimePro</span>
        </div>
        <p className="muted login-sub">Sign in to view your reports</p>

        <form onSubmit={submit} className="login-form">
          <label className="lf">
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
          <label className="lf">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={busy}
            />
          </label>

          {error && <div className="error">{error}</div>}

          <button type="submit" className="login-btn" disabled={busy || !email}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="hint">
          MVP uses email-only sign-in (password ignored). Real password auth ships in Phase 2.
        </p>
      </div>
    </div>
  );
}
