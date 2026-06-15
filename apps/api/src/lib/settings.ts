import { and, eq } from 'drizzle-orm';
import { schema, type DB } from '@timepro/db';
import { registryDefaults, SETTINGS_BY_KEY, validateValue } from './settings-registry';

type Value = boolean | number | string;

/**
 * Settings resolver. Effective value (2-level, C5):
 *   user override ?? org default ?? registry default
 */

/** Org defaults: registry defaults merged with org-scoped rows. */
export async function getOrgDefaults(
  tx: DB,
  orgId: string,
): Promise<Record<string, Value>> {
  const rows = await tx
    .select({ key: schema.settingsScoped.key, value: schema.settingsScoped.value })
    .from(schema.settingsScoped)
    .where(
      and(
        eq(schema.settingsScoped.organizationId, orgId),
        eq(schema.settingsScoped.scopeType, 'org'),
        eq(schema.settingsScoped.scopeId, orgId),
      ),
    );
  const out = registryDefaults();
  for (const r of rows) out[r.key] = r.value as Value;
  return out;
}

/** Per-user override values (only keys that are overridden). */
export async function getUserOverrides(
  tx: DB,
  orgId: string,
  userId: string,
): Promise<Record<string, Value>> {
  const rows = await tx
    .select({ key: schema.settingsScoped.key, value: schema.settingsScoped.value })
    .from(schema.settingsScoped)
    .where(
      and(
        eq(schema.settingsScoped.organizationId, orgId),
        eq(schema.settingsScoped.scopeType, 'user'),
        eq(schema.settingsScoped.scopeId, userId),
      ),
    );
  const out: Record<string, Value> = {};
  for (const r of rows) out[r.key] = r.value as Value;
  return out;
}

/** Effective values for a user + which keys are user-overridden. */
export async function getEffectiveForUser(
  tx: DB,
  orgId: string,
  userId: string,
): Promise<{ effective: Record<string, Value>; overridden: Record<string, boolean> }> {
  const defaults = await getOrgDefaults(tx, orgId);
  const overrides = await getUserOverrides(tx, orgId, userId);
  const effective = { ...defaults };
  const overridden: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(overrides)) {
    effective[k] = v;
    overridden[k] = true;
  }
  return { effective, overridden };
}

export async function setOrgDefault(
  tx: DB,
  orgId: string,
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<void> {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) throw Object.assign(new Error(`unknown setting ${key}`), { statusCode: 422, code: 'unknown_setting' });
  const v = validateValue(def, value);
  await tx
    .insert(schema.settingsScoped)
    .values({ organizationId: orgId, scopeType: 'org', scopeId: orgId, key, value: v as never, updatedBy })
    .onConflictDoUpdate({
      target: [
        schema.settingsScoped.organizationId,
        schema.settingsScoped.scopeType,
        schema.settingsScoped.scopeId,
        schema.settingsScoped.key,
      ],
      set: { value: v as never, updatedBy, updatedAt: new Date() },
    });
}

export async function setUserOverride(
  tx: DB,
  orgId: string,
  userId: string,
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<void> {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) throw Object.assign(new Error(`unknown setting ${key}`), { statusCode: 422, code: 'unknown_setting' });
  if (!def.overridable) {
    throw Object.assign(new Error(`${key} cannot be overridden per user`), { statusCode: 422, code: 'not_overridable' });
  }
  const v = validateValue(def, value);
  await tx
    .insert(schema.settingsScoped)
    .values({ organizationId: orgId, scopeType: 'user', scopeId: userId, key, value: v as never, updatedBy })
    .onConflictDoUpdate({
      target: [
        schema.settingsScoped.organizationId,
        schema.settingsScoped.scopeType,
        schema.settingsScoped.scopeId,
        schema.settingsScoped.key,
      ],
      set: { value: v as never, updatedBy, updatedAt: new Date() },
    });
}

export async function clearUserOverride(
  tx: DB,
  orgId: string,
  userId: string,
  key: string,
): Promise<void> {
  await tx
    .delete(schema.settingsScoped)
    .where(
      and(
        eq(schema.settingsScoped.organizationId, orgId),
        eq(schema.settingsScoped.scopeType, 'user'),
        eq(schema.settingsScoped.scopeId, userId),
        eq(schema.settingsScoped.key, key),
      ),
    );
}

/** Clear all of a user's overrides (used when the "individual settings" toggle is turned off). */
export async function clearAllUserOverrides(tx: DB, orgId: string, userId: string): Promise<void> {
  await tx
    .delete(schema.settingsScoped)
    .where(
      and(
        eq(schema.settingsScoped.organizationId, orgId),
        eq(schema.settingsScoped.scopeType, 'user'),
        eq(schema.settingsScoped.scopeId, userId),
      ),
    );
}
