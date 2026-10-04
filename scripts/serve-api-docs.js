import http from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/', ['scalar.html', 'text/html; charset=utf-8']],
  ['/openapi.json', ['openapi.json', 'application/json; charset=utf-8']],
]);
const server = http.createServer(async (request, response) => {
  const entry = files.get(new URL(request.url, 'http://127.0.0.1').pathname);
  if (!entry || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL(`../docs/generated/${entry[0]}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(503).end('Run npm run docs:build first.');
  }
});
server.listen(3180, '127.0.0.1', () => console.log('Scalar API docs: http://127.0.0.1:3180'));
