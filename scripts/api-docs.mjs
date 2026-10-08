// Serves the API's documentation (docs/api/openapi.json) in Swagger UI on this machine only, and
// opens it in the browser. Usage: pnpm api:docs   (regenerates the spec first; Ctrl+C to stop)
// "Try it out" is off: the routes need AWS-signed requests, which a browser can't make. Hosted
// docs (dev and stage only) come with the web app.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const PORT = Number(process.env.API_DOCS_PORT ?? 8090);
const dist = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));
const spec = new URL('../docs/api/openapi.json', import.meta.url);

// Only these files are served: nothing else on disk is reachable.
const ASSETS = {
  '/swagger-ui.css': 'text/css',
  '/swagger-ui-bundle.js': 'text/javascript',
  '/swagger-ui-standalone-preset.js': 'text/javascript',
  '/favicon-32x32.png': 'image/png',
};

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Hearth API</title>
  <link rel="icon" href="/favicon-32x32.png">
  <link rel="stylesheet" href="/swagger-ui.css">
</head>
<body>
  <div id="docs"></div>
  <script src="/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: '/openapi.json', dom_id: '#docs', supportedSubmitMethods: [], deepLinking: true });
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  } else if (path === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(readFileSync(spec));
  } else if (Object.hasOwn(ASSETS, path)) {
    res.writeHead(200, { 'content-type': ASSETS[path] }).end(readFileSync(join(dist, path.slice(1))));
  } else {
    res.writeHead(404).end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  process.stdout.write(`Hearth API docs: ${url}  (Ctrl+C to stop)\n`);
  const [command, ...args] =
    process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : [process.platform === 'darwin' ? 'open' : 'xdg-open', url];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
});
