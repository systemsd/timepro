import { unlink } from 'node:fs/promises';
import { and, eq, lt } from 'drizzle-orm';
import { asPlatform, schema, type DB } from '@timepro/db';
import { SETTINGS_BY_KEY } from './settings-registry';

/**
 * Screenshot retention (the "Keep screenshots for last N" policy).
 *
 * No scheduler service exists yet (Phase 8), so the sweep runs in-process on a
 * timer started in `server.ts`. Retention is org-wide (`screenshots.retention_days`,
 * not user-overridable); `0` means keep forever.
 */
const RETENTION_KEY = 'screenshots.retention_days';
const DAY_MS = 86_400_000;

function defaultRetentionDays(): number {
  return Number(SETTINGS_BY_KEY.get(RETENTION_KEY)?.default ?? 90);
}

/** Delete an org's screenshots older than `retentionDays` (rows + files). 0 = keep forever. */
export async function pruneOrgScreenshots(tx: DB, orgId: string, retentionDays: number): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  const olds = await tx
    .select({ id: schema.screenshots.id, s3Key: schema.screenshots.s3Key })
    .from(schema.screenshots)
    .where(and(eq(schema.screenshots.organizationId, orgId), lt(schema.screenshots.capturedAt, cutoff)));
  if (olds.length === 0) return 0;
  await tx
    .delete(schema.screenshots)
    .where(and(eq(schema.screenshots.organizationId, orgId), lt(schema.screenshots.capturedAt, cutoff)));
  for (const s of olds) {
    if (s.s3Key) {
      try { await unlink(s.s3Key); } catch { /* file already gone */ }
    }
  }
  return olds.length;
}

/** Agent diagnostic logs are kept this long, then pruned (fixed, not configurable). */
const AGENT_LOGS_RETENTION_DAYS = 14;

/** Delete agent logs older than the retention window across all orgs. */
export async function pruneAgentLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - AGENT_LOGS_RETENTION_DAYS * DAY_MS);
  return asPlatform(async (tx) => {
    const deleted = await tx
      .delete(schema.agentLogs)
      .where(lt(schema.agentLogs.createdAt, cutoff))
      .returning({ id: schema.agentLogs.id });
    return deleted.length;
  });
}

/**
 * Sweep every org using its configured retention (org-default override ←
 * registry default). Cross-tenant → runs under `asPlatform`. Returns total deleted.
 */
export async function pruneAllOrgs(): Promise<number> {
  return asPlatform(async (tx) => {
    const orgs = await tx.select({ id: schema.organizations.id }).from(schema.organizations);
    const overrides = await tx
      .select({ orgId: schema.settingsScoped.organizationId, value: schema.settingsScoped.value })
      .from(schema.settingsScoped)
      .where(and(eq(schema.settingsScoped.scopeType, 'org'), eq(schema.settingsScoped.key, RETENTION_KEY)));
    const byOrg = new Map(overrides.map((r) => [r.orgId, Number(r.value)]));
    const fallback = defaultRetentionDays();
    let total = 0;
    for (const o of orgs) {
      total += await pruneOrgScreenshots(tx, o.id, byOrg.get(o.id) ?? fallback);
    }
    return total;
  });
}
