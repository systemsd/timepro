'use client';

import { useEffect, useState } from 'react';
import { Button, Select } from '@timepro/ui';
import {
  getMemberVisibility,
  setMemberVisibility,
  type MemberVisibility,
  type TeamMember,
} from '@/lib/api';

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/**
 * Admin control on the Team page: shows a member's OpsCore reporting line (which
 * already lets them see everyone below them) and lets an admin grant view-only
 * access to anyone else in the org.
 */
export function ActivityVisibility({ userId, members }: { userId: string; members: TeamMember[] }) {
  const [vis, setVis] = useState<MemberVisibility | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    setVis(null);
    setMsg(null);
    getMemberVisibility(userId)
      .then((v) => {
        if (!live) return;
        setVis(v);
        setSelected(v.grants.map((g) => g.user_id));
      })
      .catch((e) => live && setMsg({ kind: 'error', text: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [userId]);

  const saved = vis?.grants.map((g) => g.user_id) ?? [];
  const dirty = !sameSet(selected, saved);
  const options = members
    .filter((m) => m.user_id !== userId)
    .map((m) => ({ id: m.user_id, name: m.display_name || m.email }));

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await setMemberVisibility(userId, selected);
      const v = await getMemberVisibility(userId);
      setVis(v);
      setSelected(v.grants.map((g) => g.user_id));
      setMsg({ kind: 'ok', text: 'Saved' });
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h3 className="section-h">Activity visibility</h3>
      {!vis ? (
        msg?.kind === 'error' ? <div className="error">{msg.text}</div> : <div className="muted">Loading…</div>
      ) : (
        <div className="vis">
          <div className="vis-line">
            <span className="vis-label">Reports to</span>
            <span>{vis.reports_to ? vis.reports_to.display_name : <span className="muted">No one (top of the reporting line)</span>}</span>
          </div>
          <div className="vis-line">
            <span className="vis-label">Sees automatically</span>
            <span>
              {vis.subordinate_count === 0
                ? <span className="muted">No one reports to them</span>
                : `${vis.subordinate_count} ${vis.subordinate_count === 1 ? 'person' : 'people'} below them in the reporting line`}
            </span>
          </div>
          <p className="muted small vis-note">
            The reporting line comes from OpsCore. Below, grant view access to anyone else —
            they&apos;ll see timelines, screenshots and reports, but can&apos;t edit or delete anything.
          </p>
          <Select
            multiple
            placeholder="Also allow them to view…"
            ariaLabel="Members this person may also view"
            options={options}
            value={selected}
            onChange={setSelected}
          />
          <div className="vis-actions">
            <Button variant="primary" size="sm" onClick={save} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save access'}
            </Button>
            {msg && <span className={msg.kind === 'ok' ? 'sync-msg' : 'vis-error'}>{msg.text}</span>}
          </div>
        </div>
      )}
    </>
  );
}
