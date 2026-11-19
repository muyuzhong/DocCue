# @doccue/bridge

The frontend of [DocCue](https://github.com/muyuzhong/DocCue), an in-app assistant that answers from what the user just did on the screen and shows them on the page, step by step. It records actions and what they caused, takes snapshots of the screen, keeps the conversation, runs guides (spotlight and bubble) and has a built-in chat panel.

```bash
npm install @doccue/bridge
```

```ts
import { createBridge } from '@doccue/bridge';

const cue = createBridge({ endpoint: '/doccue' }); // records what the user does from here on
await cue.mount(); // the chat panel in the corner
```

It talks to `@doccue/core` mounted at `endpoint`. To build your own chat UI, skip `mount()` and use `ask`, `stop`, `reset` and `on`. See the [main README](https://github.com/muyuzhong/DocCue#readme) for details and examples.

MIT
