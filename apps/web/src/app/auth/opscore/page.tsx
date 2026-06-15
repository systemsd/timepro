'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { exchangeOpsCore } from '@/lib/api';
import { saveSession } from '@/lib/session';

function OpsCoreInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const token = params.get('token');
    if (!token) {
      setError('Missing OpsCore token. Open TimePro from OpsCore.');
      return;
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
