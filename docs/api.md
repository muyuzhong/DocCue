# API & Integration Reference

This reference covers the options, extension points, HTML attributes, styling hooks, and known boundaries of `@doccue/core` and `@doccue/bridge`. For an overview and quick start, see the [README](../README.md).

## Backend (`@doccue/core`)

### `createHandler(options)`

Creates a Fetch API handler `(request: Request) => Promise<Response>` that serves `POST {basePath}/turn` and streams [`StreamEvent`](../packages/protocol/src/index.ts) objects as Server-Sent Events (`text/event-stream`).

```ts
import { createHandler, createModelFromEnv, withRetry } from '@doccue/core';
import { markdownDocs, toNodeHandler } from '@doccue/core/node';

const handler = createHandler({
  model: withRetry(createModelFromEnv(process.env)),
  instructions: 'You are the in-app assistant of Acme Data.',
  docs: await markdownDocs('./docs'),
  basePath: '/doccue',
  user: async (request) => (await getSession(request))?.attributes,
});
```

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `model` | `ModelAdapter` | *required* | Model adapter (e.g. `createAnthropic`, `createOpenAI`, `createModelFromEnv`, or custom). |
| `instructions` | `string` | Generic assistant prompt | Product-specific part of the system prompt: what the app does, tone, domain rules. |
| `docs` | `DocsProvider` | — | Product documentation (`markdownDocs`, `createDocs`, or your own search provider). |
| `tools` | `readonly Tool[]` | `[]` | Extra backend tools the model can call in addition to `guide` and doc tools. |
| `basePath` | `string` | `''` | Mount prefix, e.g. `'/doccue'`. The endpoint is `POST {basePath}/turn`. |
| `user` | `(request: Request) => Record<string, unknown> \| undefined \| Promise<...>` | — | Server-side user attributes (role, plan, tenant). Replaces whatever `user` the browser sent. |
| `maxSteps` | `number` | `10` | Maximum model calls per request. |
| `timeoutMs` | `number` | — | Hard time limit for a single request. |
| `maxBodyBytes` | `number` | `2_000_000` | Maximum JSON body size in bytes; larger requests get `413`. |
| `limits` | `Partial<ProtocolLimits>` | `maxItems: 400`, `maxQuestionChars: 4000`, `maxScreenNodes: 3000`, `maxActions: 300` | Structural caps checked before calling the model; requests over them get `400`. |
| `logger` | `Logger` | — | Receives `request`, `model_call`, and `end` records for observability and replay. |

#### Mounting in Node (`@doccue/core/node`)

`toNodeHandler(handler)` adapts the Fetch handler for `node:http`, Express, and Connect (including Vite dev middleware). It never rejects: malformed requests get `400`, unexpected errors get `500`, and client disconnects abort `request.signal` so the model stream stops promptly.

If upstream middleware (such as `express.json()`, `express.text()`, or `express.raw()`) has already consumed the request stream and populated `req.body`, `toNodeHandler` reads `req.body` automatically while still enforcing `maxBodyBytes`.

### Models

All built-in adapters use plain `fetch` with zero runtime dependencies.

#### `createModelFromEnv(env)`

Reads standard environment variables (empty values count as unset):

| Variable | Description |
| :--- | :--- |
| `DOCCUE_PROVIDER` | `'anthropic'` or `'openai'`. Inferred from API key / base URL if omitted. |
| `ANTHROPIC_API_KEY` | API key for Anthropic. |
| `OPENAI_API_KEY` | API key for OpenAI / compatible gateways (optional for local servers like Ollama). |
| `DOCCUE_BASE_URL` | Custom API origin or gateway (no trailing `/v1` for Anthropic; include `/v1` for OpenAI-compatible servers). |
| `DOCCUE_MODEL` | Model ID. Defaults to `claude-opus-5-5` for Anthropic; required for `openai`. |
| `DOCCUE_EFFORT` | Anthropic thinking effort: `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`. |
| `DOCCUE_MAX_TOKENS` | Output token cap per model call (thinking included). |
| `DOCCUE_PROMPT_CACHE` | `'on'` or `'off'`. Defaults to `'on'` on the official Anthropic API only. |

