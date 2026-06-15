'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { useSession } from '@/lib/useSession';
import {
  createSavedReport,
  deleteSavedReport,
  getReportFilters,
  getSavedReports,
  runReport,
  type GroupDim,
  type ReportFilters,
  type ReportGroupNode,
  type ReportResult,
  type ReportType,
  type RunReportInput,
  type SavedReport,
} from '@/lib/api';

// ---- date helpers (viewer-local) ----

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayLocal(): string {
  return fmt(new Date());
}
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return fmt(new Date(y, m - 1, d + n));
}
/** Monday of the week containing `date`. */
function weekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  const dow = (dt.getDay() + 6) % 7; // 0 = Monday
  return addDays(date, -dow);
}

type Preset =
  | 'today' | 'yesterday' | 'this_week' | 'last_week'
  | 'this_month' | 'last_month' | 'this_year' | 'last_year';

function presetRange(p: Preset): { from: string; to: string } {
  const now = new Date();
  const t = todayLocal();
  switch (p) {
    case 'today': return { from: t, to: t };
    case 'yesterday': return { from: addDays(t, -1), to: addDays(t, -1) };
    case 'this_week': { const ws = weekStart(t); return { from: ws, to: addDays(ws, 6) }; }
    case 'last_week': { const ws = addDays(weekStart(t), -7); return { from: ws, to: addDays(ws, 6) }; }
    case 'this_month': {
      const from = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
      const to = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0));
      return { from, to };
    }
    case 'last_month': {
      const from = fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      const to = fmt(new Date(now.getFullYear(), now.getMonth(), 0));
      return { from, to };
    }
    case 'this_year': return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
    case 'last_year': return { from: `${now.getFullYear() - 1}-01-01`, to: `${now.getFullYear() - 1}-12-31` };
  }
}

function hm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0 && m === 0) return seconds > 0 ? '<1m' : '0m';
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function dmy(date: string): string {
  const [y, m, d] = date.split('-') as [string, string, string];
  return `${d}/${m}/${y.slice(2)}`;
}
function weekdayShort(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' });
}

// ---- multi-select dropdown ----

