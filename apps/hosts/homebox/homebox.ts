/**
 * Homebox as a host app: the release binary (fetched once into .cache/), started on a fresh
 * SQLite database, with a signed-up user and a few items, behind the DocCue proxy. DocCue gets
 * the user-facing part of Homebox's own documentation, fetched from its repository at the same
 * version.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownDocs } from '@doccue/core/node';
import type { Browser } from 'playwright-core';
import { download, fetchText, waitUntil, type Host, type HostOptions } from '../host.js';
import { freePort, startProxy } from '../proxy.js';
import { seed } from './seed.js';

export const VERSION = '0.27.1';
const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
const HOME = join(CACHE, 'homebox');
const RELEASE = `https://github.com/sysadminsmedia/homebox/releases/download/v${VERSION}/`;
const TARBALL = 'homebox_Linux_x86_64.tar.gz';

/** The user guide and the advanced pages a user (not an operator) would read. */
const DOCS = [
  'user-guide/index.mdx',
  'user-guide/items.mdx',
  'user-guide/locations.mdx',
  'user-guide/entity-types.mdx',
  'user-guide/notifiers.mdx',
  'user-guide/tips-tricks.mdx',
  'advanced/import-csv.mdx',
  'advanced/entity-merge-upgrade.mdx',
  'advanced/external-label-service.mdx',
];
const DOCS_DIR = join(CACHE, `homebox-docs-${VERSION}`);

export const USER = { name: 'Demo', email: 'demo@example.com', password: 'demo-pass-123' };

const INSTRUCTIONS = `You are the in-app assistant of Homebox, the open-source inventory and organization system for home users: items, the locations they are kept in, tags, and maintenance.
Help the user get started and solve problems: explain what is going on from what they did, the errors and the current screen, and point at the next step on the page.`;

async function install(): Promise<void> {
  const version = join(HOME, 'VERSION');
  if (existsSync(join(HOME, 'homebox')) && existsSync(version) && readFileSync(version, 'utf8').trim() === VERSION) return;
  console.log(`Downloading Homebox ${VERSION} (about 40 MB, once)…`);
  mkdirSync(HOME, { recursive: true });
  const sums = await fetchText(`${RELEASE}checksums.txt`);
  const expected = sums.split('\n').find((line) => line.trim().endsWith(` ${TARBALL}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`no checksum for ${TARBALL}`);
  const file = join(CACHE, `homebox-${VERSION}.tar.gz`);
  await download(`${RELEASE}${TARBALL}`, file, expected);
  execFileSync('tar', ['-xzf', file, '-C', HOME, 'homebox']);
  writeFileSync(version, VERSION);
  rmSync(file, { force: true });
}

async function fetchDocs(): Promise<string> {
  for (const path of DOCS) {
    const file = join(DOCS_DIR, path);
    if (existsSync(file)) continue;
    const text = await fetchText(`https://raw.githubusercontent.com/sysadminsmedia/homebox/v${VERSION}/docs/src/content/docs/en/${path}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return DOCS_DIR;
}

export async function startHomebox(options: HostOptions = {}): Promise<Host> {
  await install();
  const docs = options.docs === false ? undefined : await markdownDocs(await fetchDocs());
  const [appPort, proxyPort] = [await freePort(), options.port ?? (await freePort())];
  const data = join(CACHE, `homebox-data-${appPort}`);
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  const upstream = `http://127.0.0.1:${appPort}`;
  const proxy = await startProxy({ upstream, port: proxyPort, instructions: INSTRUCTIONS, docs, name: 'homebox' });

  // Homebox keeps its database and uploads under the directory it runs in.
  const child: ChildProcess = spawn(join(HOME, 'homebox'), [], {
    cwd: data,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      HBOX_MODE: 'production',
      HBOX_WEB_HOST: '127.0.0.1',
      HBOX_WEB_PORT: String(appPort),
      HBOX_AUTH_API_KEY_PEPPER: randomBytes(48).toString('base64'),
      HBOX_OPTIONS_ALLOW_ANALYTICS: 'false',
      HBOX_OPTIONS_GITHUB_RELEASE_CHECK: 'false',
      HBOX_LOG_LEVEL: 'warn',
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

  let token = '';
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${upstream}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}), ...init.headers },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as unknown) : undefined;
  };

  try {
    await waitUntil(
      () => fetch(`${upstream}/api/v1/status`).then((r) => r.ok),
      'Homebox',
      () => (child.exitCode === null ? undefined : `${child.exitCode}\n${stderr}`),
    );
    await api('/api/v1/users/register', { method: 'POST', body: JSON.stringify(USER) });
    token = ((await api('/api/v1/users/login', { method: 'POST', body: JSON.stringify({ username: USER.email, password: USER.password }) })) as { token: string }).token;
    await seed(api);
  } catch (error) {
    await close();
    throw error;
  }

  // Signed in through the proxy, so the session cookies belong to the address the browser opens.
  const newPage = async (browser: Browser) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: options.language ?? 'zh-CN' });
    const signIn = await context.request.post(`${proxy.url}/api/v1/users/login`, { data: { username: USER.email, password: USER.password, stayLoggedIn: true } });
    if (!signIn.ok()) throw new Error(`Homebox sign-in: ${signIn.status()}`);
    const page = await context.newPage();
    page.on('close', () => void context.close());
    return page;
  };
  return { url: proxy.url, api, newPage, proxy, close };
}
