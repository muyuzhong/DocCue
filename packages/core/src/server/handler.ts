/**
 * The HTTP side: a standard fetch handler, `(Request) => Promise<Response>`, that works on any
 * runtime with the Fetch API (Node, Deno, Bun, edge and serverless functions). It keeps nothing
 * between requests. Mount it under a path and put your own auth and rate limiting in front.
 *
 * Everything in the body comes from the browser and is only as trustworthy as the user: the
 * question, the screen, the stored conversation and the `user` attributes alike. Anything that
 * must hold (who the user is, their role or plan) comes from your own session through `user`.
 *
 *   POST {base}/turn    body: TurnRequest → the answer as Server-Sent Events (StreamEvent)
 *
 * The client cancels by closing the connection.
 */
import type { StreamEvent } from '@doccue/protocol';
import { failedEnd, respond, type AgentOptions } from '../agent/respond.js';
import { parseTurnRequest } from '../protocol/parse.js';

export interface HandlerOptions extends AgentOptions {
  /** Path the handler is mounted at, e.g. `/doccue`. Defaults to the root. */
  basePath?: string;
  /**
   * The user's attributes the model sees (role, plan, ...), from your own session. What it
   * returns replaces the `user` the browser sent, which anyone can forge. Without it, the
   * browser's `user` is passed on as it is: fine for hints, never for anything that grants access.
   */
  user?: (request: Request) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
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
    const { user: reported, ...turn } = parsed.value;
    const user = options.user ? await options.user(request) : reported;

    const encoder = new TextEncoder();
    const encode = (event: StreamEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    const events = respond(user ? { ...turn, user } : turn, options, request.signal);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await events.next();
          if (next.done) controller.close();
          else controller.enqueue(encode(next.value));
        } catch {
          // `respond` reports its own failures; this is the last line of defence. The stream
          // still ends with an end event, so the frontend isn't left waiting.
          controller.enqueue(encode(failedEnd()));
          controller.close();
        }
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
