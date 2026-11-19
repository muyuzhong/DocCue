# @doccue/core

The backend of [DocCue](https://github.com/muyuzhong/DocCue), an in-app assistant that answers from what the user just did on the screen and shows them on the page, step by step. Model adapters (Anthropic, OpenAI-compatible), the agent loop, product docs search and the HTTP handler. No runtime dependencies besides `@doccue/protocol`.

```bash
npm install @doccue/core
```

```ts
import { createHandler, createModelFromEnv, withRetry } from '@doccue/core';
import { markdownDocs, toNodeHandler } from '@doccue/core/node';

const handler = createHandler({
  model: withRetry(createModelFromEnv(process.env)),
  instructions: 'You are the in-app assistant of Acme Data.',
  docs: await markdownDocs('./docs'), // optional
  basePath: '/doccue',
});

app.use('/doccue', toNodeHandler(handler)); // or call handler(request) in a Fetch-style framework
```

The backend is stateless: the conversation comes with every request from `@doccue/bridge` in the page. See the [main README](https://github.com/muyuzhong/DocCue#readme) for the frontend, security notes and examples.

MIT
