import { z } from 'zod';

/**
 * Boot-time config. Fails fast if anything required is missing.
 * Validated once at process start; everything else imports the parsed object.
 */
const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_PUBLIC_URL: z.string().url().default('http://localhost:3001'),
  API_CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),

  /** Public URL of the web dashboard — used to build the View-online handoff link. */
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  JWT_SIGNING_KEY_PRIMARY: z.string().min(32),
  JWT_SIGNING_KEY_NEXT: z.string().optional(),
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  AUTH_INTERNAL_SHARED_SECRET: z.string().min(16),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SENTRY_DSN: z.string().optional(),

  /**
   * Where screenshots are written. MVP: local filesystem. Set to an
   * absolute path; defaults to `./data/screenshots` next to the api process.
   *
   * We'll swap this for an S3 driver later — see [07-storage.md].
   */
  STORAGE_DIR: z.string().default('./data/screenshots'),
});

export type Config = z.infer<typeof Schema>;

let _config: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (_config) return _config;
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('[config] invalid environment:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration — see logs above');
  }
  _config = parsed.data;
  return _config;
}
