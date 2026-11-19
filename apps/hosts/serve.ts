/**
 * A host app with DocCue on it, to try by hand:
 *
 *   pnpm --filter @doccue/hosts serve <app>          → http://localhost:5180
 *
 * LANG_UI sets the app's UI language (e.g. en-US); PORT the proxy's port; DOCS=off leaves the
 * app's docs out. The model comes from the root .env; every request is logged to apps/hosts/.logs/.
 */
import { hostApp } from './host.js';

const app = await hostApp(process.argv[2]);
const host = await app.start({ language: process.env.LANG_UI, port: Number(process.env.PORT ?? 5180), docs: process.env.DOCS !== 'off' });
console.log(`${app.name} with DocCue: ${host.url}`);
console.log(`log: ${host.proxy.logFile}`);
const stop = () => void host.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
