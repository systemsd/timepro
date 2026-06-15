'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import {
  clearUserSetting,
  getSettingsCatalog,
  getTeamMembers,
  getUserSettings,
  setOrgSetting,
  setUserSetting,
  type SettingDef,
  type SettingValue,
  type TeamMember,
} from '@/lib/api';

export default function SettingsPage() {
  const { session, checked } = useSession();
  const [catalog, setCatalog] = useState<SettingDef[]>([]);
  const [orgDefaults, setOrgDefaults] = useState<Record<string, SettingValue>>({});
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cat, mem] = await Promise.all([getSettingsCatalog(), getTeamMembers()]);
      setCatalog(cat.catalog);
      setOrgDefaults(cat.org_defaults);
      setMembers(mem.members);
      if (cat.catalog.length > 0) setSelectedKey((k) => k ?? cat.catalog[0]!.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { if (checked && session) void load(); }, [checked, session, load]);

  const selected = useMemo(() => catalog.find((s) => s.key === selectedKey) ?? null, [catalog, selectedKey]);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  const saveOrg = async (key: string, value: SettingValue) => {
    setOrgDefaults((d) => ({ ...d, [key]: value }));
    try {
      await setOrgSetting(key, value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void load();
    }
  };

  return (
    <div className="page">
      <TopNav session={session} active="settings" />
      <div className="team-band"><h1>Settings</h1></div>

      <div className="team-layout">
        <aside className="team-list">
          {error && <div className="error">{error}</div>}
          <ul>
            {catalog.map((s) => (
              <li
                key={s.key}
                className={`set-row ${selectedKey === s.key ? 'selected' : ''}`}
                onClick={() => setSelectedKey(s.key)}
              >
                <span className="set-label">{s.label}</span>
                <span className="set-value">{display(s, orgDefaults[s.key] ?? s.default)}</span>
              </li>
            ))}
          </ul>
        </aside>

        <section className="team-detail">
          {selected && (
            <SettingDetail
              key={selected.key}
              def={selected}
              orgValue={orgDefaults[selected.key] ?? selected.default}
              members={members}
              onSaveOrg={(v) => saveOrg(selected.key, v)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function SettingDetail({
  def,
  orgValue,
  members,
  onSaveOrg,
}: {
  def: SettingDef;
  orgValue: SettingValue;
  members: TeamMember[];
  onSaveOrg: (v: SettingValue) => void;
}) {
  return (
    <>
      <h2 className="set-h">{def.label}</h2>
      {def.description && <div className="set-desc">{def.description}</div>}

      <div className="set-editor">
        <ValueEditor def={def} value={orgValue} onChange={onSaveOrg} />
        {def.enforced_by && !['display'].includes(def.enforced_by) && (
          <span className="set-enforce">
            {ENFORCED[def.enforced_by] ?? ''}
          </span>
        )}
      </div>

      {def.overridable ? (
        <>
          <h3 className="section-h">Individual settings</h3>
          <p className="muted small">If enabled, the individual setting will be used instead of the team setting.</p>
          <div className="indiv-list">
            {members.filter((m) => !m.is_owner).map((m) => (
              <IndividualRow key={m.user_id} member={m} def={def} orgValue={orgValue} />
            ))}
          </div>
        </>
      ) : (
        <p className="muted small" style={{ marginTop: 18 }}>This setting applies org-wide and can&apos;t be overridden per user.</p>
      )}
    </>
  );
}

function IndividualRow({
  member,
  def,
  orgValue,
}: {
  member: TeamMember;
  def: SettingDef;
  orgValue: SettingValue;
}) {
  const [overridden, setOverridden] = useState<boolean | null>(null);
  const [value, setValue] = useState<SettingValue>(orgValue);

  useEffect(() => {
    let alive = true;
    getUserSettings(member.user_id)
      .then((s) => {
        if (!alive) return;
        setOverridden(!!s.overridden[def.key]);
        setValue(s.effective[def.key] ?? orgValue);
      })
      .catch(() => setOverridden(false));
    return () => { alive = false; };
  }, [member.user_id, def.key, orgValue]);

  const toggle = async (on: boolean) => {
    setOverridden(on);
    try {
      if (on) await setUserSetting(member.user_id, def.key, value);
      else await clearUserSetting(member.user_id, def.key);
    } catch {
      setOverridden(!on);
    }
  };
  const change = async (v: SettingValue) => {
    setValue(v);
    try { await setUserSetting(member.user_id, def.key, v); } catch { /* noop */ }
  };

  return (
    <div className="indiv-row">
      <span
        className={`switch ${overridden ? 'on' : 'off'}`}
        onClick={() => overridden !== null && toggle(!overridden)}
      >
        <span className="knob">{overridden ? '✓' : '✕'}</span>
      </span>
      <span className="indiv-name">{member.display_name || member.email}</span>
      {overridden && (
        <span className="indiv-editor">
          <ValueEditor def={def} value={value} onChange={change} compact />
        </span>
      )}
    </div>
  );
}

function ValueEditor({
  def,
  value,
  onChange,
  compact,
}: {
  def: SettingDef;
  value: SettingValue;
  onChange: (v: SettingValue) => void;
  compact?: boolean;
}) {
  if (def.type === 'bool') {
    return (
      <select
        className="set-input"
        value={value ? 'yes' : 'no'}
        onChange={(e) => onChange(e.target.value === 'yes')}
      >
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  }
  if (def.type === 'number') {
    return (
      <span className="set-num">
        <input
          className="set-input"
          type="number"
          min={def.min}
          max={def.max}
          value={Number(value)}
          style={{ width: compact ? 70 : 90 }}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {def.unit && <span className="set-unit">{def.unit}</span>}
      </span>
    );
  }
  return (
    <select className="set-input" value={String(value)} onChange={(e) => onChange(e.target.value)}>
      {def.options?.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

const ENFORCED: Record<string, string> = {
  activity: '— takes effect once activity tracking ships',
  app_url: '— takes effect once app & URL tracking ships',
  offline_time: '— takes effect once offline time ships',
  limits: '— enforcement ships with reports',
};

function display(def: SettingDef, value: SettingValue): string {
  if (def.type === 'bool') return value ? 'Yes' : 'No';
  if (def.type === 'number') return `${value}${def.unit ?? ''}`;
  const opt = def.options?.find((o) => o.value === value);
  return opt?.label ?? String(value);
}
