/**
 * The HTTP side: a standard fetch handler, `(Request) => Promise<Response>`, that works on any
 * runtime with the Fetch API (Node, Deno, Bun, edge and serverless functions). It keeps nothing
 * between requests. Mount it under a path and put your own auth and rate limiting in front.
 *
 *   POST {base}/turn    body: TurnRequest → the answer as Server-Sent Events (StreamEvent)
 *
 * The client cancels by closing the connection.
 */
import { respond, type AgentOptions } from '../agent/respond.js';
import { parseTurnRequest } from '../protocol/parse.js';

export interface HandlerOptions extends AgentOptions {
  /** Path the handler is mounted at, e.g. `/doccue`. Defaults to the root. */
  basePath?: string;
}

export type FetchHandler = (request: Request) => Promise<Response>;

export function createHandler(options: HandlerOptions): FetchHandler {
  const base = (options.basePath ?? '').replace(/\/+$/, '');

  return async (request) => {
    if (new URL(request.url).pathname !== `${base}/turn`) return json(404, { errors: ['not found'] });
    if (request.method !== 'POST') return json(405, { errors: ['use POST'] });

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json(400, { errors: ['body: invalid JSON'] });
    }
    const parsed = parseTurnRequest(raw);
    if (!parsed.ok) return json(400, { errors: parsed.errors });

    const encoder = new TextEncoder();
    const events = respond(parsed.value, options, request.signal);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await events.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
      },
      async cancel() {
        await events.return();
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
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
