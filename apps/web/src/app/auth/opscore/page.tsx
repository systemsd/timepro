'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { exchangeOpsCore } from '@/lib/api';
import { saveSession } from '@/lib/session';
import { DESKTOP_AUTH_KEY } from '../../desktop-auth/page';

function OpsCoreInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [toApp, setToApp] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const token = params.get('token');
    if (!token) {
      setError('Missing OpsCore token. Open TimePro from OpsCore.');
      return;
    }

    // Desktop flow: hand the token to the agent's loopback instead of logging
    // the browser in. The agent exchanges it itself for a device session.
    const desktop = sessionStorage.getItem(DESKTOP_AUTH_KEY);
    if (desktop) {
      sessionStorage.removeItem(DESKTOP_AUTH_KEY);
      try {
        const { port, state } = JSON.parse(desktop) as { port: string; state: string };
        setToApp(true);
        window.location.href =
          `http://127.0.0.1:${encodeURIComponent(port)}/callback` +
          `?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`;
        return;
      } catch {
        /* fall through to normal web login */
      }
    }

    (async () => {
      try {
        const session = await exchangeOpsCore(token);
        saveSession(session);
        router.replace('/dashboard');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [params, router]);

  return (
    <div className="center">
      <div className="card narrow">
        <div className="brand">TimePro</div>
        {error ? (
          <div className="error">{error}</div>
        ) : toApp ? (
          <div className="muted">Signed in — return to the TimePro app.</div>
        ) : (
          <>
            <div className="spinner" />
            <div className="muted">Signing you in via OpsCore…</div>
          </>
        )}
      </div>
    </div>
  );
}

export default function OpsCorePage() {
  return (
    <Suspense fallback={<div className="center muted">Loading…</div>}>
      <OpsCoreInner />
    </Suspense>
  );
}
