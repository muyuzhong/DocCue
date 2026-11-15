/**
 * Grafana OSS as a host app: the release tarball (fetched once into .cache/), started with a fresh
 * data directory, signed in anonymously as an admin, seeded with a few data sources and a
 * dashboard, behind the DocCue proxy.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { freePort, startProxy, type Proxy } from '../proxy.js';
import { DASHBOARD, DATASOURCES } from './seed.js';

export const VERSION = '13.3.1';
const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
const HOME = join(CACHE, 'grafana');
const TARBALL = `https://dl.grafana.com/oss/release/grafana-${VERSION}.linux-amd64.tar.gz`;

const INSTRUCTIONS = `You are the in-app assistant of Grafana, the open-source platform for dashboards, data sources and alerting.
Help the user get started and solve problems: explain what is going on from what they did, the errors and the current screen, and point at the next step on the page.`;

/** Fetches and unpacks the release once, checking it against the published SHA-256. */
async function install(): Promise<void> {
  if (existsSync(join(HOME, 'bin', 'grafana')) && readFileSync(join(HOME, 'VERSION'), 'utf8').trim() === VERSION) return;
  console.log(`Downloading Grafana ${VERSION} (about 500 MB, once)…`);
  const download = join(CACHE, 'download');
  rmSync(download, { recursive: true, force: true });
  mkdirSync(download, { recursive: true });
  const expected = (await (await fetch(`${TARBALL}.sha256`)).text()).trim().split(/\s+/)[0];
  const file = join(download, 'grafana.tar.gz');
  const response = await fetch(TARBALL);
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file));
  const hash = createHash('sha256');
  await pipeline(Readable.from(readFileSync(file)), hash);
  if (hash.digest('hex') !== expected) throw new Error('Grafana download: checksum mismatch');
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  execFileSync('tar', ['-xzf', file, '-C', HOME, '--strip-components=1']);
  rmSync(download, { recursive: true, force: true });
}

export interface Grafana {
  /** Grafana through the DocCue proxy: what the browser opens. */
  url: string;
  /** Grafana itself, for checking results through its HTTP API. */
  api(path: string, init?: RequestInit): Promise<unknown>;
  proxy: Proxy;
  close(): Promise<void>;
}

export interface GrafanaOptions {
  /** Grafana's UI language, e.g. `zh-Hans` or `en-US`. */
  language?: string;
  /** Where the proxy listens; a free port when absent. */
  port?: number;
}

export async function startGrafana(options: GrafanaOptions = {}): Promise<Grafana> {
  await install();
  const [grafanaPort, proxyPort] = [await freePort(), options.port ?? (await freePort())];
  const data = join(CACHE, `grafana-data-${grafanaPort}`);
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  const upstream = `http://127.0.0.1:${grafanaPort}`;
  const proxy = await startProxy({ upstream, port: proxyPort, instructions: INSTRUCTIONS, name: 'grafana' });

  const child: ChildProcess = spawn(join(HOME, 'bin', 'grafana'), ['server', '--homepath', HOME], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GF_PATHS_DATA: data,
      GF_PATHS_LOGS: join(data, 'log'),
      GF_PATHS_PLUGINS: join(data, 'plugins'),
      GF_SERVER_HTTP_ADDR: '127.0.0.1',
      GF_SERVER_HTTP_PORT: String(grafanaPort),
      GF_SERVER_ROOT_URL: `${proxy.url}/`,
      GF_AUTH_ANONYMOUS_ENABLED: 'true',
      GF_AUTH_ANONYMOUS_ORG_ROLE: 'Admin',
      GF_AUTH_DISABLE_LOGIN_FORM: 'true',
      GF_USERS_DEFAULT_LANGUAGE: options.language ?? 'zh-Hans',
      GF_ANALYTICS_REPORTING_ENABLED: 'false',
      GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
      GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
      GF_NEWS_NEWS_FEED_ENABLED: 'false',
      GF_PLUGINS_PREINSTALL_DISABLED: 'true',
      GF_LOG_LEVEL: 'warn',
    },
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));

  const close = async () => {
    await proxy.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    rmSync(data, { recursive: true, force: true });
  };

  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${upstream}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as unknown) : undefined;
  };

  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Grafana exited (${child.exitCode}):\n${stderr}`);
      const healthy = await fetch(`${upstream}/api/health`).then((r) => r.ok, () => false);
      if (healthy) break;
      if (Date.now() > deadline) throw new Error(`Grafana did not start in time:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    for (const datasource of DATASOURCES) await api('/api/datasources', { method: 'POST', body: JSON.stringify(datasource) });
    await api('/api/dashboards/db', { method: 'POST', body: JSON.stringify({ dashboard: DASHBOARD, overwrite: true }) });
  } catch (error) {
    await close();
    throw error;
  }
  return { url: proxy.url, api, proxy, close };
}
