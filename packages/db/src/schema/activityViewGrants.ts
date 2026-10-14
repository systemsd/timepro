import { index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { tsCol } from './_common';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Admin-granted, view-only access to another member's activity (timeline,
 * screenshots, reports, roster) outside the OpsCore reporting line. Never
 * confers write access — edits/deletes stay with admins and team managers.
 */
export const activityViewGrants = pgTable(
  'activity_view_grants',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    viewerUserId: uuid('viewer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subjectUserId: uuid('subject_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tsCol('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.viewerUserId, t.subjectUserId] }),
    bySubject: index('activity_view_grants_subject_idx').on(t.organizationId, t.subjectUserId),
  }),
);

export type ActivityViewGrant = typeof activityViewGrants.$inferSelect;
