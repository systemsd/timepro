'use client';

import { loadSession } from './session';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001';

/**
 * MVP auth: the web app forwards the user identity as the dev-shim headers
 * the API understands. When real JWT cookies land, this becomes
 * `credentials: 'include'` and the headers go away.
 */
function authHeaders(): Record<string, string> {
  const s = loadSession();
  if (!s) return {};
  return { 'x-dev-org': s.organization_id, 'x-dev-user': s.user_id };
}

async function asError(res: Response): Promise<never> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    detail = body.detail ?? body.title ?? detail;
  } catch {
    /* not json */
  }
  throw new Error(detail);
}

export async function exchangeHandoff(code: string) {
  const res = await fetch(`${API_BASE}/v1/auth/handoff/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) return asError(res);
  return res.json();
}

/** Direct web login (email-only MVP, mirrors the desktop dev login). */
export async function login(email: string) {
  const res = await fetch(`${API_BASE}/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) return asError(res);
  return res.json();
}

export const OPSCORE_URL = process.env.NEXT_PUBLIC_OPSCORE_URL ?? 'http://localhost:3001';

/** Exchange an OpsCore handoff JWT for a TimePro session. */
export async function exchangeOpsCore(token: string) {
  const res = await fetch(`${API_BASE}/v1/auth/opscore/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) return asError(res);
  return res.json();
}

/** Admin: pull users/projects/clients from OpsCore. */
export async function syncOpsCore(): Promise<{
  users: number;
  clients: number;
  projects: number;
  assignments: number;
  disabled: number;
}> {
  const res = await fetch(`${API_BASE}/v1/admin/opscore/sync`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) return asError(res);
  return res.json();
}

// ---- team ----

export type Presence = 'offline' | 'connected' | 'tracking';

export interface TeamMember {
  user_id: string;
  display_name: string;
  email: string;
  role: string;
  status: string;
  is_owner: boolean;
  presence: Presence;
}

export interface MemberProject {
  id: string;
  name: string;
  color: string;
  enabled: boolean;
}

export interface MemberDetail extends TeamMember {
  projects: MemberProject[];
  effective_settings: Record<string, string>;
}

export async function getTeamMembers(): Promise<{ members: TeamMember[] }> {
  const res = await fetch(`${API_BASE}/v1/team/members`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

export async function getTeamMember(userId: string): Promise<MemberDetail> {
  const res = await fetch(`${API_BASE}/v1/team/members/${userId}`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

export async function updateTeamMember(
  userId: string,
  patch: { role?: string; status?: string },
): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/team/members/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) await asError(res);
}

export async function setMemberProjects(
  userId: string,
  assignments: Array<{ project_id: string; enabled: boolean }>,
): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/team/members/${userId}/projects`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ assignments }),
  });
  if (!res.ok) await asError(res);
}

export async function inviteMember(email: string, role = 'employee'): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/team/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) await asError(res);
}

export async function removeMember(userId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/team/members/${userId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) await asError(res);
}

// ---- roster (My Home for admins/managers) ----

export interface RosterRow {
  user_id: string;
  display_name: string;
  email: string;
  role: string;
  is_owner: boolean;
  status: string;
  presence: Presence;
  last_app: string | null;
  today_seconds: number;
  yesterday_seconds: number;
  week_seconds: number;
  month_seconds: number;
  period_seconds: number;
  weekly_limit_hours: number;
  over_limit: boolean;
  last_active: string | null;
  last_screenshot_id: string | null;
}

export type RosterPeriod = 'day' | 'month';

export interface Roster {
  rows: RosterRow[];
  totals: {
    today_seconds: number;
    yesterday_seconds: number;
    week_seconds: number;
    month_seconds: number;
    period_seconds: number;
    online: number;
  };
  period: { type: RosterPeriod; date: string };
}

