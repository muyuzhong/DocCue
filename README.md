# DocCue

[![CI](https://github.com/muyuzhong/DocCue/actions/workflows/ci.yml/badge.svg)](https://github.com/muyuzhong/DocCue/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Turn static docs into context-aware in-app cues.

English · [简体中文](README.zh-CN.md) · [API Reference](docs/api.md)

Complex apps take time to learn, and their docs live on a website, away from the app. DocCue is **an onboarding tour that is an agent**: it sits in your web app, and when a user asks "how do I…" or "why doesn't this work", it answers from what they just did on the screen, then shows them on the page, step by step.

- **It points, it doesn't operate**: the agent never clicks or types for the user.
- **It speaks when asked**: no pop-ups, no interruptions.
- **Small to add**: one package in the frontend, one route in the backend. Sign-in, storage and hosting stay yours; DocCue doesn't duplicate them.

> **Status**: 0.1.0, not yet published to npm. Questions and answers, guides on the page (across pages, dialogs and full page loads), answers from your product docs, and a built-in chat panel all work, end to end in a real browser with a real model. Besides the demo app, it has been tried on two open-source apps it was not written for, [Grafana](https://github.com/grafana/grafana) and [Homebox](https://github.com/sysadminsmedia/homebox), without changing their code. The API may still change before 1.0.

## How it knows what the user did

Like autocapture analytics, the bridge in the frontend records each user action and what it caused, and sends that with the current screen when the user asks. The model sees:

```text
<context locale="en">
recent actions:
5s ago: input textbox "Host" = "http://127.0.0.1:5432"
2s ago: click button "Test connection" -> error "Invalid Host Format" on textbox "Host"
screen:
page "New data source" /datasource/new
[5] heading "New data source"
[6] form "Connection"
  [9] textbox "Host" = "http://127.0.0.1:5432" (invalid)
  alert "Invalid Host Format"
  [10] textbox "Port" = "5432"
  [14] button "Test connection"
  [15] button "Save" (disabled)
</context>
Why won't it connect?
```

From "Why won't it connect?" alone, the model can tell that the host has an extra `http://` and the port belongs in its own field.

Then it shows the user: the rest of the page dims, the Host field lights up, and a bubble beside it says what to change. Once the user has changed it, the bubble moves to Test connection; when the model sees "Connected", it confirms the problem is solved.

The same goes for tasks on other pages. Say "I want to add a MySQL data source" on the dashboard: it points at the navigation first, then at each field of the form on the next page, and checks after saving that the new data source is in the list.

Some design points:

- **Stateless backend**: the conversation lives in the browser and comes with every request. The backend runs anywhere, serverless included.
- **Append-only history**: what the model was sent is never changed, so prompt caching keeps hitting and Claude's thinking blocks stay valid.
- **Language-neutral**: the frontend sends structured data, with ARIA roles for controls and names as they are on screen; the model answers in the user's language.
- **Numbers point at controls**: every control on the screen has a number, and the model points by number, so it can only point at what it has seen.
- **Guides report back**: what the user did, which steps they skipped and how the screen changed go back to the model, which confirms the result or changes course.

## Use it in your app

```bash
npm install @doccue/core @doccue/bridge
```

**Backend**: mount the handler.

```ts
import { createHandler, createModelFromEnv, withRetry } from '@doccue/core';
import { markdownDocs, toNodeHandler } from '@doccue/core/node';

const handler = createHandler({
  model: withRetry(createModelFromEnv(process.env)),
  instructions: 'You are the in-app assistant of Acme Data, helping people get started and solve problems.',
  docs: await markdownDocs('./docs'),   // your product docs in Markdown, optional
  basePath: '/doccue',
  user: (request) => sessionOf(request)?.attributes,   // user attributes from your own session, optional
});

// Express / Connect / node:http. Fetch-style frameworks (Hono, Next.js route handlers…) use handler directly.
app.use('/doccue', toNodeHandler(handler));
```

**Frontend**: two lines.

```ts
import { createBridge } from '@doccue/bridge';

const cue = createBridge({ endpoint: '/doccue' });   // records what the user does from here on
await cue.mount();                                   // the chat panel in the corner
```

The panel lives in a Shadow DOM, out of reach of the page's styles. Position and accent colour are CSS variables (`--doccue-right`, `--doccue-bottom`, `--doccue-accent`); `createBridge({ theme: 'dark' })` (or `'auto'`, following the system) gives the dark theme; on phones it opens full screen. Its words follow the page's language (English and Chinese for now), and `createBridge({ messages: { title: 'Acme help' } })` changes any of them.

To use your own chat UI instead, don't call `mount()` and build on these:

```ts
cue.on('text', (event) => console.log(event.delta));          // the answer, streamed
cue.on('end', (event) => console.log(event.reason));
cue.on('guide_end', (event) => console.log(event.outcome));   // a guide on the page ended

// When the user asks in your UI: sent with the recorded actions and the current screen
await cue.ask("Why won't it connect?");   // when the answer needs pointing, the bridge guides on the page itself
cue.stop();    // stops the answer and closes the guide
cue.reset();   // starts a new conversation
```

Mark your own chat UI with `data-cue-ignore`, so typing in it isn't recorded as an action (the built-in panel already is). For all options, custom tools, custom doc/model providers, HTML attributes (`data-cue-id`, `data-cue-error`), CSS variables and known boundaries (host Shadow DOM, iframes, `<canvas>`), see the [API & Integration Reference](docs/api.md).

### Security and privacy

- The request body (question, screen, conversation, the bridge's `user`) all comes from the browser and is as trustworthy as what the user types. Attributes that must hold, like role or plan, belong in `createHandler`'s `user`, taken from your server-side session; they override what the browser sends.
- The endpoint is open: put sign-in and rate limits on it in your own routes and middleware. It calls your model for whoever reaches it. When your endpoint expects auth headers or cross-origin cookies, pass `headers` (static or an async function), `credentials: 'include'`, or a custom `fetch` to `createBridge`.
- The bridge records locally and uploads only when the user asks. Passwords are recorded as "filled in", never their content.
- The backend stores nothing. The conversation is in the browser's sessionStorage, one per tab. After a full page load the bridge on the new page carries on with the guide and the answer, so multi-page apps work as long as every page calls `createBridge`.
- See [SECURITY.md](SECURITY.md) for the full trust model and vulnerability reporting.

## Examples

- [`examples/basic`](examples/basic): Node's own `http` server and a plain HTML page with an import map. No build step.
- [`examples/nextjs`](examples/nextjs): a Next.js App Router app, with a route handler and a client component.

Both are the same small members page: inviting someone from a domain the workspace doesn't allow fails, and its docs say why. Ask the assistant and it guides you through allowing the domain and sending the invite again.

## Models

No runtime dependencies: the adapters talk to the APIs with plain `fetch`.

| Adapter | For | Notes |
| :--- | :--- | :--- |
| `createAnthropic` | Claude models (the Anthropic API or a gateway) | API version `2026-10-21`; thinking blocks are sent back as they came. On the official API, automatic prompt caching, streamed tool arguments and refusal fallback (for models that support it, such as claude-opus-5-5) are on by default; through a gateway they are off |
| `createOpenAI` | OpenAI and every OpenAI-compatible API (Ollama, vLLM, LM Studio, gateways) | Adjacent user messages are merged, for local models that need roles to alternate |

Both drop a stream that sends nothing for 60 seconds (keep-alives count), retry rate limits and server errors with `withRetry` (only before any output), and log every call's full request and timing with `withModelLog`. `createModelFromEnv` builds one from environment variables: see [.env.example](.env.example).

**Choosing a model**: `createModelFromEnv` defaults Anthropic to `claude-opus-5-5`, which is thorough but heavier than most help widgets need. For production latency and cost, a fast model such as `claude-haiku-5-5` (used for the Grafana and Homebox verifications) works well; keeping prompt caching enabled (`DOCCUE_PROMPT_CACHE=on`, on by default on the official Anthropic API) lets repeated turns and multi-step guides hit the cache for the system prompt, docs, and prior history. You can also plug in any other provider by implementing `ModelAdapter` (see [docs/api.md](docs/api.md#custom-modeladapter)).

## Try it from this repository

Needs Node.js 22+ and pnpm 11.

```bash
git clone https://github.com/muyuzhong/DocCue.git
cd DocCue
pnpm install
cp .env.example .env    # your model key
pnpm playground         # http://localhost:5173
```

The playground is a pretend "data platform" (its UI is in Chinese; ask in any language) with the bridge's chat panel in the corner. Try it: open 新建数据源 (New data source), enter `http://127.0.0.1:5432` as 主机地址 (Host), press 测试连接 (Test connection), then ask the panel why it won't connect and follow the bubbles. The "what the agent sees" sidebar on the right is for debugging (a host app doesn't have it): it shows what the bridge recorded and what the model last saw.

Without a browser, `pnpm chat` is a multi-turn command line where commands stand in for what the bridge would report:

```text
/page /datasource/new 新建数据源
/do input textbox 主机地址 = http://127.0.0.1:5432
/do click button 测试连接 -> Invalid Host Format
Why won't it connect?
```

`/context` shows what the next question would send, `/reset` starts over, `/help` lists every command. Ctrl-C stops an answer.

| Command | What it does |
| :--- | :--- |
| `pnpm playground` | The demo app; logs go to `apps/playground/.logs/` |
| `pnpm --filter @doccue/playground e2e` | Drives the demo app in the local Chrome: asks, follows the guide, prints what the model saw and said |
| `pnpm eval [name part]` | Single-step evals with the real model: given a page and a question, does the guide's first step point at the right control |
| `pnpm journeys [name part]` | Multi-step evals: a script plays the user in the local Chrome, follows the guide, and checks the goal was reached |
| `pnpm --filter @doccue/hosts serve <grafana\|homebox>` | A real app with DocCue injected by a proxy, to try by hand (downloads the app once) |
| `pnpm --filter @doccue/hosts ask <app> [case]` | Cases on a real app with the real model; `DOCS=off` leaves the app's docs out to compare |
| `pnpm try [--tool] "question"` | One turn; `--tool` adds a demo tool that tells the time, to test the loop |
| `pnpm chat` | Multi-turn chat; logs go to `packages/core/.logs/` |
| `pnpm replay <log> [n]` | Lists the model calls in a log; with a number, sends that call again to compare answers |
| `pnpm test:unit` | Offline unit tests in `packages/*` (no API key needed) |
| `pnpm test` | Full tests. No fake models: tests of the agent's behaviour call the real model from `.env`, with the playground in the local Chrome |
| `pnpm typecheck` / `pnpm build` | Type-check / build |

CI runs the build, type-check, offline unit tests, and a packed-package smoke check against `examples/basic` on every push; tests with a real model run by hand (see [.github/workflows](.github/workflows)). See [CONTRIBUTING.md](CONTRIBUTING.md) if you'd like to contribute.

## Architecture

The agent runs in the backend, but most of what it works with (the screen, the user's actions, the guides) is in the browser. So the backend does one thing: take the whole conversation, call the model, stream back.

| Frontend `@doccue/bridge` | Backend `@doccue/core` |
| :--- | :--- |
| Perception: records actions and their effects, takes screen snapshots | Rendering: turns the conversation into model messages |
| Guides: spotlight, bubble, moving through steps | Loop: calls the model, runs backend tools, hands `guide` calls to the frontend |
| Chat panel: the built-in UI, loaded on demand | |
| Conversation: keeps it, sends requests, runs guides and reports back | Docs: searching and reading your product docs |
| | Model adapters, logs and replay |

What the two exchange is defined in `@doccue/protocol`. The full design is in [architecture_design.md](architecture_design.md) and the code layout and progress in [project_structure.md](project_structure.md) (both in Chinese).

```text
packages/protocol/       what the frontend and backend exchange (types only)
packages/core/           backend
  src/
    model/               model adapters, stream parsing, retries
    loop/                the loop: call the model → run tools → call again
    render/              the conversation as model messages
    docs/                product docs: sections, search, search_docs / read_doc
    agent/               one request
    protocol/            request validation
    server/              the HTTP handler, the Node adapter
    log/                 logs and replay
  scripts/               try / chat / replay
packages/bridge/src/     frontend: naming controls, recording, snapshots, errors, finding elements, guides, the conversation, the chat panel
apps/playground/         the demo app and end-to-end tests
apps/evals/              eval cases
apps/hosts/              real apps not written for DocCue (Grafana, Homebox), behind an injecting proxy
examples/                apps that use the published packages
```

## Roadmap

- [x] **Skeleton**: protocol, stateless API, conversation in the frontend, structured perception.
- [x] **Guides on one screen**: highlight a control with a bubble, move on when the user has done the step; the result goes back to the model.
- [x] **Guides across screens**: carries on after page changes, dialogs and full page loads, and keeps up when the user goes off course or does a later step first.
- [x] **Docs**: the model searches and reads your product docs as needed; small docs go into the prompt whole. Or plug in your own search.
- [x] **Chat panel** and language packs: one line to add, folds while a guide runs, English and Chinese, every word replaceable.
- [x] **Real apps**: tried on Grafana and Homebox, fixed where they showed gaps (custom dropdowns and date pickers, icon-only buttons, popups, labels tied to the wrong element).
- [ ] **First release** on npm.

Later: screenshots on demand (charts, canvases), preset first-run tours, Skills, proactive hints, redaction.

Not planned: built-in vector search; bridges for native clients (Qt, WPF, native Android/iOS).

## Contributing & Changelog

- Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, offline testing (`pnpm test:unit`), and PR guidelines.
- See [CHANGELOG.md](CHANGELOG.md) for release history and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[MIT](LICENSE)
