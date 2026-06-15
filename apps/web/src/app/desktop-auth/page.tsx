'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { OPSCORE_URL } from '@/lib/api';

/**
 * Desktop OpsCore login bridge (Phase 3 — desktop).
 *
 * The Tauri agent starts a loopback server, then opens this page with its
 * `port` + `state`. We stash them in sessionStorage (survives the OpsCore
 * round-trip since it stays on this origin) and kick off the existing OpsCore
 * handoff. OpsCore redirects back to `/auth/opscore?token=…`, which — seeing
 * the stashed desktop context — hands the token to the agent's loopback
 * instead of logging the browser in.
 */
export const DESKTOP_AUTH_KEY = 'tp_desktop_auth';

function Bridge() {
  const params = useSearchParams();
  useEffect(() => {
    const port = params.get('port');
    const state = params.get('state');
    if (!port || !state) return;
    sessionStorage.setItem(DESKTOP_AUTH_KEY, JSON.stringify({ port, state }));
    // Hand off to OpsCore; it bounces through its own login if needed, then
    // redirects to /auth/opscore?token=… on this same origin.
    window.location.href = `${OPSCORE_URL}/api/timepro/handoff`;
  }, [params]);

  return (
    <div className="center">
      <div className="card narrow">
        <div className="brand">TimePro</div>
        <div className="spinner" />
        <div className="muted">Connecting to OpsCore…</div>
      </div>
    </div>
  );
}

export default function DesktopAuthPage() {
  return (
    <Suspense fallback={<div className="center muted">Loading…</div>}>
      <Bridge />
    </Suspense>
  );
}
