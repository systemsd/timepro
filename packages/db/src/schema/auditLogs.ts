import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { inet, pkId, timestamps } from './_common';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pkId(),
    organizationId: uuid('organization_id'), // nullable for platform events
    actorUserId: uuid('actor_user_id'),
    actorType: text('actor_type').notNull(), // 'user' | 'system' | 'agent'
    action: text('action').notNull(),        // 'screenshot.delete'
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamps.createdAt,
  },
  (t) => ({
    orgCreated: index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    // Per-target history lookups (e.g. one time entry's edit log).
    target: index('audit_logs_target_idx')
      .on(t.organizationId, t.targetType, t.targetId, t.createdAt.desc())
      .where(sql`target_id IS NOT NULL`),
  }),
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
