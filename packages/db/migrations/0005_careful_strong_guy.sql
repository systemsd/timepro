CREATE TABLE IF NOT EXISTS "agent_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text,
	"agent_version" text,
	"os" text,
	"ts" timestamp with time zone NOT NULL,
	"level" text NOT NULL,
	"event" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_logs_user_ts_idx" ON "agent_logs" USING btree ("organization_id","user_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_logs_created_idx" ON "agent_logs" USING btree ("created_at");