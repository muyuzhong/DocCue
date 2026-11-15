/**
 * Puts DocCue in front of an app that was not written for it, without changing the app: a reverse
 * proxy that adds the bridge (bundled from the built packages, `dist`) to every HTML page, serves
 * the DocCue handler at /doccue, and passes everything else, WebSockets included, to the app.
 *
 * Listens on 127.0.0.1 only: the app behind it may be running without a login, and the DocCue
 * endpoint calls the model for anyone who reaches it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, createServer as createNetServer, setDefaultAutoSelectFamilyAttemptTimeout, type AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { createHandler, createModelFromEnv, toJsonLine, withRetry, type DocsProvider } from '@doccue/core';
import { toNodeHandler } from '@doccue/core/node';
import { build } from 'vite';

setDefaultAutoSelectFamilyAttemptTimeout(2000);

const HOSTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const BUNDLE_DIR = join(HOSTS_DIR, '.cache', 'bundle');
const ENV_FILE = new URL('../../.env', import.meta.url);
const SCRIPT_PATH = '/__doccue/inject.js';

/** Bundles inject.ts the way a host's build would: from the published entry points (`dist`), not the sources. */
export async function bundleBridge(): Promise<void> {
  if (!existsSync(join(HOSTS_DIR, '../../packages/bridge/dist/index.js'))) throw new Error('packages/bridge/dist is missing: run `pnpm build` first');
  await build({
    configFile: false,
    logLevel: 'warn',
    root: HOSTS_DIR,
    build: {
      outDir: BUNDLE_DIR,
      emptyOutDir: true,
      minify: false,
      sourcemap: true,
      lib: { entry: join(HOSTS_DIR, 'inject.ts'), formats: ['es'], fileName: 'inject' },
    },
  });
}

/** A port nobody listens on right now. */
export async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface ProxyOptions {
  /** The app, e.g. `http://127.0.0.1:3300`. */
  upstream: string;
  /** Where the proxy listens. */
  port: number;
  /** What the host would put in `instructions`. */
  instructions: string;
  docs?: DocsProvider;
  /** Name of the log file under .logs/. */
  name: string;
}

export interface Proxy {
  url: string;
  logFile: string;
  close(): Promise<void>;
}

function decode(body: Buffer, encoding: string | undefined): Buffer {
  if (encoding === 'gzip') return gunzipSync(body);
  if (encoding === 'br') return brotliDecompressSync(body);
  if (encoding === 'deflate') return inflateSync(body);
  return body;
}

/** The bridge's script tag, before </head> (or at the start when there is none). */
function inject(html: string): string {
  const tag = `<script type="module" src="${SCRIPT_PATH}"></script>`;
  const at = html.search(/<\/head>/i);
  return at >= 0 ? `${html.slice(0, at)}${tag}${html.slice(at)}` : `${tag}${html}`;
}

const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.map': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveBundle(path: string, res: ServerResponse): void {
  const file = normalize(join(BUNDLE_DIR, path.slice('/__doccue/'.length).split('?')[0]!));
  if (!file.startsWith(BUNDLE_DIR) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}

export async function startProxy(options: ProxyOptions): Promise<Proxy> {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  await bundleBridge();
  const upstream = new URL(options.upstream);

  const logDir = join(HOSTS_DIR, '.logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${options.name}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}.jsonl`);
  const doccue = toNodeHandler(
    createHandler({
      model: withRetry(createModelFromEnv(process.env)),
      instructions: options.instructions,
      docs: options.docs,
      basePath: '/doccue',
      logger: (record) => appendFileSync(logFile, `${toJsonLine(record)}\n`),
    }),
  );

  let warnedCsp = false;
  const pass = (req: IncomingMessage, res: ServerResponse) => {
    // Uncompressed responses, so HTML can be rewritten; the Host header stays the browser's, so
    // the app's own same-origin checks see what they would without the proxy.
    const headers = { ...req.headers };
    delete headers['accept-encoding'];
    const out = request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      if (!String(upstreamRes.headers['content-type'] ?? '').includes('text/html')) {
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const html = inject(decode(Buffer.concat(chunks), upstreamRes.headers['content-encoding']).toString('utf8'));
        if (responseHeaders['content-security-policy'] && !warnedCsp) {
          warnedCsp = true;
          console.warn(`[proxy] ${options.name} sends a Content-Security-Policy; removed so the injected script runs`);
        }
        delete responseHeaders['content-security-policy'];
        delete responseHeaders['content-encoding'];
        responseHeaders['content-length'] = String(Buffer.byteLength(html));
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        res.end(html);
      });
    });
    out.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`proxy: ${error.message}`);
    });
    req.pipe(out);
  };

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/doccue/')) void doccue(req, res);
    else if (url.startsWith('/__doccue/')) serveBundle(url, res);
    else pass(req, res);
  });

  // WebSockets (live updates and the like): pass the upgrade request through and pipe both ways.
  server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
    const target = connect(Number(upstream.port), upstream.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      target.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });

  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  return {
    url: `http://localhost:${options.port}`,
    logFile,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
