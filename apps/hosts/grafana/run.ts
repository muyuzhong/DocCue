/**
 * Grafana with DocCue on it, to try by hand:
 *
 *   pnpm --filter @doccue/hosts grafana          → http://localhost:5180
 *
 * GRAFANA_LANG sets Grafana's UI language (default zh-Hans); PORT the proxy's port.
 * The model comes from the root .env; every request is logged to apps/hosts/.logs/.
 */
import { startGrafana } from './grafana.js';

const grafana = await startGrafana({ language: process.env.GRAFANA_LANG, port: Number(process.env.PORT ?? 5180) });
console.log(`Grafana with DocCue: ${grafana.url}`);
console.log(`日志：${grafana.proxy.logFile}`);
const stop = () => void grafana.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
