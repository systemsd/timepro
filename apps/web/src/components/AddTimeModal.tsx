'use client';

import { useEffect, useState } from 'react';
import {
  createTimeEntry,
  getAssignableProjects,
  type AssignableProject,
} from '@/lib/api';
import { Button, ChevronDownIcon, ClockIcon, Modal } from '@timepro/ui';
import { pad } from '@/lib/format';

/** A local calendar date ('YYYY-MM-DD') + wall-clock 'HH:MM' → ISO (viewer's tz). */
const localIso = (dateStr: string, hm: string) => {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return new Date(y ?? 1970, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, 0, 0).toISOString();
};
const fmtDur = (secs: number) => {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h ${pad(m)}m`;
};

/**
 * "Add Offline Time" modal — record a block of time the agent never tracked
 * (e.g. worked with the app closed). Posts a manual `time_entry`; the server
 * enforces the RBAC + `time.allow_offline` gate, rejects overlaps/future times.
 */
export function AddTimeModal({
  userId,
  defaultDate,
  onClose,
  onSaved,
}: {
  userId: string;
  defaultDate: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [projects, setProjects] = useState<AssignableProject[]>([]);
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [projectId, setProjectId] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAssignableProjects(userId).then((r) => setProjects(r.projects)).catch(() => {});
  }, [userId]);

  const startIso = localIso(date, start);
  const endIso = localIso(date, end);
  const durSecs = (Date.parse(endIso) - Date.parse(startIso)) / 1000;
  const rangeInvalid = Date.parse(endIso) <= Date.parse(startIso);

  const save = async () => {
    setError(null);
    if (rangeInvalid) { setError('Start must be before end.'); return; }
    setBusy(true);
    try {
      await createTimeEntry({
        user_id: userId,
        project_id: projectId || null,
        description: description || null,
        started_at: startIso,
        ended_at: endIso,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Offline Time"
      width={480}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || rangeInvalid} onClick={save}>Add Time</Button>
        </>
      }
    >
      <div className="et-body">
        <p className="et-lead">Record time you worked while the app wasn&apos;t tracking. It&apos;s saved as a manual entry.</p>

        <div className="et-group">
          <span className="et-label">Date</span>
          <div className="et-select">
            <input type="date" value={date} aria-label="Date" onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <div className="et-group">
          <span className="et-label">Time range</span>
          <div className="et-timerow">
            <div className="et-field">
              <ClockIcon size={15} />
              <input type="time" value={start} aria-label="Start time" onChange={(e) => setStart(e.target.value)} />
            </div>
            <span className="et-dash">–</span>
            <div className="et-field">
              <ClockIcon size={15} />
              <input type="time" value={end} aria-label="End time" onChange={(e) => setEnd(e.target.value)} />
            </div>
            <span className="et-dur">{rangeInvalid ? '—' : fmtDur(durSecs)}</span>
          </div>
          <p className="et-hint">Times are in your local timezone.</p>
        </div>

        <div className="et-group">
          <span className="et-label">Project</span>
          <div className="et-select">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
              <option value="">— No project —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
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
      </div>
    </Modal>
  );
}
