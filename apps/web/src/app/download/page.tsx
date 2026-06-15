'use client';

import { useEffect, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';

// Placeholder URLs until the build/sign/host pipeline lands (Phase 6).
const DL = {
  macArm: '#',
  macIntel: '#',
  windows: '#',
  linux: '#',
  extension: '#',
};

export default function DownloadPage() {
  const { session, checked } = useSession();
  const [os, setOs] = useState<'mac' | 'windows' | 'linux' | 'other'>('other');

  useEffect(() => {
    const p = navigator.platform.toLowerCase() + ' ' + navigator.userAgent.toLowerCase();
    if (p.includes('mac')) setOs('mac');
    else if (p.includes('win')) setOs('windows');
    else if (p.includes('linux')) setOs('linux');
  }, []);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  return (
    <div className="page">
      <TopNav session={session} active="download" />
      <div className="team-band"><h1>Download application</h1></div>

      <div className="dl-layout">
        <main className="dl-main">
          <h2 className="dl-h">Download employee desktop application{os === 'mac' ? ' for macOS' : ''}</h2>
          <p className="muted">
            This application is <strong>only for employees, not managers</strong>. Company managers
            can see the recorded time and screenshots right on this website.
          </p>

          {os === 'mac' ? (
            <div className="dl-buttons">
              <a className="dl-btn" href={DL.macArm}>↓ Download for Apple Silicon</a>
              <a className="dl-btn" href={DL.macIntel}>↓ Download for Intel Macs</a>
            </div>
          ) : os === 'windows' ? (
            <div className="dl-buttons"><a className="dl-btn" href={DL.windows}>↓ Download for Windows</a></div>
          ) : os === 'linux' ? (
            <div className="dl-buttons"><a className="dl-btn" href={DL.linux}>↓ Download for Linux</a></div>
          ) : (
            <div className="dl-buttons">
              <a className="dl-btn" href={DL.macArm}>↓ macOS</a>
              <a className="dl-btn" href={DL.windows}>↓ Windows</a>
              <a className="dl-btn" href={DL.linux}>↓ Linux</a>
            </div>
          )}

          <h3 className="dl-sub">What is this?</h3>
          <p className="muted">
            A desktop application for employees. It is started and stopped by an employee to track
            time and take screenshots during work.
          </p>
          <p className="muted">
            After Stop is pressed — no screenshots are taken. You can review your time and
            screenshots at <strong>My Home</strong>.
          </p>

          <h3 className="dl-sub">After install</h3>
          <p className="muted">
            Run the application and press &quot;Start&quot; to begin time tracking and screenshot monitoring.
          </p>

          <p className="hint">
            Installers are not yet hosted/signed — download links are placeholders until the build
            pipeline ships. Build locally with <code>pnpm --filter @timepro/desktop tauri:build</code>.
          </p>
        </main>

        <aside className="dl-side">
          <div className="dl-side-item"><div className="dl-side-h">Need Windows version?</div><a href={DL.windows}>Download Windows application</a></div>
          <div className="dl-side-item"><div className="dl-side-h">Need Linux version?</div><a href={DL.linux}>Download Linux application</a></div>
          <div className="dl-side-item"><div className="dl-side-h">Need browser extension?</div><a href={DL.extension}>Download extension</a></div>
        </aside>
      </div>
    </div>
  );
}
