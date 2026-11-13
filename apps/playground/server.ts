/**
 * The playground server: one Node process serving the demo app (Vite dev server in middleware
 * mode), the DocCue handler at /doccue, and a mock backend at /api.
 *
 *   pnpm playground        → http://localhost:5173
 *
 * The model comes from the repository's root .env (see .env.example). Every request and model
 * call is logged to apps/playground/.logs/ (replay one with `pnpm replay`).
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setDefaultAutoSelectFamilyAttemptTimeout, type AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHandler, createModelFromEnv, renderConversation, toJsonLine, withRetry, type TurnRequest } from '@doccue/core';
import { markdownDocs, toNodeHandler } from '@doccue/core/node';
import { createServer as createViteServer, defaultClientConditions } from 'vite';

// Node gives each address of a host only 250 ms to connect before trying the next one; on a slow
// link every attempt times out and the request fails with ETIMEDOUT. Give them longer.
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const APP_DIR = fileURLToPath(new URL('.', import.meta.url));
const ENV_FILE = new URL('../../.env', import.meta.url);

// What the product is and how it works lives in docs/; the instructions only set the role.
const INSTRUCTIONS = `你是「数据平台」的应用内助手，帮用户上手和解决使用中的问题。
用户遇到问题时，结合他的操作、报错和当前界面，直接说明原因，并在页面上指给他看下一步该怎么做。`;
const DOCS_DIR = fileURLToPath(new URL('docs/', import.meta.url));

// --- mock backend -------------------------------------------------------------------------------

interface Datasource {
  id: number;
  name: string;
  kind: string;
  host: string;
  port: number;
  status: string;
}

const DEFAULT_PORTS: Record<string, number> = { MySQL: 3306, PostgreSQL: 5432, ClickHouse: 8123 };
const SEED: Datasource[] = [
  { id: 1, name: 'mysql-prod', kind: 'MySQL', host: '10.0.0.12', port: 3306, status: '正常' },
  { id: 2, name: 'pg-test', kind: 'PostgreSQL', host: '10.0.0.31', port: 5432, status: '连接失败' },
  { id: 3, name: 'clickhouse-logs', kind: 'ClickHouse', host: 'ch.internal', port: 8123, status: '正常' },
];
/** The mock data; every `start()` begins with the seed again. */
const datasources: Datasource[] = [];

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function api(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/api/datasources' && req.method === 'GET') return send(res, 200, datasources);
  if (pathname === '/api/datasources' && req.method === 'POST') {
    const body = await readJson(req);
    const item: Datasource = {
      id: Math.max(0, ...datasources.map((d) => d.id)) + 1,
      name: String(body.name || '未命名'),
      kind: String(body.kind),
      host: String(body.host),
      port: Number(body.port),
      status: '正常',
    };
    datasources.push(item);
    return send(res, 201, item);
  }
  const match = /^\/api\/datasources\/(\d+)$/.exec(pathname);
  if (match && req.method === 'DELETE') {
    const index = datasources.findIndex((d) => d.id === Number(match[1]));
    if (index >= 0) datasources.splice(index, 1);
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/test-connection' && req.method === 'POST') {
    const { kind, host, port } = await readJson(req);
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (Number(port) !== DEFAULT_PORTS[String(kind)]) return send(res, 502, { message: `connection refused: ${String(host)}:${String(port)}` });
    return send(res, 200, { ok: true, version: `${String(kind)} 16.2` });
  }
  return send(res, 404, { message: 'not found' });
}

// --- server -------------------------------------------------------------------------------------

export async function start(port = Number(process.env.PORT ?? 5173)): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const model = createModelFromEnv(process.env);
  datasources.splice(0, datasources.length, ...SEED.map((item) => ({ ...item })));

  const logDir = new URL('.logs/', import.meta.url);
  mkdirSync(logDir, { recursive: true });
  const logFile = new URL(`playground-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`, logDir);

  const doccue = toNodeHandler(
    createHandler({
      model: withRetry(model),
      instructions: INSTRUCTIONS,
      // These docs are small enough to go into the system prompt whole. Real products' docs rarely
      // are, so the playground looks things up through search_docs / read_doc, as most hosts will.
      docs: await markdownDocs(DOCS_DIR, { inlineMaxChars: 0 }),
      basePath: '/doccue',
      logger: (record) => appendFileSync(logFile, `${toJsonLine(record)}\n`),
    }),
  );
  // For the "what the agent sees" panel: what the model was sent last (a question or a guide
  // result), as it reads it.
  const debug = async (req: IncomingMessage, res: ServerResponse) => {
    const last = renderConversation((await readJson(req)) as unknown as TurnRequest).at(-1);
    const text = last?.role === 'tool' ? last.results.map((result) => result.content).join('\n') : last?.role === 'user' ? last.content : '';
    send(res, 200, { text });
  };

  const vite = await createViteServer({
    root: APP_DIR,
    configFile: false,
    appType: 'spa',
    logLevel: 'warn',
    server: { middlewareMode: true },
    // Load the workspace packages from their TypeScript sources.
    resolve: { conditions: ['source', ...defaultClientConditions] },
  });

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/doccue/')) void doccue(req, res);
    else if (url === '/debug/render') void debug(req, res).catch((error: unknown) => send(res, 500, { message: String(error) }));
    else if (url.startsWith('/api/')) void api(req, res).catch((error: unknown) => send(res, 500, { message: String(error) }));
    else vite.middlewares(req, res);
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const { port: actual } = server.address() as AddressInfo;

  return {
    url: `http://localhost:${actual}`,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await vite.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start()
    .then(({ url }) => {
      console.log(`DocCue playground: ${url}`);
      console.log(`日志：${fileURLToPath(new URL('.logs/', import.meta.url))}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
