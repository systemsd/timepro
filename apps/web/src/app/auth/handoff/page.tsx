'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { exchangeHandoff } from '@/lib/api';
import { saveSession } from '@/lib/session';

function HandoffInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    const code = params.get('code');
    if (!code) {
      setError('Missing handoff code. Open the dashboard from the desktop app.');
      return;
    }
    (async () => {
      try {
        const session = await exchangeHandoff(code);
        saveSession(session);
        router.replace('/dashboard');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [params, router]);

  return (
    <div className="center">
      {error ? (
        <div className="card narrow">
          <div className="brand">TimePro</div>
          <div className="error">{error}</div>
        </div>
      ) : (
        <div className="card narrow">
          <div className="brand">TimePro</div>
          <div className="spinner" />
          <div className="muted">Signing you in…</div>
        </div>
      )}
    </div>
  );
}

export default function HandoffPage() {
  return (
    <Suspense fallback={<div className="center muted">Loading…</div>}>
      <HandoffInner />
    </Suspense>
  );
}
