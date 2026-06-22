import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { pkId, timestamps, tsCol } from './_common';

/**
 * Desktop-agent diagnostic logs — lifecycle events + warnings/errors the agent
 * ships for remote debugging (a manager/dev can read them via the admin API,
 * since there's no SSH to the agent's machine). Pruned by retention (~14d).
 *
 * `deviceId`/`agentVersion`/`os` are agent-reported labels (not FKs). `ts` is the
 * client-side event time; `createdAt` is when the server received the batch.
 */
export const agentLogs = pgTable(
  'agent_logs',
  {
    id: pkId(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: text('device_id'),
    agentVersion: text('agent_version'),
    os: text('os'),
    ts: tsCol('ts').notNull(),
    level: text('level').notNull(),
    event: text('event').notNull(),
    message: text('message').notNull().default(''),
    fields: jsonb('fields').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamps.createdAt,
  },
  (t) => ({
    userTs: index('agent_logs_user_ts_idx').on(t.organizationId, t.userId, t.ts.desc()),
    created: index('agent_logs_created_idx').on(t.createdAt),
  }),
);

export type AgentLog = typeof agentLogs.$inferSelect;
export type NewAgentLog = typeof agentLogs.$inferInsert;
