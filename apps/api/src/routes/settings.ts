import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../plugins/tenant';
import { forbid, isAdmin, requesterRole } from '../lib/access';
import { SETTINGS } from '../lib/settings-registry';
import {
  clearAllUserOverrides,
  clearUserOverride,
  getEffectiveForUser,
  getOrgDefaults,
  setOrgDefault,
  setUserOverride,
} from '../lib/settings';

const ValueSchema = z.union([z.boolean(), z.number(), z.string()]);

/** The catalog definitions the UI needs to render typed editors. */
const CatalogEntry = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['bool', 'number', 'enum']),
  default: ValueSchema,
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().optional(),
  overridable: z.boolean(),
  description: z.string().optional(),
  enforced_by: z.string().optional(),
});

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  // Catalog + org defaults (admin/owner).
  app.get(
    '/settings',
    {
      preHandler: [requireAuth],
      schema: {
        response: {
          200: z.object({
            catalog: z.array(CatalogEntry),
            org_defaults: z.record(z.string(), ValueSchema),
          }),
        },
        tags: ['settings'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can view settings');
      return req.withTenantDb(async (tx) => {
        const org_defaults = await getOrgDefaults(tx, req.organizationId!);
        return {
          catalog: SETTINGS.map((s) => ({
            key: s.key,
            label: s.label,
            type: s.type,
            default: s.default,
            options: s.options,
            min: s.min,
            max: s.max,
            unit: s.unit,
            overridable: s.overridable,
            description: s.description,
            enforced_by: s.enforcedBy,
          })),
          org_defaults,
        };
      });
    },
  );

  // Set an org default.
  app.put(
    '/settings',
    {
      preHandler: [requireAuth],
      schema: {
        body: z.object({ key: z.string(), value: ValueSchema }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['settings'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can edit settings');
      return req.withTenantDb(async (tx) => {
        await setOrgDefault(tx, req.organizationId!, req.body.key, req.body.value, req.userId!);
        return { ok: true };
      });
    },
  );

  // A user's effective settings + which keys are overridden (admin/owner).
  app.get(
    '/settings/user/:userId',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        response: {
          200: z.object({
            effective: z.record(z.string(), ValueSchema),
            overridden: z.record(z.string(), z.boolean()),
            has_overrides: z.boolean(),
          }),
        },
        tags: ['settings'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can view user settings');
      return req.withTenantDb(async (tx) => {
        const { effective, overridden } = await getEffectiveForUser(tx, req.organizationId!, req.params.userId);
        return { effective, overridden, has_overrides: Object.keys(overridden).length > 0 };
      });
    },
  );

  // Set / clear a user override.
  app.put(
    '/settings/user/:userId',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({ key: z.string(), value: ValueSchema }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['settings'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can edit user settings');
      return req.withTenantDb(async (tx) => {
        await setUserOverride(tx, req.organizationId!, req.params.userId, req.body.key, req.body.value, req.userId!);
        return { ok: true };
      });
    },
  );

  app.delete(
    '/settings/user/:userId/:key',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid(), key: z.string() }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['settings'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can edit user settings');
      return req.withTenantDb(async (tx) => {
        await clearUserOverride(tx, req.organizationId!, req.params.userId, req.params.key);
        return { ok: true };
      });
    },
  );

  // Turn the per-user "individual settings" toggle off → clear all overrides.
  app.delete(
    '/settings/user/:userId',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['settings'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can edit user settings');
      return req.withTenantDb(async (tx) => {
        await clearAllUserOverrides(tx, req.organizationId!, req.params.userId);
        return { ok: true };
      });
    },
  );

  // Effective settings for the *current* user — what the desktop agent reads.
  app.get(
    '/settings/effective',
    {
      preHandler: [requireAuth],
      schema: {
        response: { 200: z.object({ effective: z.record(z.string(), ValueSchema) }) },
        tags: ['settings'],
      },
    },
    async (req) => {
      return req.withTenantDb(async (tx) => {
        const { effective } = await getEffectiveForUser(tx, req.organizationId!, req.userId!);
        return { effective };
      });
    },
  );
};