export async function getRoster(opts?: { period?: RosterPeriod; date?: string }): Promise<Roster> {
  const tz = new Date().getTimezoneOffset();
  const q = new URLSearchParams({ tzOffsetMinutes: String(tz) });
  if (opts?.period) q.set('period', opts.period);
  if (opts?.date) q.set('date', opts.date);
  const res = await fetch(`${API_BASE}/v1/roster?${q.toString()}`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

// ---- timeline ----

export interface TimelineSlot {
  start: string;
  end: string;
  project_id: string | null;
  activity_score: number | null;
  app_name: string | null;
  screenshots: Array<{ id: string; captured_at: string }>;
}

export interface Timeline {
  user_id: string;
  display_name: string;
  date: string;
  tracked_seconds: number;
  activity_score: number | null;
  intervals: Array<{ start: string; end: string }>;
  slots: TimelineSlot[];
}

export async function getTimeline(userId: string, date: string): Promise<Timeline> {
  const tz = new Date().getTimezoneOffset();
  const res = await fetch(
    `${API_BASE}/v1/timeline/${userId}?date=${date}&tzOffsetMinutes=${tz}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return asError(res);
  return res.json();
}

export interface TimelineAppsUrls {
  apps: Array<{ name: string; seconds: number }>;
  urls: Array<{ domain: string; seconds: number }>;
}

/** Apps + URLs used on one day for a user — Timeline summary-card panel. */
export async function getTimelineAppsUrls(userId: string, date: string): Promise<TimelineAppsUrls> {
  const tz = new Date().getTimezoneOffset();
  const res = await fetch(
    `${API_BASE}/v1/timeline/${userId}/apps-urls?date=${date}&tzOffsetMinutes=${tz}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return asError(res);
  return res.json();
}

/** Per-day tracked seconds for one user across a month (YYYY-MM) — Timeline calendar dots. */
export async function getTimelineActivity(
  userId: string,
  month: string,
): Promise<{ days: Array<{ date: string; seconds: number }> }> {
  const tz = new Date().getTimezoneOffset();
  const res = await fetch(
    `${API_BASE}/v1/timeline/${userId}/activity?month=${month}&tzOffsetMinutes=${tz}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return asError(res);
  return res.json();
}

// ---- projects management ----

export interface ManagedProject {
  id: string;
  name: string;
  color: string;
  status: string;
  member_count: number;
}

export async function getManagedProjects(): Promise<{ total_members: number; projects: ManagedProject[] }> {
  const res = await fetch(`${API_BASE}/v1/projects/manage`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

export async function getProjectMembers(
  projectId: string,
): Promise<{ members: Array<{ user_id: string; display_name: string; enabled: boolean }> }> {
  const res = await fetch(`${API_BASE}/v1/projects/${projectId}/members`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

export async function setProjectMembers(
  projectId: string,
  assignments: Array<{ user_id: string; enabled: boolean }>,
): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/projects/${projectId}/members`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ assignments }),
  });
  if (!res.ok) await asError(res);
}

// ---- clients ----

export interface ClientRow {
  id: string;
  name: string;
  project_count: number;
}

export async function getClients(): Promise<{ clients: ClientRow[] }> {
  const res = await fetch(`${API_BASE}/v1/clients`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

export async function createClient(name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/clients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) await asError(res);
}

// ---- settings ----

export type SettingValue = boolean | number | string;

export interface SettingDef {
  key: string;
  label: string;
  type: 'bool' | 'number' | 'enum';
  default: SettingValue;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  unit?: string;
  overridable: boolean;
  description?: string;
  enforced_by?: string;
}

export async function getSettingsCatalog(): Promise<{
  catalog: SettingDef[];
  org_defaults: Record<string, SettingValue>;
}> {
  const res = await fetch(`${API_BASE}/v1/settings`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

export async function setOrgSetting(key: string, value: SettingValue): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) await asError(res);
}

export async function getUserSettings(userId: string): Promise<{
  effective: Record<string, SettingValue>;
  overridden: Record<string, boolean>;
  has_overrides: boolean;
}> {
  const res = await fetch(`${API_BASE}/v1/settings/user/${userId}`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

export async function setUserSetting(
  userId: string,
  key: string,
  value: SettingValue,
): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/settings/user/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) await asError(res);
}

export async function clearUserSetting(userId: string, key: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/settings/user/${userId}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) await asError(res);
}

export interface TodaySummary {
  tracked_seconds: number;
  is_running: boolean;
  screenshot_count: number;
  week_seconds: number;
  weekly_limit_hours: number;
  over_limit: boolean;
  entries: Array<{
    id: string;
    project_id: string | null;
    description: string | null;
    started_at: string;
    ended_at: string | null;
    duration_seconds: number;
  }>;
}

