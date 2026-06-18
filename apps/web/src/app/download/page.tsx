'use client';

import { useEffect, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';

// Installer binaries are published to a SEPARATE PUBLIC repo (`timepro-downloads`)
// by `.github/workflows/desktop-release.yml`, so anonymous employees can download
// them while the code repo (`systemsd/timepro`) stays private — GitHub release
// downloads inherit repo visibility, so they must come from a public repo.
// The bundle filenames embed the version (e.g. `TimePro_0.1.0_aarch64.dmg`), so we
// resolve the *latest* release's assets by pattern rather than hard-coding a version.
const DOWNLOADS_REPO = 'systemsd/timepro-downloads';
const RELEASES_URL = `https://github.com/${DOWNLOADS_REPO}/releases`;
const LATEST_API = `https://api.github.com/repos/${DOWNLOADS_REPO}/releases/latest`;
// The browser extension is loaded unpacked (MV3, no build) — it isn't a release artifact.
const EXTENSION_URL = `https://github.com/systemsd/timepro/tree/main/apps/extension`;

type Assets = {
  macArm?: string;
  macIntel?: string;
  windows?: string;
  linux?: string;
};

type ReleaseAsset = { name: string; browser_download_url: string };

export default function DownloadPage() {
  const { session, checked } = useSession();
  const [os, setOs] = useState<'mac' | 'windows' | 'linux' | 'other'>('other');
  const [assets, setAssets] = useState<Assets>({});
  const [tag, setTag] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    const p = navigator.platform.toLowerCase() + ' ' + navigator.userAgent.toLowerCase();
    if (p.includes('mac')) setOs('mac');
    else if (p.includes('win')) setOs('windows');
    else if (p.includes('linux')) setOs('linux');
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) throw new Error(`github ${res.status}`);
        const data = (await res.json()) as { tag_name?: string; assets?: ReleaseAsset[] };
        const list = data.assets ?? [];
        const url = (pred: (a: ReleaseAsset) => boolean) => list.find(pred)?.browser_download_url;
        const next: Assets = {
          macArm: url((a) => a.name.endsWith('.dmg') && a.name.includes('aarch64')),
          macIntel: url((a) => a.name.endsWith('.dmg') && /x64|x86_64/.test(a.name)),
          windows: url((a) => a.name.endsWith('.exe')) ?? url((a) => a.name.endsWith('.msi')),
          linux: url((a) => a.name.endsWith('.AppImage')) ?? url((a) => a.name.endsWith('.deb')),
        };
        if (cancelled) return;
        const any = Object.values(next).some(Boolean);
        setAssets(next);
        setTag(data.tag_name ?? null);
        setState(any ? 'ready' : 'unavailable');
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  // Render an enabled download button, or a disabled placeholder when that target has no asset yet.
  const btn = (url: string | undefined, label: string) =>
    url ? (
      <a className="dl-btn" href={url}>
        ↓ {label}
      </a>
    ) : (
      <span className="dl-btn" style={{ opacity: 0.5, cursor: 'not-allowed' }} aria-disabled="true">
        ↓ {label}
      </span>
    );

  const sideLink = (url: string | undefined, label: string) =>
    url ? <a href={url}>{label}</a> : <span className="muted">{label} — not yet available</span>;

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

          {state === 'loading' ? (
            <p className="muted">Checking for the latest release…</p>
          ) : state === 'unavailable' ? (
            <p className="hint">
              No published release is available yet. You can grab the latest installers from the{' '}
              <a href={RELEASES_URL}>GitHub Releases page</a>, or build locally with{' '}
              <code>pnpm --filter @timepro/desktop tauri:build</code>.
            </p>
          ) : os === 'mac' ? (
            <div className="dl-buttons">
              {btn(assets.macArm, 'Download for Apple Silicon')}
              {btn(assets.macIntel, 'Download for Intel Macs')}
            </div>
          ) : os === 'windows' ? (
            <div className="dl-buttons">{btn(assets.windows, 'Download for Windows')}</div>
          ) : os === 'linux' ? (
            <div className="dl-buttons">{btn(assets.linux, 'Download for Linux')}</div>
          ) : (
            <div className="dl-buttons">
              {btn(assets.macArm, 'macOS')}
              {btn(assets.windows, 'Windows')}
              {btn(assets.linux, 'Linux')}
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
            These installers are <strong>unsigned</strong>. On first launch, approve the app: on macOS
            right-click the app → <strong>Open</strong> (or allow it in System Settings → Privacy &amp;
            Security); on Windows click <strong>More info</strong> → <strong>Run anyway</strong> in SmartScreen.
            {tag ? <> Latest release: <strong>{tag}</strong>.</> : null}
          </p>
        </main>

        <aside className="dl-side">
          <div className="dl-side-item"><div className="dl-side-h">Need Windows version?</div>{sideLink(assets.windows, 'Download Windows application')}</div>
          <div className="dl-side-item"><div className="dl-side-h">Need Linux version?</div>{sideLink(assets.linux, 'Download Linux application')}</div>
          <div className="dl-side-item"><div className="dl-side-h">Need browser extension?</div><a href={EXTENSION_URL}>Get the browser extension</a></div>
        </aside>
      </div>
    </div>
  );
}
