-- Postgres init for local dev. Production migrations live in packages/db/migrations.
-- This file only ensures the extensions and roles we depend on are present.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- App role: tenant-bound, RLS-enforced. Used by api + worker normal connections.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'timepro_app') THEN
    CREATE ROLE timepro_app LOGIN PASSWORD 'timepro_app';
  END IF;
END $$;

-- Bypass role: used by maintenance jobs (rollups, retention sweeps, migrations).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'timepro_admin') THEN
    CREATE ROLE timepro_admin LOGIN PASSWORD 'timepro_admin' BYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE timepro TO timepro_app, timepro_admin;
GRANT USAGE ON SCHEMA public TO timepro_app, timepro_admin;

-- New tables auto-grant
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO timepro_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO timepro_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO timepro_app, timepro_admin;
