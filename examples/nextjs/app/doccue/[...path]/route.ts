/**
 * The DocCue backend: one route. The bridge posts each turn to /doccue/turn; createHandler takes
 * a Fetch Request and returns the streamed Response, which is what a route handler deals in.
 */
import { join } from 'node:path';
import { createHandler, createModelFromEnv, withRetry } from '@doccue/core';
import { markdownDocs } from '@doccue/core/node';

// Reads the docs folder from disk: the Node.js runtime, not the edge.
export const runtime = 'nodejs';

// Made on the first request, not when the module loads: `next build` loads route modules
// too, where the model's key may not be set.
let handler: Promise<(request: Request) => Promise<Response>> | undefined;

function doccue() {
  handler ??= markdownDocs(join(process.cwd(), 'docs')).then((docs) =>
    createHandler({
      model: withRetry(createModelFromEnv(process.env)),
      instructions: 'You are the in-app assistant of Teamspace, a workspace for small teams. Help people get started and solve problems in the app.',
      docs,
      basePath: '/doccue',
      // Attributes that must hold (role, plan) come from your own session, never from the browser:
      // user: async (request) => (await getSession(request))?.attributes,
    }),
  );
  return handler;
}

export async function POST(request: Request): Promise<Response> {
  return (await doccue())(request);
}
