import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ipc } from '../ipc';
import type {
  Product,
  Project,
  ScreenshotUploadEvent,
  Session,
  Task,
  TimerView,
  TrackingContext,
} from '../types';
import { ChevronDown, GearIcon, KebabIcon, PlayIcon, StopIcon } from '../icons';

interface Props {
  session: Session;
  onLogout: () => Promise<void>;
  onOpenSettings: () => void;
}

const LS_TASK = 'tf_task';
/** Legacy key: a bare project uuid. Superseded by LS_CONTEXT; still read once. */
const LS_PROJECT = 'tf_project';
const LS_CONTEXT = 'tf_context';
const LS_TASKID = 'tf_task_id';
const LS_AUTOSTART = 'tf_autostart';

/**
 * Restore the picker selection, migrating the pre-products `tf_project` key
 * (a bare project uuid) to the `{kind, id}` shape. Written back on the first
 * selection change, so the old key just fades out.
 */
function loadContext(): TrackingContext | null {
  const raw = localStorage.getItem(LS_CONTEXT);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as TrackingContext;
      if ((parsed?.kind === 'project' || parsed?.kind === 'product') && parsed.id) return parsed;
    } catch {
      /* corrupt value → fall through to the legacy key */
    }
  }
  const legacy = localStorage.getItem(LS_PROJECT);
  return legacy ? { kind: 'project', id: legacy } : null;
}

