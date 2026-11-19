/**
 * A small app with DocCue on it, on Node's own http server: the page, its API, the DocCue
 * handler at /doccue, and the bridge's files for the page's import map.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, createModelFromEnv, withRetry } from '@doccue/core';
import { markdownDocs, toNodeHandler } from '@doccue/core/node';

const here = dirname(fileURLToPath(import.meta.url));

// The backend: one handler. The model comes from the environment (see .env.example); the docs
// are the app's own, in Markdown.
const doccue = toNodeHandler(
  createHandler({
    model: withRetry(createModelFromEnv(process.env)),
    instructions: 'You are the in-app assistant of Teamspace, a workspace for small teams. Help people get started and solve problems in the app.',
    docs: await markdownDocs(join(here, 'docs')),
    basePath: '/doccue',
  }),
);

// The bridge is plain ES modules: the page loads them from here through its import map.
const bridgeEntry = fileURLToPath(import.meta.resolve('@doccue/bridge'));
const vendor = {
  '/vendor/bridge/': dirname(bridgeEntry),
  // A dependency of the bridge's, found from where the bridge is (npm, pnpm and yarn lay it out differently).
  '/vendor/protocol/': dirname(createRequire(bridgeEntry).resolve('@doccue/protocol')),
};

// The app's own API: inviting is only allowed for the workspace's email domains.
const allowed = new Set(['acme.test']);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.map': 'application/json' };

async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

async function serveFile(res, root, path) {
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) return res.writeHead(404).end();
  try {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/doccue/')) return doccue(req, res);
  for (const [prefix, root] of Object.entries(vendor)) if (url.pathname.startsWith(prefix)) return serveFile(res, root, url.pathname.slice(prefix.length));

  if (url.pathname === '/api/domains' && req.method === 'GET') return send(res, 200, { domains: [...allowed] });
  if (url.pathname === '/api/domains' && req.method === 'POST') {
    const { domains } = await body(req);
    allowed.clear();
    for (const domain of String(domains).split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)) allowed.add(domain);
    return send(res, 200, { domains: [...allowed] });
  }
  if (url.pathname === '/api/invite' && req.method === 'POST') {
    const { email } = await body(req);
    const domain = String(email).split('@')[1]?.toLowerCase();
    if (!domain) return send(res, 400, { error: 'Enter an email address.' });
    if (!allowed.has(domain)) return send(res, 403, { error: `Invites to @${domain} are not allowed in this workspace.` });
    return send(res, 200, { invited: email });
  }
  if (url.pathname === '/') return serveFile(res, here, 'index.html');
  res.writeHead(404).end();
});

// Only on this machine: the DocCue endpoint calls the model for whoever reaches it. In your app,
// put it behind your own sign-in and rate limits.
const port = Number(process.env.PORT ?? 3000);
server.listen(port, '127.0.0.1', () => console.log(`Teamspace with DocCue: http://localhost:${port}`));
