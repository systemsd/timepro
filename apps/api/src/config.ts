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

  /** OpsCore integration (Phase 3). */
  OPSCORE_API_URL: z.string().url().default('http://localhost:3001'),
  OPSCORE_HANDOFF_SECRET: z.string().default('opscore-timepro-shared-handoff-secret-dev'),
  OPSCORE_API_KEY: z.string().default('opscore-timepro-service-api-key-dev'),
  OPSCORE_ORG_SLUG: z.string().default('demo'),
  /** Name for the TimePro org JIT-created on the first OpsCore login (slug = OPSCORE_ORG_SLUG). */
  OPSCORE_ORG_NAME: z.string().default('Systemsd'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  JWT_SIGNING_KEY_PRIMARY: z.string().min(32),
  JWT_SIGNING_KEY_NEXT: z.string().optional(),
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  AUTH_INTERNAL_SHARED_SECRET: z.string().min(16),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SENTRY_DSN: z.string().optional(),
  /** Fraction of transactions traced when Sentry is enabled (0–1). */
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  /**
   * Interactive API docs at `/docs` (Scalar). Exposed **only** when
   * `API_DOCS_PASSWORD` is set (in ANY env), always behind HTTP Basic auth with a
   * **dedicated** credential — NOT the app/OpsCore login. Unset → not exposed
   * anywhere. (We don't gate on NODE_ENV — it's unreliable on this deploy.)
   */
  API_DOCS_USER: z.string().default('docs'),
  API_DOCS_PASSWORD: z.string().optional(),

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
