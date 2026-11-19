/**
 * Grafana OSS as a host app: the release tarball (fetched once into .cache/), started with a fresh
 * data directory, signed in anonymously as an admin, seeded with a few data sources and a
 * dashboard, behind the DocCue proxy.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, fetchText, waitUntil, type Host, type HostOptions } from '../host.js';
import { freePort, startProxy } from '../proxy.js';
import { DASHBOARD, DATASOURCES } from './seed.js';

export const VERSION = '13.3.1';
const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
const HOME = join(CACHE, 'grafana');
const TARBALL = `https://dl.grafana.com/oss/release/grafana-${VERSION}.linux-amd64.tar.gz`;

const INSTRUCTIONS = `You are the in-app assistant of Grafana, the open-source platform for dashboards, data sources and alerting.
Help the user get started and solve problems: explain what is going on from what they did, the errors and the current screen, and point at the next step on the page.`;

/** Fetches and unpacks the release once, checking it against the published SHA-256. */
async function install(): Promise<void> {
  const version = join(HOME, 'VERSION');
  if (existsSync(join(HOME, 'bin', 'grafana')) && existsSync(version) && readFileSync(version, 'utf8').trim() === VERSION) return;
  console.log(`Downloading Grafana ${VERSION} (about 500 MB, once)…`);
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `grafana-${VERSION}.tar.gz`);
  const expected = (await fetchText(`${TARBALL}.sha256`)).trim().split(/\s+/)[0]!;
  await download(TARBALL, file, expected);
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  execFileSync('tar', ['-xzf', file, '-C', HOME, '--strip-components=1']);
  writeFileSync(version, VERSION);
  rmSync(file, { force: true });
}

/** Grafana's UI language for a locale: `zh-CN` → `zh-Hans`. */
const grafanaLanguage = (locale: string | undefined) => (!locale || /^zh/i.test(locale) ? 'zh-Hans' : locale);

export async function startGrafana(options: HostOptions = {}): Promise<Host> {
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
      GF_USERS_DEFAULT_LANGUAGE: grafanaLanguage(options.language),
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
    await waitUntil(
      () => fetch(`${upstream}/api/health`).then((r) => r.ok),
      'Grafana',
      () => (child.exitCode === null ? undefined : `${child.exitCode}\n${stderr}`),
    );
    for (const datasource of DATASOURCES) await api('/api/datasources', { method: 'POST', body: JSON.stringify(datasource) });
    await api('/api/dashboards/db', { method: 'POST', body: JSON.stringify({ dashboard: DASHBOARD, overwrite: true }) });
  } catch (error) {
    await close();
    throw error;
  }
  // Anonymous admin: nothing to sign in to.
  const newPage = (browser: Parameters<Host['newPage']>[0]) => browser.newPage({ viewport: { width: 1440, height: 900 } });
  return { url: proxy.url, api, newPage, proxy, close };
}