function MultiSelect({
  placeholder, options, selected, onChange,
}: {
  placeholder: string;
  options: Array<{ id: string; name: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const label = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? options.find((o) => o.id === selected[0])?.name ?? `1 selected`
      : `${selected.length} selected`;
  return (
    <div className="rep-ms" ref={ref}>
      <button type="button" className={`rep-ms-btn ${selected.length ? 'has' : ''}`} onClick={() => setOpen((v) => !v)}>
        <span>{label}</span>
        <span className="rep-caret">▾</span>
      </button>
      {open && (
        <div className="rep-ms-menu">
          {selected.length > 0 && (
            <button type="button" className="rep-ms-clear" onClick={() => onChange([])}>Clear selection</button>
          )}
          {options.length === 0 && <div className="rep-ms-empty">None</div>}
          {options.map((o) => (
            <label key={o.id} className="rep-ms-item">
              <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
              {o.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- group table (recursive) ----

function GroupRows({ nodes, depth }: { nodes: ReportGroupNode[]; depth: number }) {
  return (
    <>
      {nodes.map((n) => <GroupRow key={`${n.dim}:${n.key ?? '∅'}:${depth}`} node={n} depth={depth} />)}
    </>
  );
}
function GroupRow({ node, depth }: { node: ReportGroupNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = !!node.children && node.children.length > 0;
  return (
    <>
      <tr className={depth === 0 ? 'rep-grp-top' : ''}>
        <td>
          <button
            type="button"
            className="rep-grp-toggle"
            style={{ paddingLeft: depth * 18 }}
            onClick={() => hasChildren && setOpen((v) => !v)}
          >
            {hasChildren ? <span className="rep-grp-caret">{open ? '⊟' : '⊞'}</span> : <span className="rep-grp-caret dim">·</span>}
            {node.label}
          </button>
        </td>
        <td className="rep-dur">{hm(node.seconds)}</td>
      </tr>
      {open && hasChildren && <GroupRows nodes={node.children!} depth={depth + 1} />}
    </>
  );
}

// ---- bar chart ----

function Chart({ daily, total }: { daily: ReportResult['daily']; total: number }) {
  const max = Math.max(1, ...daily.map((d) => d.seconds));
  return (
    <div className="rep-chart">
      <div className="rep-chart-total">{hm(total)}</div>
      <div className="rep-bars">
        {daily.map((d) => (
          <div className="rep-bar-col" key={d.date}>
            <div className="rep-bar-val">{d.seconds > 0 ? hm(d.seconds) : ''}</div>
            <div className="rep-bar-track">
              <div className="rep-bar-fill" style={{ height: `${(d.seconds / max) * 100}%` }} />
            </div>
            <div className={`rep-bar-label ${d.is_weekend ? 'weekend' : ''}`}>
              <div>{weekdayShort(d.date)}</div>
              <div className="rep-bar-day">{d.date.slice(8)}/{d.date.slice(5, 7)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- page ----

const REPORT_TYPES: Array<{ value: ReportType | 'saved'; label: string }> = [
  { value: 'summary', label: 'Summary' },
  { value: 'detailed', label: 'Detailed' },
  { value: 'weekly', label: 'Weekly Report' },
  { value: 'saved', label: 'Saved Report' },
];

const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This Week' },
  { value: 'last_week', label: 'Last Week' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'this_year', label: 'This Year' },
  { value: 'last_year', label: 'Last Year' },
];

const GROUP_DIMS: Array<{ value: GroupDim; label: string }> = [
  { value: 'employee', label: 'Employee' },
  { value: 'project', label: 'Project' },
  { value: 'client', label: 'Client' },
];

type Tab = 'timeline' | 'employees' | 'projects' | 'clients' | 'notes' | 'apps';

export default function ReportsPage() {
  const { session, checked } = useSession();

  const [mode, setMode] = useState<ReportType | 'saved'>('summary');
  const init = presetRange('last_week');
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [activePreset, setActivePreset] = useState<Preset | null>('last_week');

  const [filters, setFilters] = useState<ReportFilters | null>(null);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [noteContains, setNoteContains] = useState('');
  const [groupBy, setGroupBy] = useState<GroupDim[]>(['employee', 'project']);
  const [onlyOffline, setOnlyOffline] = useState(false);
  const [excludeArchived, setExcludeArchived] = useState(false);

  const [result, setResult] = useState<ReportResult | null>(null);
  const [tab, setTab] = useState<Tab>('timeline');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [saved, setSaved] = useState<SavedReport[]>([]);
  const reloadSaved = () => getSavedReports().then((r) => setSaved(r.reports)).catch(() => setSaved([]));

  // default group-by per report type
  useEffect(() => {
    if (mode === 'summary') setGroupBy(['employee', 'project']);
    else if (mode === 'weekly') setGroupBy(['employee']);
  }, [mode]);

  useEffect(() => {
    if (!checked || !session) return;
    getReportFilters().then(setFilters).catch(() => setFilters({ employees: [], clients: [], projects: [] }));
    reloadSaved();
  }, [checked, session]);

  const setPreset = (p: Preset) => {
    const r = presetRange(p);
    setFrom(r.from);
    setTo(r.to);
    setActivePreset(p);
  };

  const execute = async (input: RunReportInput) => {
    setLoading(true);
    setError(null);
    try {
      const res = await runReport(input);
      setResult(res);
      setTab('timeline');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const currentInput = (): RunReportInput | null => {
    if (mode === 'saved') return null;
    return {
      type: mode,
      from,
      to,
      userIds: userIds.length ? userIds : undefined,
      clientIds: clientIds.length ? clientIds : undefined,
      projectIds: projectIds.length ? projectIds : undefined,
      noteContains: noteContains.trim() || undefined,
      groupBy: mode === 'detailed' ? undefined : groupBy,
      onlyOffline,
      excludeArchived,
    };
  };

  const run = async () => {
    const input = currentInput();
    if (input) await execute(input);
  };

  const loadSaved = async (r: SavedReport) => {
    const c = r.config;
    setMode(c.type);
    setFrom(c.from);
    setTo(c.to);
    setActivePreset((c.preset as Preset | null) ?? null);
    setUserIds(c.userIds ?? []);
    setClientIds(c.clientIds ?? []);
    setProjectIds(c.projectIds ?? []);
    setNoteContains(c.noteContains ?? '');
    if (c.groupBy) setGroupBy(c.groupBy);
    setOnlyOffline(!!c.onlyOffline);
    setExcludeArchived(!!c.excludeArchived);
    await execute({
      type: c.type,
      from: c.from,
      to: c.to,
      userIds: c.userIds,
      clientIds: c.clientIds,
      projectIds: c.projectIds,
      noteContains: c.noteContains,
      groupBy: c.type === 'detailed' ? undefined : c.groupBy,
      onlyOffline: c.onlyOffline,
      excludeArchived: c.excludeArchived,
    });
  };

  const saveCurrent = async () => {
    const input = currentInput();
    if (!input) return;
    const name = window.prompt('Name this report:');
    if (!name || !name.trim()) return;
    const isShared = window.confirm('Share with the whole organization?\n(OK = shared, Cancel = just me)');
    try {
      await createSavedReport(name.trim(), { ...input, preset: activePreset }, isShared);
      await reloadSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeSaved = async (id: string) => {
    if (!window.confirm('Delete this saved report?')) return;
    try {
      await deleteSavedReport(id);
      await reloadSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportCsv = () => { if (result) downloadCsv(result); };
  const exportPdf = () => window.print();

  const toggleGroup = (d: GroupDim) =>
    setGroupBy((g) => (g.includes(d) ? g.filter((x) => x !== d) : [...g, d]));

  const tzLabel = useMemo(() => {
    const off = -new Date().getTimezoneOffset() / 60;
    return `UTC${off >= 0 ? '+' : ''}${off}`;
  }, []);

  if (!checked || !session) return <div className="center muted">Loading…</div>;

  return (
    <div className="page">
      <TopNav session={session} active="reports" />

      <div className="rep-wrap">
        <h1 className="rep-h1">Reports</h1>

        <div className="rep-builder">
          {/* row 1: date range + presets + tz */}
          <div className="rep-row rep-row-dates">
            <div className="rep-daterange">
              <input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setActivePreset(null); }} />
              <span className="rep-arrow">▶</span>
              <input type="date" value={to} min={from} max={todayLocal()} onChange={(e) => { setTo(e.target.value); setActivePreset(null); }} />
            </div>
            <div className="rep-presets">
              {PRESETS.map((p) => (
                <button
                  key={p.value}
                  className={`rep-preset ${activePreset === p.value ? 'active' : ''}`}
                  onClick={() => setPreset(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="rep-tz" title="Report timezone (viewer)">Report times are {tzLabel}</div>
          </div>

          {/* row 2: filters */}
          <div className="rep-row rep-filters">
            <MultiSelect placeholder="Select employees and groups" options={filters?.employees ?? []} selected={userIds} onChange={setUserIds} />
            <MultiSelect placeholder="Select clients" options={filters?.clients ?? []} selected={clientIds} onChange={setClientIds} />
            <MultiSelect placeholder="Select projects" options={(filters?.projects ?? []).map((p) => ({ id: p.id, name: p.name }))} selected={projectIds} onChange={setProjectIds} />
            <input className="rep-note" placeholder="Note contains text" value={noteContains} onChange={(e) => setNoteContains(e.target.value)} />
          </div>

          {/* row 3: report type + group by */}
          <div className="rep-row rep-typerow">
            <label className="rep-typelabel">Report</label>
            <select className="rep-typeselect" value={mode} onChange={(e) => setMode(e.target.value as ReportType | 'saved')}>
              {REPORT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>

            {(mode === 'summary' || mode === 'weekly') && (
              <div className="rep-groupby">
                <span className="rep-groupby-label">Group by</span>
                {GROUP_DIMS.map((d) => (
                  <button
                    key={d.value}
                    className={`rep-chip ${groupBy.includes(d.value) ? 'on' : ''}`}
                    onClick={() => toggleGroup(d.value)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* row 4: toggles + actions */}
          <div className="rep-row rep-actions">
            <label className="rep-check"><input type="checkbox" checked={onlyOffline} onChange={(e) => setOnlyOffline(e.target.checked)} /> Only offline activities</label>
            <label className="rep-check"><input type="checkbox" checked={excludeArchived} onChange={(e) => setExcludeArchived(e.target.checked)} /> Exclude archived</label>
            {mode === 'weekly' && (
              <label className="rep-check disabled" title="Absences arrive in sub-phase 5F"><input type="checkbox" disabled /> Include absences</label>
            )}
            <div className="rep-actions-right">
              <button className="rep-export" onClick={exportCsv} disabled={!result} title="Download as CSV (opens in Excel)">Excel</button>
              <button className="rep-export" onClick={exportPdf} disabled={!result} title="Print / save as PDF">PDF</button>
              <button className="rep-export" onClick={saveCurrent} disabled={mode === 'saved'} title="Save this report configuration">Save report</button>
              <button className="rep-show" onClick={run} disabled={loading || mode === 'saved'}>
                {loading ? 'Running…' : 'Show report'}
              </button>
            </div>
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        {mode === 'saved' ? (
          <SavedList saved={saved} onLoad={loadSaved} onDelete={removeSaved} />
        ) : !result ? (
          <div className="rep-placeholder">Pick a range and click <strong>Show report</strong>.</div>
        ) : (
          <div className="rep-printable">
            <div className="rep-print-head">{result.type.charAt(0).toUpperCase() + result.type.slice(1)} report · {dmy(result.range.from)} – {dmy(result.range.to)}</div>
            <ResultArea result={result} tab={tab} setTab={setTab} />
          </div>
        )}
      </div>
    </div>
  );
}

function ResultArea({ result, tab, setTab }: { result: ReportResult; tab: Tab; setTab: (t: Tab) => void }) {
  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'timeline', label: 'Timeline' },
    { value: 'employees', label: 'Employees' },
    { value: 'projects', label: 'Projects' },
    { value: 'clients', label: 'Clients' },
    { value: 'notes', label: 'Notes' },
    { value: 'apps', label: 'Apps & URLs' },
  ];
  return (
    <div className="rep-result">
      <div className="rep-tabs">
        {tabs.map((t) => (
          <button key={t.value} className={`rep-tab ${tab === t.value ? 'active' : ''}`} onClick={() => setTab(t.value)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'timeline' && (
        <>
          <Chart daily={result.daily} total={result.total_seconds} />
          {result.type === 'detailed' ? <DetailTable rows={result.detailed} truncated={result.detailed_truncated} /> : <GroupTable result={result} />}
        </>
      )}
      {tab === 'employees' && <PivotTable label="Employee" rows={result.by_employee} />}
      {tab === 'projects' && <PivotTable label="Project" rows={result.by_project} />}
      {tab === 'clients' && <PivotTable label="Client" rows={result.by_client} />}
      {tab === 'notes' && <DetailTable rows={result.notes} truncated={false} />}
      {tab === 'apps' && <AppsUrls apps={result.apps} urls={result.urls} />}
    </div>
  );
}

function GroupTable({ result }: { result: ReportResult }) {
  if (result.groups.length === 0) return <div className="rep-empty">No tracked time in this range.</div>;
  const heading = result.group_by.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(' / ');
  return (
    <table className="rep-table">
      <thead><tr><th>{heading || 'Total'}</th><th className="rep-dur">Duration</th></tr></thead>
      <tbody><GroupRows nodes={result.groups} depth={0} /></tbody>
    </table>
  );
}

function DetailTable({ rows, truncated }: { rows: ReportResult['detailed']; truncated: boolean }) {
  if (rows.length === 0) return <div className="rep-empty">No entries in this range.</div>;
  return (
    <>
      <table className="rep-table">
        <thead>
          <tr>
            <th>Date</th><th>Employee</th><th>Project</th><th>Note</th><th>From</th><th>To</th><th className="rep-dur">Duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.entry_id}>
              <td>{dmy(r.date)}</td>
              <td>{r.display_name}</td>
              <td>{r.project_name ?? <span className="muted">No project</span>}</td>
              <td>{r.note ?? ''}</td>
              <td>{clock(r.from)}</td>
              <td>{clock(r.to)}</td>
              <td className="rep-dur">{hm(r.duration_seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <div className="muted rep-trunc">Showing the first 5000 entries — narrow the range or use an export (5C).</div>}
    </>
  );
}

function AppsUrls({ apps, urls }: { apps: ReportResult['apps']; urls: ReportResult['urls'] }) {
  if (apps.length === 0 && urls.length === 0)
    return <div className="rep-empty">No app or URL activity in this range. (URLs need the browser extension.)</div>;
  return (
    <div className="rep-appsurls">
      <div>
        <h3 className="rep-subhead">Applications</h3>
        {apps.length === 0 ? <div className="rep-empty">No app activity.</div> : <PivotTable label="Application" rows={apps} />}
      </div>
      <div>
        <h3 className="rep-subhead">Websites</h3>
        {urls.length === 0 ? <div className="rep-empty">No URL activity — the browser extension isn&apos;t reporting yet.</div> : <PivotTable label="Domain" rows={urls} />}
      </div>
    </div>
  );
}

function PivotTable({ label, rows }: { label: string; rows: ReportResult['by_employee'] }) {
  if (rows.length === 0) return <div className="rep-empty">No tracked time in this range.</div>;
  return (
    <table className="rep-table">
      <thead><tr><th>{label}</th><th className="rep-dur">Duration</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key ?? '∅'}><td>{r.label}</td><td className="rep-dur">{hm(r.seconds)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function SavedList({
  saved, onLoad, onDelete,
}: {
  saved: SavedReport[];
  onLoad: (r: SavedReport) => void;
  onDelete: (id: string) => void;
}) {
  if (saved.length === 0)
    return <div className="rep-placeholder">No saved reports yet. Build a report, then click <strong>Save report</strong>.</div>;
  return (
    <div className="rep-saved">
      {saved.map((r) => (
        <div className="rep-saved-row" key={r.id}>
          <button className="rep-saved-open" onClick={() => onLoad(r)}>
            <span className="rep-saved-name">{r.name}</span>
            <span className="rep-saved-meta">
              {r.config.type} · {r.is_shared ? 'shared' : 'private'}
              {!r.is_mine && r.owner_name ? ` · by ${r.owner_name}` : ''}
            </span>
          </button>
          {(r.is_mine) && (
            <button className="rep-saved-del" title="Delete" onClick={() => onDelete(r.id)}>✕</button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---- CSV export (client-side, zero-dep) ----

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells: Array<string | number>): string {
  return cells.map(csvCell).join(',');
}
function flattenGroups(nodes: ReportGroupNode[], trail: string[], out: string[][]): void {
  for (const n of nodes) {
    const path = [...trail, n.label];
    if (n.children && n.children.length > 0) flattenGroups(n.children, path, out);
    else out.push([...path, hm(n.seconds), String(n.seconds)]);
  }
}
function downloadCsv(result: ReportResult): void {
  const lines: string[] = [];
  if (result.type === 'detailed') {
    lines.push(csvRow(['Date', 'Employee', 'Project', 'Note', 'From', 'To', 'Duration', 'Seconds']));
    for (const r of result.detailed) {
      lines.push(csvRow([dmy(r.date), r.display_name, r.project_name ?? 'No project', r.note ?? '', clock(r.from), clock(r.to), hm(r.duration_seconds), r.duration_seconds]));
    }
    lines.push('');
    lines.push(csvRow(['Total', '', '', '', '', '', hm(result.total_seconds), result.total_seconds]));
  } else {
    const dims = result.group_by.map((d) => d.charAt(0).toUpperCase() + d.slice(1));
    lines.push(csvRow([...dims, 'Duration', 'Seconds']));
    const rows: string[][] = [];
    flattenGroups(result.groups, [], rows);
    for (const r of rows) lines.push(csvRow(r));
    lines.push('');
    const pad = Array(Math.max(0, dims.length - 1)).fill('');
    lines.push(csvRow(['Total', ...pad, hm(result.total_seconds), result.total_seconds]));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `report-${result.type}-${result.range.from}_${result.range.to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
