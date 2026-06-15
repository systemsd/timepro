'use client';

import { loadSession } from './session';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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

// ---- team ----

export interface TeamMember {
  user_id: string;
  display_name: string;
  email: string;
  role: string;
  status: string;
  is_owner: boolean;
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

export interface TodaySummary {
  tracked_seconds: number;
  is_running: boolean;
  screenshot_count: number;
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
