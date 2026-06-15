import { config } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit imports this file directly, so we can't use the `loadRootEnv`
// helper (which relies on import.meta.url and the TS module graph). Load
// the root .env relative to *this* file's directory using __dirname.
config({ path: resolve(__dirname, '..', '..', '.env'), override: false });

const url =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL ??
  (() => {
    throw new Error('DATABASE_URL or DATABASE_ADMIN_URL must be set');
  })();

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  verbose: true,
  strict: true,
  casing: 'snake_case',
});
