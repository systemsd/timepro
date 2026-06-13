import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

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
