'use client';

export interface WebSession {
  user_id: string;
  organization_id: string;
  organization_name: string;
  display_name: string;
  role: string;
}

const KEY = 'tf_web_session';

export function saveSession(s: WebSession): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function loadSession(): WebSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as WebSession) : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
}
