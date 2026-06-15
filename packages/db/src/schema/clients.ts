import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pkId, softDeletedAt, timestamps } from './_common';
import { organizations } from './organizations';

/**
 * Clients (= OpsCore "business partners"). Projects belong to a client so we
 * can report time-spent-per-client.
 *
 * Once OpsCore sync lands (Phase 3), `opscore_business_partner_id` links the
 * row to OpsCore and the catalog becomes read-only. For the Phase-0 interim
 * the catalog is locally managed.
 */
export const clients = pgTable(
  'clients',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    opscoreBusinessPartnerId: text('opscore_business_partner_id'),
    ...timestamps,
    ...softDeletedAt,
  },
  (t) => ({
    nameUnique: uniqueIndex('clients_org_name_unique').on(t.organizationId, t.name),
  }),
);

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
