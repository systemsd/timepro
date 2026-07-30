import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { pkId, timestamps, tsCol } from './_common';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Read-only mirror of OpsCore **Internal Products** — SystemsD-owned software
 * products/platforms/tools, a deliberate *peer* of `Project` (client delivery)
 * in OpsCore: there is no FK either way and an OpsCore task belongs to EITHER a
 * project OR a product, never both. TimePro mirrors that shape rather than
 * inventing a hierarchy.
 *
 * OpsCore is authoritative; TimePro never writes product state back.
 *
 * `active=false` marks a product that vanished from the sync feed (deleted
 * upstream): the row is kept so historical time entries still resolve a name.
 * The row is *never* deleted and archived products are *not* filtered here —
 * the picker filter (`active` + stage) lives in `GET /v1/products`, so old time
 * still reports against a resolvable product.
 */
export const products = pgTable(
  'products',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    opscoreProductId: text('opscore_product_id').notNull(), // OpsCore Product.id (cuid)
    name: text('name').notNull(),
    slug: text('slug'),
    // OpsCore ProductStage: IDEA | VALIDATE | PLAN | BUILD | LAUNCH | IMPROVE |
    // PAUSED | SUNSET | ARCHIVED. Only ARCHIVED is hidden from the picker.
    stage: text('stage').notNull().default('IDEA'),
    color: text('color').notNull().default('#0ea5e9'),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => ({
    opscoreUnique: uniqueIndex('products_org_opscore_unique').on(
      t.organizationId,
      t.opscoreProductId,
    ),
  }),
);

/**
 * Who may track against a product. Mirrors `project_members`, minus the rate
 * override — product time is internal and always non-billable (enforced in
 * `timer/start`), so there is no rate to override.
 *
 * Reconciled wholesale from the OpsCore feed: the owner plus every
 * `ProductMember` row regardless of role.
 */
export const productMembers = pgTable(
  'product_members',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: tsCol('added_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.productId, t.userId] }),
    userIdx: index('product_members_user_idx').on(t.userId),
  }),
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
