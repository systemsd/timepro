import { sql } from 'drizzle-orm';
import { customType, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { inet, pkId, timestamps, tsCol } from './_common';
import { organizations } from './organizations';
import { users } from './users';

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const devices = pgTable(
  'devices',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform').notNull(), // darwin | windows | linux
    osVersion: text('os_version'),
    agentVersion: text('agent_version'),
    hostname: text('hostname'),
    fingerprint: text('fingerprint').notNull(),
    publicKey: text('public_key'),
    status: text('status').notNull().default('active'), // active | revoked
    approvedAt: tsCol('approved_at'),
    lastSeenAt: tsCol('last_seen_at'),
    lastIp: inet('last_ip'),
    ...timestamps,
    revokedAt: tsCol('revoked_at'),
  },
  (t) => ({
    fingerprintUnique: uniqueIndex('devices_user_fingerprint_unique').on(
      t.userId,
      t.fingerprint,
    ),
    orgActive: index('devices_org_active_idx')
      .on(t.organizationId, t.lastSeenAt)
      .where(sql`status = 'active'`),
  }),
);

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: pkId(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    expiresAt: tsCol('expires_at').notNull(),
    revokedAt: tsCol('revoked_at'),
    replacedBy: uuid('replaced_by'),
    createdAt: tsCol('created_at').notNull().defaultNow(),
    lastUsedAt: tsCol('last_used_at'),
  },
  (t) => ({
    activeByDevice: index('device_tokens_device_idx')
      .on(t.deviceId)
      .where(sql`revoked_at IS NULL`),
  }),
);

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