export function Timer({ session, onLogout, onOpenSettings }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [context, setContext] = useState<TrackingContext | null>(loadContext);
  const [task, setTask] = useState(() => localStorage.getItem(LS_TASK) || '');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(
    () => localStorage.getItem(LS_TASKID) || null,
  );
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  // tracking.require_task — when on, a task must be selected before Start.
  // Mirrors the server (which also enforces it); defaults off if the fetch fails
  // (the server stays authoritative, so this can only be over-permissive in UI).
  const [requireTask, setRequireTask] = useState(false);
  const [timer, setTimer] = useState<TimerView | null>(null);
  const [pausedReason, setPausedReason] = useState<'idle' | 'suspended' | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [projMenuOpen, setProjMenuOpen] = useState(false);
  // Both picker lists have answered — gates auto-start, which must not fire
  // before we know what the user can track (a products-only user has no projects).
  const [contextsLoaded, setContextsLoaded] = useState(false);
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

  // The selected project/product, whichever kind the context names. `label` and
  // `color` drive the one chip that fronts both lists.
  const selected = useMemo(() => {
    if (!context) return null;
    const row =
      context.kind === 'project'
        ? projects.find((p) => p.id === context.id)
        : products.find((p) => p.id === context.id);
    return row ? { name: row.name, color: row.color } : null;
  }, [context, projects, products]);
  const activeTask = useMemo(
    () => tasks.find((t) => t.id === selectedTask) ?? null,
    [tasks, selectedTask],
  );
  // When a task is required: no assigned tasks here → nothing to track; and Start
  // stays blocked until one is picked.
  const noTasksAvailable = requireTask && tasks.length === 0;
  const startBlocked = requireTask && !selectedTask;

  // initial load
  useEffect(() => {
    (async () => {
      try {
        const [ps, prods, cur] = await Promise.all([
          ipc.listProjects(),
          // Fail-soft: the agent auto-updates independently of the API deploy, so
          // a new agent can meet an API without /v1/products. An empty product
          // group must never take the projects list down with it.
          ipc.listProducts().catch(() => []),
          ipc.timerCurrent(),
        ]);
        setProjects(ps);
        setProducts(prods);
        setContextsLoaded(true);
        if (cur) {
          setTimer(cur);
          // Follow the running entry's attribution; keep the restored selection
          // when it tracks against nothing.
          const ctx = contextOf(cur);
          if (ctx) setContext(ctx);
        }
      } catch (err) {
        setError(asMessage(err));
      }
      // Best-effort: gate the picker on tracking.require_task. Failure → stay off.
      try {
        setRequireTask((await ipc.getSettings())['tracking.require_task'] === true);
      } catch {
        /* server still enforces on start */
      }
    })();
  }, []);

  // Load the OpsCore tasks for the selected context — a project, an internal
  // product, or the unattached bucket. Server-side these are scoped to the
  // signed-in resource (assignee/collaborator). Drop the current task selection
  // if it isn't in the new context's set.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      ipc
        .listTasks(
          context?.kind === 'product' ? null : (context?.id ?? 'none'),
          context?.kind === 'product' ? context.id : null,
        )
        .then((ts) => {
          if (cancelled) return;
          setTasks(ts);
          setSelectedTask((cur) => (cur && ts.some((t) => t.id === cur) ? cur : null));
        })
        .catch(() => {
          /* keep the current list — a transient fetch error shouldn't clear it */
        });
    void load();
    // Poll so a task assigned in OpsCore (synced server-side) appears here without
    // a logout/login. Cleared on context change / unmount.
    const id = setInterval(load, 45_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // Primitive deps: a fresh-but-equal context object (e.g. re-reading the
    // running timer) must not restart the poll.
  }, [context?.kind, context?.id]);

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

  // Re-validate against the SERVER while we think we're tracking. If the Rust
  // capture loop stalls (e.g. Windows sleep/wake where its auto-paused event never
  // fires), the entry can be closed server-side while the UI keeps counting a
  // false "Tracking". This runs on the JS thread (independent of that loop) and
  // hits the server (`timer_current`), so it catches it within ~30s.
  useEffect(() => {
    if (!timer) return;
    const id = setInterval(async () => {
      let server: TimerView | null;
      try {
        server = await ipc.timerCurrent();
      } catch {
        return; // network blip — keep state, retry next tick
      }
      if (!server) {
        // Server has no running timer → our local one is stale (closed by
        // sleep/sweep). Stop the false clock and offer to resume.
        setTimer(null);
        setPausedReason('suspended');
        showToast('Tracking stopped — press play to resume');
      } else if (server.time_entry_id !== timer.time_entry_id) {
        setTimer(server); // a fresh entry (e.g. auto-resume) — follow it
      }
    }, 30_000);
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
      // Idle auto-pause auto-resumes the instant input returns (the Rust loop
      // starts a fresh entry) — reflect it as Tracking again, no manual click.
      unlisteners.push(
        await listen<TimerView>('timer:auto-resumed', (e) => {
          if (e.payload) {
            setTimer(e.payload);
            const ctx = contextOf(e.payload);
            if (ctx) setContext(ctx);
          }
          setPausedReason(null);
          showToast('Tracking resumed');
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
    if (context) localStorage.setItem(LS_CONTEXT, JSON.stringify(context));
    else localStorage.removeItem(LS_CONTEXT);
    // The legacy project-only key is superseded either way.
    localStorage.removeItem(LS_PROJECT);
  }, [context]);
  useEffect(() => {
    if (selectedTask) localStorage.setItem(LS_TASKID, selectedTask);
    else localStorage.removeItem(LS_TASKID);
  }, [selectedTask]);

  // auto-start tracking on launch when the user opted in
  useEffect(() => {
    if (autoStartTried.current) return;
    if (!contextsLoaded) return; // wait for both picker lists
    autoStartTried.current = true;
    const wants = localStorage.getItem(LS_AUTOSTART) === '1';
    if (wants && !timer) {
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextsLoaded]);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      // Exactly one of the two is ever sent (the server 400s on both).
      const t = await ipc.timerStart(
        context?.kind === 'project' ? context.id : null,
        context?.kind === 'product' ? context.id : null,
        selectedTask,
        task.trim() || null,
      );
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
            className={`project-chip ${selected ? '' : 'empty'}`}
            style={selected ? { background: selected.color } : undefined}
            onClick={() => setProjMenuOpen((v) => !v)}
            title={selected?.name}
          >
            {selected ? selected.name : 'Select project'}
          </button>
          {/* Task picker. Shown whenever there are tasks here, or when a task is
              required (so the requirement is visible even with none available).
              When required and there are no tasks → nothing to track. */}
          {noTasksAvailable ? (
            <span className="task-chip empty" title="No tasks assigned to you">
              No tasks assigned
            </span>
          ) : (
            (tasks.length > 0 || requireTask) && (
              <button
                className={`task-chip ${activeTask ? '' : 'empty'}`}
                onClick={() => setTaskMenuOpen((v) => !v)}
                disabled={busy}
              >
                {activeTask ? activeTask.name : 'Select task'}
              </button>
            )
          )}
        </div>

        <button
          className="round-btn play"
          aria-label="start"
          onClick={start}
          disabled={running || busy || startBlocked}
          title={startBlocked ? 'Select an assigned task to start tracking' : undefined}
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

        {/* One picker, two labelled groups — client projects and internal
            products are peers in OpsCore, so neither nests under the other.
            The Internal Products group is omitted entirely when the user is on
            none, so nothing changes for project-only users. */}
        {projMenuOpen && (
          <div className="proj-menu">
            <button onClick={() => { setContext(null); setProjMenuOpen(false); }}>
              <span className="dot" style={{ background: '#c4c8cd' }} />
              No project
            </button>
            {projects.length > 0 && <div className="menu-group">Client Projects</div>}
            {projects.map((p) => (
              <button
                key={p.id}
                title={p.name}
                onClick={() => { setContext({ kind: 'project', id: p.id }); setProjMenuOpen(false); }}
              >
                <span className="dot" style={{ background: p.color }} />
                <span className="proj-name">{p.name}</span>
              </button>
            ))}
            {products.length > 0 && <div className="menu-group">Internal Products</div>}
            {products.map((p) => (
              <button
                key={p.id}
                title={`${p.name} — ${p.stage.toLowerCase()}`}
                onClick={() => { setContext({ kind: 'product', id: p.id }); setProjMenuOpen(false); }}
              >
                <span className="dot" style={{ background: p.color }} />
                <span className="proj-name">{p.name}</span>
              </button>
            ))}
          </div>
        )}

        {taskMenuOpen && (
          <div className="task-menu">
            {!requireTask && (
              <button onClick={() => { setSelectedTask(null); setTaskMenuOpen(false); }}>
                No task
              </button>
            )}
            {tasks.map((t) => (
              <button
                key={t.id}
                className="task-option"
                title={t.name}
                onClick={() => { setSelectedTask(t.id); setTaskMenuOpen(false); }}
              >
                <span className="task-name">{t.name}</span>
                <span className={`task-badge status-${t.status.toLowerCase()}`}>
                  {t.status.replace(/_/g, ' ').toLowerCase()}
                </span>
                <span className={`task-badge prio-${t.priority.toLowerCase()}`}>
                  {t.priority.toLowerCase()}
                </span>
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

/** The tracking context a server-side timer view is attributed to, if any. */
function contextOf(t: TimerView): TrackingContext | null {
  if (t.product_id) return { kind: 'product', id: t.product_id };
  if (t.project_id) return { kind: 'project', id: t.project_id };
  return null;
}

function splitHM(totalSeconds: number): { hours: number; minutes: string } {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return { hours, minutes: String(minutes).padStart(2, '0') };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
