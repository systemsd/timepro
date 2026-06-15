import { loadRootEnv } from './lib/loadEnv';
loadRootEnv();

import { buildApp } from './app';
import { loadConfig } from './config';
import { closeDb } from '@timepro/db';

async function main() {
  const config = loadConfig();
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
