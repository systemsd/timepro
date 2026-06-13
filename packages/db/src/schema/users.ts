import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { citext, pkId, softDeletedAt, timestamps, tsCol } from './_common';

export const users = pgTable('users', {
  id: pkId(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash'), // nullable for SSO-only users
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  timezone: text('timezone').notNull().default('UTC'),
  locale: text('locale').notNull().default('en'),
  emailVerifiedAt: tsCol('email_verified_at'),
  lastLoginAt: tsCol('last_login_at'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  mfaSecret: text('mfa_secret'), // app-layer encrypted, never returned to clients
  ...timestamps,
  ...softDeletedAt,
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
