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
import { Button, ChevronDownIcon, ClockIcon, ConfirmModal, Modal, PlusIcon } from '@timepro/ui';
import { pad } from '@/lib/format';
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitAt, setSplitAt] = useState(toHM(activity.started_at));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAssignableProjects(userId).then((r) => setProjects(r.projects)).catch(() => {});
    getTimeEntryHistory(activity.id).then((r) => setHistory(r.history)).catch(() => {});
  }, [activity.id, userId]);

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

  const performDelete = async () => {
    setError(null);
    setConfirmDelete(false);
    setBusy(true);
    try { await deleteTimeEntry(activity.id); onSaved(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  const save = async () => {
    setError(null);
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
    <>
      <Modal
        open={!confirmDelete}
        onClose={onClose}
        title="Edit Time"
        width={480}
        footer={
          <>
            <Button variant="danger" disabled={busy} style={{ marginRight: 'auto' }} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy || rangeInvalid} onClick={save}>Save Changes</Button>
          </>
        }
      >
        <div className="et-body">
        <p className="et-lead">Trim the time range, change the project or note, or split this activity into two.</p>

        <div className="et-group">
          <span className="et-label">Time range</span>
          <div className="et-timerow">
            <div className={`et-field ${running ? 'is-disabled' : ''}`}>
              <ClockIcon size={15} />
              <input type="time" value={start} disabled={running} aria-label="Start time" onChange={(e) => setStart(e.target.value)} />
            </div>
            <span className="et-dash">–</span>
            <div className={`et-field ${running ? 'is-disabled' : ''}`}>
              <ClockIcon size={15} />
              <input type="time" value={end} disabled={running} aria-label="End time" onChange={(e) => setEnd(e.target.value)} />
            </div>
            <span className="et-dur">{running ? 'running' : durSecs != null ? fmtDur(durSecs) : '—'}</span>
          </div>
          <p className="et-hint">
            {running ? 'Stop the running timer to edit its times.' : 'Times are shown in your local timezone.'}
          </p>
        </div>

        <div className="et-group">
          <span className="et-label">Project</span>
          <div className="et-select">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
              <option value="">— No project —</option>
              {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <ChevronDownIcon size={16} className="et-chev" />
          </div>
        </div>

        <div className="et-group">
          <span className="et-label">Description</span>
          <div className="et-ta">
            <textarea
              value={description}
              rows={3}
              maxLength={500}
              placeholder="What did you work on?"
              onChange={(e) => setDescription(e.target.value)}
            />
            <span className="et-counter">{description.length} / 500</span>
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        {!running && (
          <button type="button" className="et-split-toggle" onClick={() => setSplitOpen((v) => !v)}>
            <PlusIcon size={14} /> Split activity
          </button>
        )}

        {splitOpen && !running && (
          <div className="et-split">
            <span className="et-split-lbl">Split at</span>
            <div className="et-field et-field--sm">
              <ClockIcon size={14} />
              <input type="time" value={splitAt} aria-label="Split time" onChange={(e) => setSplitAt(e.target.value)} />
            </div>
            <Button variant="secondary" size="sm" disabled={busy} onClick={doSplit}>Split</Button>
          </div>
        )}

        {history.length > 0 && (
          <div className="et-hist">
            <span className="et-label">
              Edit history <span className="et-hist-count">{history.length} change{history.length > 1 ? 's' : ''}</span>
            </span>
            <ul className="et-timeline">
              {history.map((h, i) => (
                <li className="et-tl" key={i}>
                  <div className="et-rail">
                    <span className={`et-dot ${historyKind(h)}`} />
                    <span className="et-line" />
                  </div>
                  <div className="et-tl-content">
                    <div className="et-tl-title">
                      {historyLabel(h)}
                      {historyKind(h) === 'system' && <span className="et-tag system">Auto</span>}
                    </div>
                    <div className="et-tl-meta">
                      {h.actor_name ?? (historyKind(h) === 'system' ? 'System' : 'Someone')} · {formatWhen(h.at)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        </div>
      </Modal>

      <ConfirmModal
        open={confirmDelete}
        title="Delete activity?"
        message="This removes the activity and its tracked time. It can't be undone."
        confirmLabel="Delete"
        danger
        onConfirm={performDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

/** Plain-English summary of an audit action (no raw `time_entry.*` codes). */
function historyLabel(h: TimeEntryHistory): string {
  if (h.action === 'time_entry.auto_closed') return 'End time auto-adjusted to the last recorded activity';
  if (h.action === 'time_entry.split') return 'Split into two activities';
  if (h.action === 'time_entry.delete') return 'Activity deleted';
  if (h.action === 'time_entry.update') {
    const ch = (h.metadata?.changes ?? {}) as Record<string, unknown>;
    const parts: string[] = [];
    if ('started_at' in ch || 'ended_at' in ch) parts.push('time range');
    if ('project_id' in ch) parts.push('project');
    if ('description' in ch) parts.push('note');
    return parts.length ? `Changed ${parts.join(', ')}` : 'Edited';
  }
  return h.action.replace(/^time_entry\./, '').replace(/_/g, ' ');
}

type HistoryKind = 'system' | 'edit' | 'split' | 'delete';
function historyKind(h: TimeEntryHistory): HistoryKind {
  if (h.action === 'time_entry.auto_closed') return 'system';
  if (h.action === 'time_entry.split') return 'split';
  if (h.action === 'time_entry.delete') return 'delete';
  return 'edit';
}

/** e.g. "3 Jul 2026, 1:39 PM". */
function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
