'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  deleteTimeEntry,
  getAssignableProjects,
  getTimeEntryHistory,
  splitTimeEntry,
  updateTimeEntry,
  type AssignableProject,
  type TimeEntryHistory,
  type TimelineActivity,
} from '@/lib/api';
import { CloseIcon } from '@/components/icons';

const pad = (n: number) => String(n).padStart(2, '0');
const toHM = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** Replace just the H:M of `refIso` (keeps its calendar date) → ISO. */
const withHM = (refIso: string, hm: string) => {
  const d = new Date(refIso);
  const [h, m] = hm.split(':').map(Number);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.toISOString();
};
const fmtDur = (secs: number) => {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h ${pad(m)}m`;
};

/**
 * The "Edit Time" modal (scrin.io-style): trim an activity's start/end, change
 * its project or note, split it in two, or delete it — plus its edit history.
 */
export function EditActivityModal({
  activity,
  userId,
  onClose,
  onSaved,
}: {
  activity: TimelineActivity;
  userId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const running = activity.ended_at === null;
  const [projects, setProjects] = useState<AssignableProject[]>([]);
  const [history, setHistory] = useState<TimeEntryHistory[]>([]);
  const [projectId, setProjectId] = useState(activity.project_id ?? '');
  const [description, setDescription] = useState(activity.description ?? '');
  const [start, setStart] = useState(toHM(activity.started_at));
  const [end, setEnd] = useState(activity.ended_at ? toHM(activity.ended_at) : '');
  const [markDelete, setMarkDelete] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitAt, setSplitAt] = useState(toHM(activity.started_at));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAssignableProjects(userId).then((r) => setProjects(r.projects)).catch(() => {});
    getTimeEntryHistory(activity.id).then((r) => setHistory(r.history)).catch(() => {});
  }, [activity.id, userId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const newStartIso = withHM(activity.started_at, start);
  const newEndIso = running || !end ? null : withHM(activity.ended_at!, end);
  const durSecs = newEndIso ? (Date.parse(newEndIso) - Date.parse(newStartIso)) / 1000 : null;
  const rangeInvalid = newEndIso !== null && Date.parse(newEndIso) <= Date.parse(newStartIso);

  // Always show the entry's current project, even if the user is no longer a member.
  const projectOptions = useMemo(() => {
    const opts = projects.map((p) => ({ id: p.id, name: p.name }));
    if (activity.project_id && !opts.some((o) => o.id === activity.project_id)) {
      opts.unshift({ id: activity.project_id, name: activity.project_name ?? 'Current project' });
    }
    return opts;
  }, [projects, activity.project_id, activity.project_name]);

  const save = async () => {
    setError(null);
    if (markDelete) {
      if (!window.confirm('Delete this activity? This removes its tracked time.')) return;
      setBusy(true);
      try { await deleteTimeEntry(activity.id); onSaved(); onClose(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
      return;
    }
    if (rangeInvalid) { setError('Start must be before end.'); return; }
    const patch: Parameters<typeof updateTimeEntry>[1] = {};
    if ((projectId || null) !== (activity.project_id ?? null)) patch.project_id = projectId || null;
    if ((description || null) !== (activity.description ?? null)) patch.description = description || null;
    if (!running) {
      if (newStartIso !== activity.started_at) patch.started_at = newStartIso;
      if (newEndIso && newEndIso !== activity.ended_at) patch.ended_at = newEndIso;
    }
    if (Object.keys(patch).length === 0) { onClose(); return; }
    setBusy(true);
    try { await updateTimeEntry(activity.id, patch); onSaved(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  const doSplit = async () => {
    setError(null);
    const at = withHM(activity.started_at, splitAt);
    const tEnd = activity.ended_at ? Date.parse(activity.ended_at) : Infinity;
    if (Date.parse(at) <= Date.parse(activity.started_at) || Date.parse(at) >= tEnd) {
      setError('Split time must be inside the activity.');
      return;
    }
    setBusy(true);
    try { await splitTimeEntry(activity.id, at); onSaved(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <div className="act-modal" onClick={onClose} role="dialog" aria-modal="true">
      <div className="act-card" onClick={(e) => e.stopPropagation()}>
        <div className="act-head">
          <h3>Edit Time</h3>
          <button className="act-x" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
        </div>
        <p className="act-sub">Trim the time range, change the project or note, split, or delete.</p>

        <div className="act-times">
          <input type="time" value={start} disabled={running} onChange={(e) => setStart(e.target.value)} />
          <span>–</span>
          <input type="time" value={end} disabled={running} onChange={(e) => setEnd(e.target.value)} />
          <span className="act-dur">{running ? 'running' : durSecs != null ? fmtDur(durSecs) : '—'}</span>
        </div>
        {running && <p className="act-note">Stop the running timer to edit its times.</p>}

        <label className="act-label">Project</label>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">— No project —</option>
          {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <label className="act-label">Description</label>
        <textarea
          value={description}
          rows={2}
          maxLength={500}
          placeholder="What was this activity?"
          onChange={(e) => setDescription(e.target.value)}
        />

        {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}

        <div className="act-row-between">
          <label className="act-del">
            <input type="checkbox" checked={markDelete} onChange={(e) => setMarkDelete(e.target.checked)} />
            Delete this activity
          </label>
          {!running && (
            <button type="button" className="act-link" onClick={() => setSplitOpen((v) => !v)}>
              Split Activity
            </button>
          )}
        </div>

        {splitOpen && !running && (
          <div className="act-split">
            <span>Split at</span>
            <input type="time" value={splitAt} onChange={(e) => setSplitAt(e.target.value)} />
            <button type="button" className="act-btn" disabled={busy} onClick={doSplit}>Split</button>
          </div>
        )}

        {history.length > 0 && (
          <details className="act-history">
            <summary>Edit history ({history.length})</summary>
            <ul>
              {history.map((h, i) => (
                <li key={i}>
                  <span className="act-hist-action">{historyLabel(h)}</span>
                  <span className="act-hist-meta">{h.actor_name ?? 'someone'} · {new Date(h.at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="act-actions">
          <button type="button" className="act-btn primary" disabled={busy || (!markDelete && rangeInvalid)} onClick={save}>
            Save Changes
          </button>
          <button type="button" className="act-btn" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function historyLabel(h: TimeEntryHistory): string {
  if (h.action === 'time_entry.split') return 'Split';
  if (h.action === 'time_entry.delete') return 'Deleted';
  if (h.action === 'time_entry.update') {
    const ch = (h.metadata?.changes ?? {}) as Record<string, unknown>;
    const fields = Object.keys(ch).map((k) => k.replace(/_/g, ' '));
    return fields.length ? `Edited ${fields.join(', ')}` : 'Edited';
  }
  return h.action;
}
