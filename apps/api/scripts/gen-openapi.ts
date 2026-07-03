/**
 * Build the OpenAPI document from the live Fastify + Zod route schemas and write
 * it to `apps/api/openapi/openapi.json` (a committed, diff-able artifact + input
 * for client codegen). `@fastify/swagger` is registered in `buildApp`, so
 * `app.swagger()` returns the real spec.
 */
import { loadRootEnv } from '../src/lib/loadEnv';
loadRootEnv();

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

async function main() {
  const app = await buildApp(loadConfig());
  await app.ready();

  const doc =
    typeof app.swagger === 'function'
      ? app.swagger()
      : { openapi: '3.1.0', info: { title: 'TimePro API', version: '0.1.0' }, paths: {} };

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const out = resolve(__dirname, '..', 'openapi', 'openapi.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(doc, null, 2));

  const pathCount = Object.keys((doc as { paths?: object }).paths ?? {}).length;
  // eslint-disable-next-line no-console
  console.log(`[openapi] wrote ${out} (${pathCount} paths)`);

  await app.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[openapi] failed', err);
  process.exit(1);
});
