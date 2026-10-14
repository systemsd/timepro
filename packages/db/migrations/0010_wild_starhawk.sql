-- Hierarchy-scoped activity visibility.
--
-- `memberships.reports_to_user_id` mirrors OpsCore `Employee.reporting_manager_id`
-- (synced by lib/opscore-sync.ts): a viewer sees the activity of everyone below
-- them in that chain. It lives on the membership, not the user, because a
-- reporting line is org-scoped. Nullable with no default → metadata-only ADD
-- COLUMN, no rewrite of `memberships`.
--
-- `activity_view_grants` holds admin-granted, view-only access to specific
-- members outside the reporting line. Grants never confer write access.
CREATE TABLE IF NOT EXISTS "activity_view_grants" (
	"organization_id" uuid NOT NULL,
	"viewer_user_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"granted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_view_grants_organization_id_viewer_user_id_subject_user_id_pk" PRIMARY KEY("organization_id","viewer_user_id","subject_user_id")
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "reports_to_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_view_grants" ADD CONSTRAINT "activity_view_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_view_grants" ADD CONSTRAINT "activity_view_grants_viewer_user_id_users_id_fk" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_view_grants" ADD CONSTRAINT "activity_view_grants_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_view_grants" ADD CONSTRAINT "activity_view_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_view_grants_subject_idx" ON "activity_view_grants" USING btree ("organization_id","subject_user_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_reports_to_user_id_users_id_fk" FOREIGN KEY ("reports_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_org_reports_to_idx" ON "memberships" USING btree ("organization_id","reports_to_user_id") WHERE reports_to_user_id IS NOT NULL;