export async function getToday(): Promise<TodaySummary> {
  const res = await fetch(`${API_BASE}/v1/me/today`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

export interface Profile {
  display_name: string;
  email: string;
  organization_name: string;
  role: string;
}

export async function getProfile(): Promise<Profile> {
  const res = await fetch(`${API_BASE}/v1/me/profile`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

// ---- reports (B7 / Phase 5) ----

export type ReportType = 'summary' | 'detailed' | 'weekly';
export type GroupDim = 'employee' | 'project' | 'client';

export interface ReportFilters {
  employees: Array<{ id: string; name: string }>;
  clients: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string; client_id: string | null }>;
}

export interface ReportGroupNode {
  dim: GroupDim;
  key: string | null;
  label: string;
  seconds: number;
  children?: ReportGroupNode[];
}

export interface ReportDetailRow {
  entry_id: string;
  date: string;
  user_id: string;
  display_name: string;
  project_id: string | null;
  project_name: string | null;
  note: string | null;
  from: string;
  to: string;
  duration_seconds: number;
  is_manual: boolean;
}

export interface ReportPivot {
  key: string | null;
  label: string;
  seconds: number;
}

export interface ReportResult {
  range: { from: string; to: string };
  type: ReportType;
  group_by: GroupDim[];
  total_seconds: number;
  daily: Array<{ date: string; seconds: number; is_weekend: boolean }>;
  groups: ReportGroupNode[];
  detailed: ReportDetailRow[];
  detailed_truncated: boolean;
  by_employee: ReportPivot[];
  by_project: ReportPivot[];
  by_client: ReportPivot[];
  apps: ReportPivot[];
  urls: ReportPivot[];
  notes: ReportDetailRow[];
}

export interface RunReportInput {
  type: ReportType;
  from: string;
  to: string;
  userIds?: string[];
  clientIds?: string[];
  projectIds?: string[];
  noteContains?: string;
  groupBy?: GroupDim[];
  onlyOffline?: boolean;
  excludeArchived?: boolean;
}

export async function getReportFilters(): Promise<ReportFilters> {
  const res = await fetch(`${API_BASE}/v1/reports/filters`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

export async function runReport(input: RunReportInput): Promise<ReportResult> {
  const tzOffsetMinutes = new Date().getTimezoneOffset();
  const res = await fetch(`${API_BASE}/v1/reports/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ ...input, tzOffsetMinutes }),
  });
  if (!res.ok) return asError(res);
  return res.json();
}

/** Serialized Reports-console builder state for a saved report. */
export interface SavedReportConfig extends RunReportInput {
  preset?: string | null;
}

export interface SavedReport {
  id: string;
  name: string;
  is_shared: boolean;
  owner_user_id: string;
  owner_name: string | null;
  is_mine: boolean;
  config: SavedReportConfig;
}

export async function getSavedReports(): Promise<{ reports: SavedReport[] }> {
  const res = await fetch(`${API_BASE}/v1/reports/saved`, { headers: authHeaders() });
  if (!res.ok) return asError(res);
  return res.json();
}

export async function createSavedReport(
  name: string,
  config: SavedReportConfig,
  isShared: boolean,
): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/v1/reports/saved`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name, config, is_shared: isShared }),
  });
  if (!res.ok) return asError(res);
  return res.json();
}

export async function deleteSavedReport(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/reports/saved/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) await asError(res);
}

export interface ScreenshotMeta {
  id: string;
  captured_at: string;
  width: number | null;
  height: number | null;
  status: string;
}

export async function getScreenshots(limit = 24): Promise<{ screenshots: ScreenshotMeta[] }> {
  const res = await fetch(`${API_BASE}/v1/screenshots?limit=${limit}`, {
    headers: authHeaders(),
  });
  if (!res.ok) return asError(res);
  return res.json();
}

/**
 * Fetch the raw image with auth headers and return an object URL.
 * (An <img src> can't carry headers, so we fetch-as-blob.)
 */
export async function getScreenshotObjectUrl(id: string): Promise<string> {
  const res = await fetch(`${API_BASE}/v1/screenshots/${id}/raw`, {
    headers: authHeaders(),
  });
  if (!res.ok) return asError(res);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function deleteScreenshot(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/v1/screenshots/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) return asError(res);
  return res.json();
}
