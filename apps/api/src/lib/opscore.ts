import { jwtVerify } from 'jose';
import { loadConfig } from '../config';

/**
 * OpsCore integration (Phase 3). OpsCore is the source of truth for
 * employees / projects / clients and the identity provider via a short-lived
 * handoff JWT (it is NOT an OIDC provider — see docs/13).
 */

export interface OpsCoreHandoffClaims {
  sub: string; // OpsCore Employee.id
  email: string;
  name: string;
  role: string | null;
}

/** Verify the handoff JWT minted by OpsCore (HS256, iss=opscore, aud=timepro). */
export async function verifyHandoffToken(token: string): Promise<OpsCoreHandoffClaims> {
  const config = loadConfig();
  const key = new TextEncoder().encode(config.OPSCORE_HANDOFF_SECRET);
  const { payload } = await jwtVerify(token, key, {
    issuer: 'opscore',
    audience: 'timepro',
  });
  if (!payload.sub) throw new Error('handoff token missing sub');
  return {
    sub: payload.sub,
    email: String(payload.email ?? ''),
    name: String(payload.name ?? ''),
    role: (payload.role as string | null) ?? null,
  };
}

/**
 * Map an OpsCore ACL role name → TimePro role. OpsCore is the only auth source
 * (no local break-glass owner): an OpsCore ADMIN maps to `admin`, which has full
 * access — TimePro no longer mints a local `owner`.
 */
export function mapOpsCoreRole(opscoreRole: string | null): 'admin' | 'manager' | 'employee' {
  if (!opscoreRole) return 'employee';
  const r = opscoreRole.toUpperCase();
  if (r === 'ADMIN') return 'admin';
  if (r.endsWith('_MANAGER')) return 'manager';
  return 'employee';
}

// ---- directory service API client ----

export interface OpsEmployee {
  id: string;
  name: string;
  email: string;
  company_email: string | null;
  status: string;
  role: string | null;
}
export interface OpsProject {
  id: string;
  name: string;
  status: string;
  business_partner_id: string | null;
  project_manager_id: string | null;
  member_ids: string[];
}
export interface OpsPartner {
  id: string;
  name: string;
  status: string;
}

async function fetchJson<T>(path: string): Promise<T> {
  const config = loadConfig();
  const base = config.OPSCORE_API_URL.replace(/\/$/, '');
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${config.OPSCORE_API_KEY}` },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`OpsCore ${path} → ${res.status}`), {
      statusCode: 502,
      code: 'opscore_unreachable',
    });
  }
  return res.json() as Promise<T>;
}

export const opscoreApi = {
  employees: () => fetchJson<{ employees: OpsEmployee[] }>('/api/timepro/sync/employees'),
  projects: () => fetchJson<{ projects: OpsProject[] }>('/api/timepro/sync/projects'),
  businessPartners: () =>
    fetchJson<{ business_partners: OpsPartner[] }>('/api/timepro/sync/business-partners'),
};
