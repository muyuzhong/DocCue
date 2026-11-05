/**
 * The playground server: one Node process serving the demo app (Vite dev server in middleware
 * mode), the DocCue handler at /doccue, and a mock backend at /api.
 *
 *   pnpm playground        → http://localhost:5173
 *
 * The model comes from the repository's root .env (see .env.example). Every event, turn and
 * model call is logged to apps/playground/.logs/ (replay one with `pnpm replay`).
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHandler, createModelFromEnv, createScheduler, statusContext, toJsonLine, withRetry } from '@doccue/core';
import { toNodeHandler } from '@doccue/core/node';
import { createServer as createViteServer, defaultClientConditions } from 'vite';

const APP_DIR = fileURLToPath(new URL('.', import.meta.url));
const ENV_FILE = new URL('../../.env', import.meta.url);

const INSTRUCTIONS = `你是「数据平台」的应用内助手。数据平台用来接入和管理数据库数据源：在「数据源」页面查看和删除数据源，在「新建数据源」页面填写名称、数据库类型、主机地址、端口、用户名和密码，先点「测试连接」，连接成功后才能「保存」。
各数据库的默认端口：MySQL 3306，PostgreSQL 5432，ClickHouse 8123。
用户遇到问题时，结合状态栏里的页面、操作和报错，直接说明原因和下一步该怎么做，简短具体。`;

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
const datasources: Datasource[] = [
  { id: 1, name: 'mysql-prod', kind: 'MySQL', host: '10.0.0.12', port: 3306, status: '正常' },
  { id: 2, name: 'pg-test', kind: 'PostgreSQL', host: '10.0.0.31', port: 5432, status: '连接失败' },
  { id: 3, name: 'clickhouse-logs', kind: 'ClickHouse', host: 'ch.internal', port: 8123, status: '正常' },
];

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

  const logDir = new URL('.logs/', import.meta.url);
  mkdirSync(logDir, { recursive: true });
  const logFile = new URL(`playground-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`, logDir);

  const scheduler = createScheduler({
    model: withRetry(model),
    context: statusContext({ instructions: INSTRUCTIONS }),
    logger: (record) => appendFileSync(logFile, `${toJsonLine(record)}\n`),
  });
  const doccue = toNodeHandler(createHandler({ scheduler, basePath: '/doccue', debug: true }));

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