#### `createAnthropic(options)`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `apiKey` | `string` | *required* | Sent as `x-api-key`. |
| `model` | `string` | *required* | Model ID, e.g. `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`. |
| `baseURL` | `string` | `'https://api.anthropic.com'` | Override for proxies or gateways. |
| `version` | `string` | `'2026-10-21'` | `anthropic-version` header. |
| `maxTokens` | `number` | `64000` | Output cap per call, thinking included. |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | — | Sent as `output_config.effort`. |
| `thinking` | `Record<string, unknown>` | — | Forwarded as the `thinking` field. |
| `betas` | `string[]` | `[]` | Additional `anthropic-beta` flags. |
| `fallbacks` | `'default' \| false` | Official API + supported models | Server-side refusal fallback. |
| `promptCache` | `boolean` | `true` on official API | Top-level automatic `cache_control`. |
| `eagerToolInput` | `boolean` | `true` on official API | Enables `eager_input_streaming` on tool specs. |
| `headers` | `Record<string, string>` | — | Extra HTTP headers. |
| `extraBody` | `Record<string, unknown>` | — | Merged into the request body last. |
| `idleTimeoutMs` | `number` | `60_000` | Abort if no bytes arrive (pings count); `0` disables. |
| `fetch` | `FetchLike` | `globalThis.fetch` | Custom fetch implementation. |

#### `createOpenAI(options)`

Works with OpenAI and OpenAI-compatible servers (Ollama, vLLM, LM Studio, OpenRouter, gateways exposing `/chat/completions`).

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `model` | `string` | *required* | Model ID. |
| `apiKey` | `string` | — | Sent as `Authorization: Bearer ...` (optional for local servers). |
| `baseURL` | `string` | `'https://api.openai.com/v1'` | Server base URL. |
| `maxTokens` | `number` | — | Output cap per call. |
| `maxTokensField` | `'max_tokens' \| 'max_completion_tokens'` | `'max_completion_tokens'` on `api.openai.com`, else `'max_tokens'` | Wire field name for `maxTokens`. |
| `includeUsage` | `boolean` | `true` | Sends `stream_options: { include_usage: true }`. |
| `headers` | `Record<string, string>` | — | Extra HTTP headers. |
| `extraBody` | `Record<string, unknown>` | — | Merged into the request body last (e.g. `{ reasoning_effort: 'low' }`). |
| `idleTimeoutMs` | `number` | `60_000` | Abort on idle stream; `0` disables. |
| `fetch` | `FetchLike` | `globalThis.fetch` | Custom fetch implementation. |

#### `withRetry(model, options)`

Retries retryable failures (`408`, `409`, `429`, `5xx`, overloaded streams, dropped connections) with exponential backoff and jitter, **only before any output has been emitted**.

Options: `maxRetries` (`2`), `baseDelayMs` (`500`), `maxDelayMs` (`8000`), `onRetry(error, attempt, delayMs)`.

#### Custom `ModelAdapter`

Implement `ModelAdapter` to connect any other provider or SDK:

```ts
import type { ModelAdapter, ModelEvent, ModelRequest } from '@doccue/core';

const myModel: ModelAdapter = {
  provider: 'custom',
  model: 'my-model-1',
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    // Call your provider with request.system, request.messages, request.tools, request.signal
    yield { type: 'text', delta: 'Hello!' };
    yield {
      type: 'done',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
      stopReason: 'end',
      rawStopReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};
```

### Product Documentation

- `markdownDocs(dir, options)` (`@doccue/core/node`): recursively loads `.md`, `.mdx`, and `.markdown` files once at startup. Strips YAML front matter (using its `title` if present) and MDX `import` lines.
- `createDocs(files, options)` (`@doccue/core`): runtime-agnostic version taking `Array<{ path: string; content: string }>` (works on Cloudflare Workers, Deno, Bun, Edge runtimes).

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `inlineMaxChars` | `number` | `12000` | Docs up to this total size are placed directly in the system prompt (no doc tools needed). Set `0` to always use `search_docs` / `read_doc`. |
| `maxHits` | `number` | `5` | Maximum hits returned by `search_docs`. |
| `maxTocChars` | `number` | `4000` | Maximum length of the table of contents in the system prompt; deeper headings are pruned automatically if exceeded. |

#### Custom `DocsProvider`

Plug in your own search backend (Algolia, Elasticsearch, pgvector, CMS API) by implementing `DocsProvider`:

```ts
import type { DocsProvider } from '@doccue/core';

const docs: DocsProvider = {
  // Keep toc() stable across requests so prompt caching stays warm.
  toc: () => '- Getting started (getting-started)\n- Billing & plans (billing)',
  async search(query) {
    const hits = await mySearchIndex.query(query, { limit: 5 });
    return hits.map((h) => ({ id: h.id, title: h.title, snippet: h.snippet }));
  },
  async read(id) {
    return myDocsStore.getMarkdown(id); // return undefined if not found
  },
};
```

### Custom Backend Tools

