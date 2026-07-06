import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pkId, timestamps, tsCol } from './_common';
import { organizations } from './organizations';
import { projects } from './projects';

/**
 * Read-only mirror of OpsCore task-board tasks (Phase 3 directory sync, 4th feed
 * after employees/projects/business-partners). OpsCore is authoritative — TimePro
 * never writes task state back.
 *
 * `active=false` marks a task that vanished from the sync feed (CLOSED or deleted
 * in OpsCore): the row is kept so historical time entries stay valid, but pickers
 * filter it out. Visibility is by OpsCore employee id (the handoff JWT `sub`):
 * a user sees a task when their id == `assigned_opscore_employee_id` or is in
 * `collaborator_opscore_employee_ids` — stored as raw OpsCore ids to match the
 * feed directly (same key TimePro authenticates on).
 */
export const tasks = pgTable(
  'tasks',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    opscoreTaskId: text('opscore_task_id').notNull(), // OpsCore Task.id (cuid)
    // Resolved from the feed's `project_id` → local project uuid; null = the
    // "No project" bucket (assigned work with no project — still trackable).
    projectId: uuid('project_id').references(() => projects.id),
    name: text('name').notNull(),
    status: text('status').notNull(), // TODO | IN_PROGRESS | REVIEW | BLOCKED | DONE
    priority: text('priority').notNull(), // LOW | MEDIUM | HIGH | URGENT
    assignedOpscoreEmployeeId: text('assigned_opscore_employee_id'),
    collaboratorOpscoreEmployeeIds: text('collaborator_opscore_employee_ids')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    active: boolean('active').notNull().default(true),
    opscoreUpdatedAt: tsCol('opscore_updated_at'),
    ...timestamps,
  },
  (t) => ({
    opscoreUnique: uniqueIndex('tasks_org_opscore_unique').on(t.organizationId, t.opscoreTaskId),
    projectIdx: index('tasks_org_project_idx').on(t.organizationId, t.projectId),
  }),
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
