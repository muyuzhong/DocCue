/**
 * Mounts a fetch handler on Node's `http` server, Express or Connect (e.g. Vite's dev server).
 * Lives in the `@doccue/core/node` entry so the main entry stays free of Node-only modules.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { FetchHandler } from './handler.js';

type NodeRequest = IncomingMessage & { originalUrl?: string };

export function toNodeHandler(handler: FetchHandler): (req: NodeRequest, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    // Express and Connect strip the mount path from `req.url`; `originalUrl` keeps it.
    const url = new URL(req.originalUrl ?? req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else if (value !== undefined) headers.set(name, value);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method ?? 'GET',
      headers,
      signal: controller.signal,
      ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
    };

    let response: Response;
    try {
      response = await handler(new Request(url, init));
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : 'internal error');
      return;
    }

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.flushHeaders();
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // The client went away or the stream failed: nothing more to send.
    } finally {
      res.end();
    }
  };
}
