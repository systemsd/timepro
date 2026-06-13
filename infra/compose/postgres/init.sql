-- Postgres init for local dev. Production migrations live in packages/db/migrations.
-- This file only ensures the extensions and roles we depend on are present.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- App role: tenant-bound, RLS-enforced. Used by api + worker normal connections.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trackflow_app') THEN
    CREATE ROLE trackflow_app LOGIN PASSWORD 'trackflow_app';
  END IF;
END $$;

-- Bypass role: used by maintenance jobs (rollups, retention sweeps, migrations).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trackflow_admin') THEN
    CREATE ROLE trackflow_admin LOGIN PASSWORD 'trackflow_admin' BYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE trackflow TO trackflow_app, trackflow_admin;
GRANT USAGE ON SCHEMA public TO trackflow_app, trackflow_admin;

-- New tables auto-grant
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO trackflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO trackflow_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO trackflow_app, trackflow_admin;
