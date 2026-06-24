import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ipc } from '../ipc';
import type { Project, ScreenshotUploadEvent, Session, TimerView } from '../types';
import { ChevronDown, GearIcon, KebabIcon, PlayIcon, StopIcon } from '../icons';

interface Props {
  session: Session;
  onLogout: () => Promise<void>;
  onOpenSettings: () => void;
}

const LS_TASK = 'tf_task';
const LS_PROJECT = 'tf_project';
const LS_AUTOSTART = 'tf_autostart';

export function Timer({ session, onLogout, onOpenSettings }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(
    () => localStorage.getItem(LS_PROJECT) || null,
  );
  const [task, setTask] = useState(() => localStorage.getItem(LS_TASK) || '');
  const [timer, setTimer] = useState<TimerView | null>(null);
  const [pausedReason, setPausedReason] = useState<'idle' | 'suspended' | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [projMenuOpen, setProjMenuOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const autoStartTried = useRef(false);

  const running = !!timer;
  // Idle / sleep auto-pause closes the entry server-side but, per the team, the
  // tracker should *read* as "Paused" (resumable) rather than "Stopped".
  const paused = !running && pausedReason !== null;
  const statusLabel = running
    ? 'Tracking'
    : paused
      ? pausedReason === 'suspended' ? 'Paused — asleep' : 'Paused — idle'
      : 'Stopped';
  const statusClass = running ? 'tracking' : paused ? 'paused' : 'stopped';

  const project = useMemo(
    () => projects.find((p) => p.id === selectedProject) ?? null,
    [projects, selectedProject],
  );

  // initial load
  useEffect(() => {
    (async () => {
      try {
        const [ps, cur] = await Promise.all([ipc.listProjects(), ipc.timerCurrent()]);
        setProjects(ps);
        if (cur) {
          setTimer(cur);
          if (cur.project_id) setSelectedProject(cur.project_id);
        }
      } catch (err) {
        setError(asMessage(err));
      }
    })();
  }, []);

  // reflect tracking state in the native window title
  useEffect(() => {
    getCurrentWindow()
      .setTitle(`${statusLabel} — TimePro`)
      .catch(() => {});
  }, [statusLabel]);

  // elapsed ticker
  useEffect(() => {
    const id = setInterval(() => {
      if (timer) {
        const startedMs = Date.parse(timer.started_at);
        setElapsed(Math.max(0, Math.floor((Date.now() - startedMs) / 1000)));
      } else {
        setElapsed(0);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [timer]);

  // auto-capture + auto-pause notifications from the Rust capture loop
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    (async () => {
      unlisteners.push(
        await listen<ScreenshotUploadEvent>('screenshot:uploaded', () => {
          showToast('Screenshot taken');
        }),
      );
      // Idle/sleep auto-pause closes the timer server-side; show it as "Paused"
      // (resumable) here so the window doesn't read as a hard "Stopped".
      unlisteners.push(
        await listen<{ reason?: string; seconds?: number }>('timer:auto-paused', (e) => {
          setTimer(null);
          const reason = e.payload?.reason === 'suspended' ? 'suspended' : 'idle';
          setPausedReason(reason);
          showToast(
            reason === 'suspended'
              ? 'Tracking paused — your computer was asleep'
              : 'Tracking paused — you were idle',
          );
        }),
      );
    })();
    return () => unlisteners.forEach((u) => u());
  }, []);

  // persist task + project selection
  useEffect(() => {
    localStorage.setItem(LS_TASK, task);
  }, [task]);
  useEffect(() => {
    if (selectedProject) localStorage.setItem(LS_PROJECT, selectedProject);
    else localStorage.removeItem(LS_PROJECT);
  }, [selectedProject]);

  // auto-start tracking on launch when the user opted in
  useEffect(() => {
    if (autoStartTried.current) return;
    if (projects.length === 0) return; // wait for load
    autoStartTried.current = true;
    const wants = localStorage.getItem(LS_AUTOSTART) === '1';
    if (wants && !timer) {
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await ipc.timerStart(selectedProject, task.trim() || null);
      setTimer(t);
      setPausedReason(null);
    } catch (err) {
      setError(asMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await ipc.timerStop();
      setTimer(null);
      setPausedReason(null);
    } catch (err) {
      const msg = asMessage(err);
      // If the timer was already closed (e.g. idle auto-pause stopped it
      // server-side), Stop is effectively a no-op — just reset to Stopped
      // instead of surfacing a scary "no_running_timer" error.
      if (/no_running_timer/i.test(msg)) {
        setTimer(null);
        setPausedReason(null);
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const viewOnline = async () => {
    setError(null);
    try {
      await ipc.viewOnline();
      showToast('Opening dashboard in your browser…');
    } catch (err) {
      setError(asMessage(err));
    }
  };

  const now = new Date();
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
  const dateStr = now.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const { hours, minutes } = splitHM(elapsed);

  return (
    <div className="app" onClick={() => { setMenuOpen(false); setProjMenuOpen(false); }}>
      <header className="app-header">
        <div className="user">
          <span className="user-name">{session.display_name}</span>
          <span className="org">{session.organization_name}</span>
          <button className="chev" aria-label="account"><ChevronDown /></button>
        </div>
        <div className="header-actions">
          <button className="icon-btn" aria-label="settings" onClick={onOpenSettings}>
            <GearIcon />
          </button>
          <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" aria-label="menu" onClick={() => setMenuOpen((v) => !v)}>
              <KebabIcon />
            </button>
            {menuOpen && (
              <div className="menu">
                <button onClick={onOpenSettings}>Settings</button>
                <button onClick={onLogout}>Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="control-band" onClick={(e) => e.stopPropagation()}>
        <div className="task-field">
          <input
            className="task-input"
            placeholder="What are you working on?"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            disabled={busy}
          />
          <button
            className={`project-chip ${project ? '' : 'empty'}`}
            style={project ? { background: project.color } : undefined}
            onClick={() => setProjMenuOpen((v) => !v)}
          >
            {project ? project.name : 'Select project'}
          </button>
        </div>

        <button
          className="round-btn play"
          aria-label="start"
          onClick={start}
          disabled={running || busy}
        >
          <PlayIcon />
        </button>
        <button
          className="round-btn stop"
          aria-label="stop"
          onClick={stop}
          disabled={!running || busy}
        >
          <StopIcon />
        </button>

        {projMenuOpen && (
          <div className="proj-menu">
            <button onClick={() => { setSelectedProject(null); setProjMenuOpen(false); }}>
              <span className="dot" style={{ background: '#c4c8cd' }} />
              No project
            </button>
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => { setSelectedProject(p.id); setProjMenuOpen(false); }}
              >
                <span className="dot" style={{ background: p.color }} />
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <main className="today">
        <div className="today-left">
          <div className={`tracker-status ${statusClass}`}>
            <span className="status-dot" />
            {statusLabel}
            {paused && (
              <button className="status-resume" onClick={start} disabled={busy}>Resume</button>
            )}
          </div>
          <div className="today-label">TODAY</div>
          <div className={`today-time ${running ? 'running' : ''}`}>
            <span>{hours}</span>
            <span className="colon">:</span>
            <span>{minutes}</span>
          </div>
          <button className="view-online" onClick={viewOnline}>view online</button>
        </div>
        <div className="today-right">
          <div className="weekday">{weekday}</div>
          <div className="date">{dateStr}</div>
        </div>
      </main>

      {error && <div className="error" style={{ margin: '0 22px 16px' }}>{error}</div>}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function splitHM(totalSeconds: number): { hours: number; minutes: string } {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return { hours, minutes: String(minutes).padStart(2, '0') };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
