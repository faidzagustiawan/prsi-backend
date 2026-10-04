import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';

const root = fileURLToPath(new URL('../', import.meta.url));
// Export is offline: never load production secrets or connect to DB/Redis.
Object.assign(process.env, {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://docs:docs@127.0.0.1:1/docs',
  REPORT_DATABASE_URL: 'postgresql://docs:docs@127.0.0.1:1/docs',
  SESSION_DATABASE_URL: 'postgresql://docs:docs@127.0.0.1:1/docs',
  REDIS_URL: 'redis://127.0.0.1:1',
  JWT_SECRET: 'documentation-only-not-a-runtime-secret-01',
  COOKIE_SECRET: 'documentation-only-not-a-runtime-secret-02',
  API_URL: 'https://podorukunsi.my.id',
  SYNC_ENABLED: 'false',
});
const { buildApp } = await import('../src/app.js');
const { closeDatabase } = await import('../src/config/database.js');
const app = await buildApp({ logger: false, documentationOnly: true });
try {
  await app.ready();
  const document = app.swagger();
  await SwaggerParser.validate(structuredClone(document));
  const output = path.join(root, 'docs/generated');
  await mkdir(output, { recursive: true });
  const json = JSON.stringify(document, null, 2);
  await writeFile(path.join(output, 'openapi.json'), json + '\n');
  const template = await readFile(path.join(root, 'docs/scalar.template.html'), 'utf8');
  const bundle = await readFile(path.join(root, 'node_modules/@scalar/api-reference/dist/browser/standalone.js'), 'utf8');
  const html = template
    .replace('/* SCALAR_BUNDLE */', () => bundle.replace(/<\/script/gi, '<\\/script'))
    .replace('/* OPENAPI_DOCUMENT */', () => JSON.stringify(document).replace(/</g, '\\u003c'));
  await writeFile(path.join(output, 'scalar.html'), html);
  const operations = Object.values(document.paths).reduce((sum, item) => sum + Object.keys(item).length, 0);
  console.log(`OpenAPI valid: ${operations} operations, ${document.tags.length} modules.`);
  console.log(`Scalar standalone: ${path.join(output, 'scalar.html')}`);
} finally {
  await app.close();
  await closeDatabase();
}
