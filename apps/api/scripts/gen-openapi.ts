/**
 * Build the OpenAPI document from the live Fastify route schemas.
 * Output is written next to the SDK so codegen picks it up.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

async function main() {
  const config = loadConfig();
  const app = await buildApp(config);
  await app.ready();

  // @fastify/swagger is registered by `buildApp` in a real impl; the stub here
  // emits a minimal placeholder so the SDK codegen pipeline can run end-to-end
  // even before swagger wiring lands.
  const swagger = (app as unknown as { swagger?: () => Record<string, unknown> }).swagger;
  const doc = typeof swagger === 'function'
    ? swagger()
    : {
        openapi: '3.1.0',
        info: { title: 'TrackFlow API', version: '0.1.0' },
        paths: {},
      };

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outApi = resolve(__dirname, '..', 'openapi', 'openapi.json');
  const outSdk = resolve(__dirname, '..', '..', '..', 'packages', 'desktop-sdk', 'openapi', 'openapi.json');

  await mkdir(dirname(outApi), { recursive: true });
  await mkdir(dirname(outSdk), { recursive: true });
  await writeFile(outApi, JSON.stringify(doc, null, 2));
  await writeFile(outSdk, JSON.stringify(doc, null, 2));

  // eslint-disable-next-line no-console
  console.log(`[openapi] wrote ${outApi}`);
  // eslint-disable-next-line no-console
  console.log(`[openapi] wrote ${outSdk}`);

  await app.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[openapi] failed', err);
  process.exit(1);
});
