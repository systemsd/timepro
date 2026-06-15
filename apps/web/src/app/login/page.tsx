'use client';

import { OPSCORE_URL } from '@/lib/api';

export default function LoginPage() {
  return (
    <div className="center">
      <div className="card login-card">
        <div className="login-brand">
          <span className="brand-mark big">▶</span>
          <span>TimePro</span>
        </div>
        <p className="muted login-sub">Sign in to view your reports</p>

        <a className="opscore-btn primary" href={`${OPSCORE_URL}/api/timepro/handoff`}>
          <span className="opscore-mark">▸</span> Sign in with OpsCore
        </a>

        <p className="hint">
          TimePro uses OpsCore for sign-in — you&apos;ll be sent to OpsCore and returned here.
        </p>
      </div>
    </div>
  );
}
