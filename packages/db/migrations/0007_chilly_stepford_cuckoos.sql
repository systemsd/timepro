-- Idempotency for app_usage / url_usage ingest.
-- Before creating the UNIQUE indexes we must (a) lock the table so a still-running
-- old app instance can't insert a fresh duplicate mid-migration and abort the build,
-- and (b) delete any duplicates already stored by the pre-fix bug (agent retries
-- double-inserted intervals), keeping the earliest row per key. PKs are UUIDv7, so
-- ORDER BY id keeps the first insert (uuid supports ordering; min(uuid) does not).
-- The migrator wraps this file in one transaction.

-- app_usage --------------------------------------------------------------------
LOCK TABLE "app_usage" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DELETE FROM "app_usage"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "organization_id", "user_id", "device_id", "started_at", "app_name"
      ORDER BY "id"
    ) AS rn
    FROM "app_usage"
  ) t
  WHERE t.rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_usage_natural_uniq" ON "app_usage" USING btree ("organization_id","user_id","device_id","started_at","app_name");--> statement-breakpoint

-- url_usage --------------------------------------------------------------------
LOCK TABLE "url_usage" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DELETE FROM "url_usage"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "organization_id", "user_id", "device_id", "started_at", "domain", "browser"
      ORDER BY "id"
    ) AS rn
    FROM "url_usage"
  ) t
  WHERE t.rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "url_usage_natural_uniq" ON "url_usage" USING btree ("organization_id","user_id","device_id","started_at","domain","browser");