Pass additional read-only tools via `createHandler({ tools: [...] })` so the agent can check live backend context (feature flags, plan limits, integration status) while answering:

```ts
import type { Tool } from '@doccue/core';

const checkPlanTool: Tool = {
  name: 'check_workspace_limits',
  description: 'Returns the current workspace plan and seat usage.',
  parameters: { type: 'object', properties: {} },
  async execute(_args, { signal }) {
    const stats = await fetchWorkspaceStats({ signal });
    return JSON.stringify(stats);
  },
};
```

If a tool throws, the error message is returned to the model as a tool error result instead of aborting the turn.

### Logging and Replay

Pass `logger` to `createHandler` to receive structured `LogRecord` events (`request`, `model_call`, `end`):

- `toJsonLine(record, { keepImages?: boolean })`: serializes a record as JSONL (strips base64 image payloads by default).
- `createMemoryLog(limit = 1000)`: keeps recent records in memory (useful for tests or debug views).
- `withModelLog(model, log)`: wraps a `ModelAdapter` directly. Note that `createHandler`'s `logger` wraps the outer `model` you pass — if you want every individual retry attempt logged separately, wrap `withModelLog` *inside* `withRetry`.

---

## Frontend (`@doccue/bridge`)

### `createBridge(options)`

Starts recording user actions immediately and manages the conversation and on-page guides.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `endpoint` | `string` | *required* | Base path or URL where `@doccue/core` is mounted (e.g. `'/doccue'`). |
| `headers` | `HeadersInit \| (() => HeadersInit \| undefined \| Promise<...>)` | — | Extra HTTP headers sent to the backend (e.g. `Authorization`, CSRF token). Pass a function to refresh tokens per request. |
| `credentials` | `RequestCredentials` | — | Fetch `credentials` mode (e.g. `'include'` for cross-origin cookie authentication). |
| `fetch` | `FetchLike` | `globalThis.fetch` | Custom `fetch` wrapper used for backend requests. |
| `locale` | `string` | `document.documentElement.lang \|\| navigator.language` | Language tag (e.g. `'en'`, `'zh-CN'`). |
| `messages` | `Partial<Messages>` | Built-in `en` / `zh` | Overrides for any UI string in the guide bubble and chat panel. |
| `theme` | `'light' \| 'dark' \| 'auto'` | `'light'` | Colour theme (`'auto'` follows `prefers-color-scheme`). |
| `user` | `Record<string, unknown>` | — | Client-supplied hints about the user. Never trust for access control; override on the backend via `createHandler({ user })`. |
| `errorSelectors` | `string[]` | `[]` (appended to `DEFAULT_ERROR_SELECTORS`) | Extra CSS selectors for inline error messages. |
| `maxNodes` | `number` | `300` | Maximum nodes in a screen snapshot (dialogs, errors, and visible viewport elements are prioritized). |
| `resultWindowMs` | `number` | `1000` | Window (ms) after an action during which DOM/network effects attach to that action. |
| `targetWaitMs` | `number` | `3000` | How long (ms) a guide waits for a step's element to appear before reporting `not_found` / `deviated`. |
| `settle` | `{ quietMs?: number; maxMs?: number }` | `{ quietMs: 300, maxMs: 4000 }` | Post-guide page-settle detection before taking the next snapshot. |
| `maxGuides` | `number` | `20` | Maximum consecutive guide segments per question. |
| `maxConversationChars` | `number` | `150_000` | JSON size budget for conversation history; oldest complete exchanges are dropped when exceeded. |
| `maxQuestionChars` | `number` | `4000` | Maximum characters accepted by `ask()`. |
| `captureNetwork` | `boolean` | `true` | Records failed `fetch` / `XMLHttpRequest` calls (excluding DocCue's own `/turn` requests). |
| `timelineLimit` | `number` | `100` | Maximum unsent actions retained locally before the next question. |
| `document` | `Document` | `globalThis.document` | Custom document instance (mainly for tests). |

### `Bridge` Methods and Events

| Member | Description |
| :--- | :--- |
| `ask(question)` | Sends the question with unsent actions and the current screen; runs any guides returned until the exchange completes. |
| `stop()` | Cancels the in-flight request and closes any active guide on screen. |
| `reset()` | Clears the conversation (and active guide) and emits `'reset'`. |
| `on(type, listener)` | Subscribes to a `BridgeEvent`; returns an unsubscribe function. |
| `mount(options?)` | Lazily loads and mounts the built-in Shadow DOM chat panel (`{ open?: boolean; side?: 'left' \| 'right' }`). Calling `mount()` repeatedly returns the same `Panel` handle. |
| `busy()` / `guiding()` | Current working / guiding state. |
| `lastError()` | Last error `{ message, status? }` if the previous question failed (useful if your UI mounts after a page-load resume fails). |
| `recorded()` / `perceive()` / `conversation()` | Inspect local unsent actions, current perception snapshot, or stored conversation items. |
| `destroy()` | Detaches listeners, stops recording and guides, and unmounts the panel (preserves `sessionStorage` for full page loads). |

#### Events (`BridgeEvent`)

- `status`: `{ state: 'thinking' | 'tool'; tool?: string }`
- `text`: `{ delta: string }` — streamed answer chunk
- `guide`: `{ callId: string; steps: GuideStep[] }` — guide steps received from backend
- `end`: `{ reason: EndReason; item: Item; usage: Usage; error?: { message: string; code?: string } }`
- `guide_start`: `{ steps: GuideStep[] }` — spotlight overlay is about to appear
- `guide_end`: `{ outcome: 'completed' | 'deviated' | 'not_found' | 'interrupted' | 'exited'; completedSteps: number; skippedSteps?: number[] }`
- `state`: `{ busy: boolean }`
- `reset`: `{}`
- `error`: `{ message: string; status?: number }`

### Styling and Localization

#### CSS Custom Properties

Both the chat panel and the guide overlay live in Shadow DOM and inherit these custom properties from your page (e.g. on `:root`):

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `--doccue-right` | `20px` | Distance from right edge (`side: 'right'`). |
| `--doccue-left` | `20px` | Distance from left edge (`side: 'left'`). |
| `--doccue-bottom` | `20px` | Distance from bottom edge. |
| `--doccue-accent` | `#2563eb` (panel/button), `#4f8cff` (spotlight ring) | Accent colour for launcher, user bubbles, primary buttons, and spotlight outline. |
| `--doccue-z` | `2147483647` | `z-index` of the chat panel. The guide overlay automatically uses `calc(var(--doccue-z, 2147483647) - 1)` so the panel bar stays above the dim backdrop. |

#### Overridable `Messages` Keys

Pass any subset via `createBridge({ messages: { ... } })`:

- Guide bubble: `next`, `done`, `exit`
- Chat panel: `title`, `open`, `close`, `newConversation`, `placeholder`, `send`, `stop`, `greeting`, `thinking`, `readingDocs`, `working`, `guiding`, `expand`, `stopped`, `cutOff`, `failed`, `failedConversation`, `refused`, `earlier`

### HTML Attributes for Host Apps

DocCue works on unmodified apps, and supports three optional attributes when you want finer control:

| Attribute | Purpose |
| :--- | :--- |
| `data-cue-ignore` | Excludes an element and its subtree from action recording, error collection, and screen snapshots. Always put this on custom chat UIs and sensitive areas. |
| `data-cue-id="..."` | Gives a control a stable identifier (separate from its visible label). Takes top priority when locating the element again after re-renders or full page loads. |
| `data-cue-error` | Marks custom inline error elements not covered by `DEFAULT_ERROR_SELECTORS` (`[role="alert"]`, Bootstrap `.invalid-feedback`, Ant Design `.ant-form-item-explain-error`, Element Plus `.el-form-item__error`, MUI `.MuiFormHelperText-root.Mui-error`). |

---

## Known Limitations & Current Boundaries

- **Host Shadow DOM and `<iframe>`s**: Screen snapshots and control locators currently walk the main document tree and do not traverse into open/closed Shadow DOM of host web components or nested `<iframe>` elements.
- **Canvas, WebGL, and complex charts**: Because snapshots are DOM-based, pixels drawn inside `<canvas>` or visual chart plots are not readable (on-demand screenshots are planned for a later release).
- **Hover-only controls**: Controls that only exist in the DOM while hovered are not visible in static snapshots. The system prompt instructs the model to point at the parent element and tell the user where to hover.
- **Built-in docs search**: `createDocs` / `markdownDocs` uses lightweight keyword matching (Latin tokens + CJK bigrams) without stemming or synonyms. For large or complex knowledge bases, implement `DocsProvider` over your existing search engine.
- **Sensitive field values**: `<input type="password">` values are never recorded or uploaded (only marked `filled`), and `data-cue-ignore` hides an entire subtree. Field-level value redaction for non-password inputs (e.g. API keys in plain text inputs) is on the roadmap.
- **Strict CSP (`style-src`)**: The Shadow DOM panel and guide currently inject inline `<style>` elements. Sites with strict `style-src` policies without `'unsafe-inline'` may block their styles until `adoptedStyleSheets` / nonce support is added.
