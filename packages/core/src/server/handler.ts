/**
 * The transport layer: a standard fetch handler, `(Request) => Promise<Response>`, that works on
 * any runtime with the Fetch API (Node 18+, Deno, Bun, edge functions). Mount it under a path and
 * put your own auth and rate limiting in front of it.
 *
 *   POST {base}/events                 body `{ sessionId, events }` → 204
 *   GET  {base}/stream?sessionId=…     the session's output as Server-Sent Events
 *   GET  {base}/debug?sessionId=…      what the agent knows (only with `debug: true`)
 */
import { renderStatus } from '../context/render.js';
import { isValidSessionId, parseInbound, type ProtocolLimits } from '../protocol/parse.js';
import type { Scheduler } from '../scheduler/types.js';

export interface HandlerOptions {
  scheduler: Scheduler;
  /** Path the handler is mounted at, e.g. `/doccue`. Defaults to the root. */
  basePath?: string;
  limits?: Partial<ProtocolLimits>;
  /** Largest request body accepted, in bytes. Defaults to 10 MB (screenshots are large). */
  maxBodyBytes?: number;
  /** How often the event stream sends a keep-alive comment. Defaults to 15 s. */
  keepAliveMs?: number;
  /** Adds `GET {base}/debug`, showing a session's status bar and screen tree. Not for production. */
  debug?: boolean;
}

export type FetchHandler = (request: Request) => Promise<Response>;

class BodyTooLarge extends Error {}

export function createHandler(options: HandlerOptions): FetchHandler {
  const base = (options.basePath ?? '').replace(/\/+$/, '');
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const { scheduler } = options;

  async function events(request: Request): Promise<Response> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readText(request, maxBodyBytes));
    } catch (error) {
      if (error instanceof BodyTooLarge) return json(413, { errors: [`body: larger than ${maxBodyBytes} bytes`] });
      return json(400, { errors: ['body: invalid JSON'] });
    }
    const parsed = parseInbound(raw, options.limits);
    if (!parsed.ok) return json(400, { errors: parsed.errors });
    try {
      for (const event of parsed.value.events) await scheduler.push(parsed.value.sessionId, event);
    } catch (error) {
      return json(500, { errors: [error instanceof Error ? error.message : String(error)] });
    }
    return new Response(null, { status: 204 });
  }

  function stream(request: Request, sessionId: string): Response {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const send = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup();
          }
        };
        const unsubscribe = scheduler.subscribe(sessionId, (output) => send(`data: ${JSON.stringify(output)}\n\n`));
        const timer = setInterval(() => send(': ping\n\n'), keepAliveMs);
        const close = () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };
        cleanup = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          clearInterval(timer);
          request.signal.removeEventListener('abort', close);
        };
        request.signal.addEventListener('abort', close, { once: true });
        // Tell EventSource how soon to reconnect, and flush the headers right away.
        send('retry: 3000\n: connected\n\n');
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }

  async function debug(sessionId: string): Promise<Response> {
    const session = await scheduler.getSession(sessionId);
    if (!session) return json(200, { sessionId, known: false });
    return json(200, {
      sessionId,
      known: true,
      status: renderStatus(session) ?? null,
      screen: session.perception.screen?.text ?? null,
      page: session.perception.page ?? null,
      errors: session.perception.errors,
      timeline: session.perception.timeline,
      user: session.user,
      messages: session.history.length,
    });
  }

  return async (request) => {
    const url = new URL(request.url);
    if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return json(404, { errors: ['not found'] });
    const route = url.pathname.slice(base.length) || '/';
    const known = route === '/events' || route === '/stream' || (options.debug === true && route === '/debug');
    if (!known) return json(404, { errors: ['not found'] });

    if (route === '/events') return request.method === 'POST' ? events(request) : json(405, { errors: ['use POST'] });
    if (request.method !== 'GET') return json(405, { errors: ['use GET'] });
    const sessionId = url.searchParams.get('sessionId') ?? '';
    if (!isValidSessionId(sessionId)) return json(400, { errors: ['sessionId: expected 1-128 characters of A-Z a-z 0-9 _ . : -'] });
    return route === '/stream' ? stream(request, sessionId) : debug(sessionId);
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** Reads the body as text, refusing to buffer more than `maxBytes`. */
async function readText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
