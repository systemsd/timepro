CREATE TABLE IF NOT EXISTS "app_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"time_entry_id" uuid,
	"app_name" text NOT NULL,
	"app_bundle_id" text,
	"window_title" text,
	"category" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "url_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"time_entry_id" uuid,
	"browser" text NOT NULL,
	"domain" text NOT NULL,
	"url" text,
	"page_title" text,
	"category" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_usage_user_started_idx" ON "app_usage" USING btree ("organization_id","user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "url_usage_domain_idx" ON "url_usage" USING btree ("organization_id","domain","started_at" DESC NULLS LAST);