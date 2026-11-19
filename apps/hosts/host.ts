/**
 * What every host app gives the scripts (serve, look, ask): how to start it with DocCue on it,
 * the screens to look at, and the questions to ask.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { Browser, Page } from 'playwright-core';
import type { Proxy } from './proxy.js';

export interface Host {
  /** The app through the DocCue proxy: what the browser opens. */
  url: string;
  /** The app's own HTTP API, signed in, for seeding and for checking results. */
  api(path: string, init?: RequestInit): Promise<unknown>;
  /** A page as the user would see the app: signed in, in the app's language. Closing it closes what it needs. */
  newPage(browser: Browser): Promise<Page>;
  proxy: Proxy;
  close(): Promise<void>;
}

export interface HostOptions {
  /** The app's UI language, e.g. `zh-CN` or `en-US`. */
  language?: string;
  /** Where the proxy listens; a free port when absent. */
  port?: number;
  /** false: give DocCue none of the app's docs, to compare answers with and without them. */
  docs?: boolean;
}

/** A path in the app, or how to find it (e.g. an item's page, whose id comes from the seed). */
export type Path = string | ((host: Host) => Promise<string>);

export const resolvePath = (path: Path, host: Host): Promise<string> => (typeof path === 'string' ? Promise.resolve(path) : path(host));

export interface View {
  name: string;
  path: Path;
  /** What to do on the page before looking, e.g. open a menu. */
  prepare?: (page: Page) => Promise<void>;
}

export interface Case {
  name: string;
  start: Path;
  /** The app's UI language for this case, when not the app's default. */
  language?: string;
  /** What the user did before asking. */
  prepare?: (page: Page) => Promise<void>;
  question: string;
  /** What the user types, by a pattern on the field's label. */
  values?: Array<[RegExp, string]>;
  /** Where the first step should point (a pattern on the control's label); `null`: no guide wanted. */
  first?: RegExp | null;
  /** Only look at the first step, then stop. */
  firstOnly?: boolean;
  goal?: (host: Host, page: Page) => Promise<boolean>;
  /** The language the answer must be in (judged by its script). */
  answerIn?: 'en' | 'zh';
  /** What the answer (with the guide's bubbles) must say, e.g. a fact that is only in the docs. */
  says?: RegExp;
  /** What it must not say: the wrong answer a model gives from memory. */
  never?: RegExp;
  /** Also passes when this holds for the bubbles and the answer, e.g. a hint the script can't follow. */
  orSaid?: RegExp;
}

export interface HostApp {
  name: string;
  start(options?: HostOptions): Promise<Host>;
  views: View[];
  cases: Case[];
  /** Text of a page still loading; one stuck on it is reloaded, as a person would. */
  loading?: RegExp;
}

export const hostApps: Record<string, () => Promise<HostApp>> = {
  grafana: async () => (await import('./grafana/app.js')).app,
  homebox: async () => (await import('./homebox/app.js')).app,
};

/** The app named on the command line. */
export async function hostApp(name: string | undefined): Promise<HostApp> {
  const load = name ? hostApps[name] : undefined;
  if (!load) throw new Error(`which app? one of: ${Object.keys(hostApps).join(', ')}`);
  return load();
}

/**
 * Fetches from the internet with curl, not `fetch`: curl follows the machine's proxy settings
 * (`HTTPS_PROXY`), which Node's `fetch` ignores.
 */
async function curl(args: string[]): Promise<string> {
  return (await promisify(execFile)('curl', ['-fsSL', '--retry', '3', ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;
}

/** A text file from the internet. */
export function fetchText(url: string): Promise<string> {
  return curl([url]);
}

/**
 * Downloads `url` to `file` and checks it against `sha256`. A cut download resumes where it
 * stopped: on some networks a release of tens of MB doesn't come down in one go.
 */
export async function download(url: string, file: string, sha256: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await curl(['-C', '-', '-o', file, url]);
      break;
    } catch (error) {
      if (attempt >= 8) throw error;
      console.log('download cut, resuming…');
    }
  }
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  if (hash.digest('hex') !== sha256) throw new Error(`${url}: checksum mismatch`);
}

/** Waits until `ready` holds, failing early when the app's process has exited. */
export async function waitUntil(ready: () => Promise<boolean>, what: string, exited: () => string | undefined, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const exit = exited();
    if (exit !== undefined) throw new Error(`${what} exited: ${exit}`);
    if (await ready().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`${what} did not start in time`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
