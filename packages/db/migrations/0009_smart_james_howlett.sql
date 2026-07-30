-- Internal Products (Phase A): mirror tables + product attribution.
--
-- `products` / `product_members` mirror OpsCore Internal Products the same way
-- `projects` / `project_members` mirror client projects. `tasks.product_id` and
-- `time_entries.product_id` are new NULLABLE columns with no default, so both
-- ADD COLUMNs are metadata-only (no table rewrite) even on `time_entries`.
--
-- The two XOR checks are added NOT VALID **deliberately**: enforcement on every
-- future INSERT/UPDATE is identical to a validated constraint, but Postgres skips
-- the full-table validation scan. No existing row can violate them — the column
-- being tested is created a few statements above, so it is NULL everywhere. This
-- matters because the migrator wraps this whole file in ONE transaction, so a
-- validating scan of `time_entries` (the highest-volume table) would hold ACCESS
-- EXCLUSIVE for its duration. Run `VALIDATE CONSTRAINT` out-of-band later if we
-- ever want the planner to trust them for constraint exclusion.
--
-- `time_entries_product_started_idx` is a partial index (product_id IS NOT NULL),
-- so it indexes zero rows today and builds instantly. CONCURRENTLY is not an
-- option inside the migrator's transaction and is not needed at this size.
CREATE TABLE IF NOT EXISTS "product_members" (
	"product_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_members_product_id_user_id_pk" PRIMARY KEY("product_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"opscore_product_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"stage" text DEFAULT 'IDEA' NOT NULL,
	"color" text DEFAULT '#0ea5e9' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "product_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_members" ADD CONSTRAINT "product_members_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_members" ADD CONSTRAINT "product_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_members_user_idx" ON "product_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_org_opscore_unique" ON "products" USING btree ("organization_id","opscore_product_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_org_product_idx" ON "tasks" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_entries_product_started_idx" ON "time_entries" USING btree ("organization_id","product_id","started_at" DESC NULLS LAST) WHERE product_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_xor_product" CHECK (not ("tasks"."project_id" is not null and "tasks"."product_id" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_xor_product" CHECK (not ("time_entries"."project_id" is not null and "time_entries"."product_id" is not null)) NOT VALID;