import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import underPressure from '@fastify/under-pressure';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { createDb } from '@timepro/db';

import type { Config } from './config';
import { tenantPlugin } from './plugins/tenant';
import { errorMapperPlugin } from './plugins/error-mapper';
import { healthRoutes } from './routes/health';
import { timerRoutes } from './routes/timer';
import { authRoutes } from './routes/auth';
import { projectRoutes } from './routes/projects';
import { screenshotRoutes } from './routes/screenshots';
import { meRoutes } from './routes/me';
import { teamRoutes } from './routes/team';
import { rosterRoutes } from './routes/roster';
import { timelineRoutes } from './routes/timeline';
import { clientRoutes } from './routes/clients';

/**
 * App factory. Used by both `server.ts` and integration tests.
 * Never starts listening here — the caller decides.
 */
export async function buildApp(config: Config): Promise<FastifyInstance> {
  // Eagerly initialize the DB pool so a misconfigured DATABASE_URL fails
  // fast at boot instead of on first request.
  createDb({ url: config.DATABASE_URL });

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l' } } }
        : {}),
      redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
    },
    requestIdLogLabel: 'request_id',
    requestIdHeader: 'x-request-id',
    genReqId: (req) =>
      // Reuse upstream request id (from Nginx / CDN) if present, otherwise generate.
      (req.headers['x-request-id'] as string | undefined) ?? cryptoRandomId(),
    ajv: { customOptions: { removeAdditional: 'all' } },
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 25 * 1024 * 1024, // 25 MB, screenshot fallback path
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // -------- platform plugins --------
  await app.register(sensible);
  await app.register(cookie, { secret: config.AUTH_INTERNAL_SHARED_SECRET });
  await app.register(cors, {
    origin: config.API_CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(underPressure, {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 1.5 * 1024 * 1024 * 1024,
    maxRssBytes: 2 * 1024 * 1024 * 1024,
    retryAfter: 30,
  });
  await app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024, // single screenshot cap
      files: 1,
      fields: 4,
    },
  });

  // -------- domain plugins --------
  await app.register(errorMapperPlugin);
  await app.register(tenantPlugin);

  // -------- routes --------
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/v1' });
  await app.register(projectRoutes, { prefix: '/v1' });
  await app.register(timerRoutes, { prefix: '/v1' });
  await app.register(screenshotRoutes, { prefix: '/v1' });
  await app.register(meRoutes, { prefix: '/v1' });
  await app.register(teamRoutes, { prefix: '/v1' });
  await app.register(rosterRoutes, { prefix: '/v1' });
  await app.register(timelineRoutes, { prefix: '/v1' });
  await app.register(clientRoutes, { prefix: '/v1' });

  return app;
}

function cryptoRandomId(): string {
  // Tiny ID — only used when an upstream id is missing. Not cryptographically
  // important; the pino logger uses it for correlation, not auth.
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}
