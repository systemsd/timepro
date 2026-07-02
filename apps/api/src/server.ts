import { loadRootEnv } from './lib/loadEnv';
loadRootEnv();

import { buildApp } from './app';
import { loadConfig } from './config';
import { closeDb } from '@timepro/db';
import { initObservability } from './lib/observability';
import { pruneAgentLogs, pruneAllOrgs } from './lib/retention';
import { sweepAbandonedTimers } from './lib/timer-sweep';

async function main() {
  const config = loadConfig();
  // Initialize error tracking before anything else (no-op unless SENTRY_DSN is set).
  initObservability(config);
  const app = await buildApp(config);

  try {
    await app.listen({ host: config.API_HOST, port: config.API_PORT });
    app.log.info(
      `TimePro API listening on http://${config.API_HOST}:${config.API_PORT} (${config.NODE_ENV})`,
    );
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }

  // In-process screenshot-retention sweep (no scheduler service yet — Phase 8).
  // Runs shortly after boot, then every 12h. `unref` so it never blocks shutdown.
  const sweep = async () => {
    try {
      const deleted = await pruneAllOrgs();
      if (deleted > 0) app.log.info({ deleted }, 'screenshot retention sweep');
    } catch (err) {
      app.log.error({ err }, 'screenshot retention sweep failed');
    }
    try {
      const deletedLogs = await pruneAgentLogs();
      if (deletedLogs > 0) app.log.info({ deleted: deletedLogs }, 'agent-logs retention sweep');
    } catch (err) {
      app.log.error({ err }, 'agent-logs retention sweep failed');
    }
  };
  setTimeout(sweep, 30_000).unref();
  setInterval(sweep, 12 * 60 * 60 * 1000).unref();

  // Abandoned-timer sweep — close/trim timers left open across sleep/crash so a
  // forgotten timer can't inflate the roster/reports. Runs soon after boot, then
  // every 10 min. Self-healing across all users; back-dates to last real activity.
  const timerSweep = async () => {
    try {
      const { corrected } = await sweepAbandonedTimers();
      if (corrected > 0) app.log.info({ corrected }, 'abandoned-timer sweep');
    } catch (err) {
      app.log.error({ err }, 'abandoned-timer sweep failed');
    }
  };
  setTimeout(timerSweep, 45_000).unref();
  setInterval(timerSweep, 10 * 60 * 1000).unref();

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeDb();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] bootstrap failed', err);
  process.exit(1);
});
