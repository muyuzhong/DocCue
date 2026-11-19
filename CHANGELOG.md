# Changelog

All notable changes to DocCue will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0 minor versions may include breaking API changes).

## [Unreleased]

### Fixed
- `@doccue/bridge`: `skipUrl` now matches the exact origin and pathname of `{endpoint}/turn`, fixing silent loss of network error capture and settle detection when `endpoint` is mounted at `/` or a separate origin's root (and avoiding false matches on sibling prefixes such as `/doccue-other`).
- `@doccue/bridge`: `bridge.mount()` is now idempotent across repeated or concurrent calls, and `bridge.destroy()` unmounts any mounted panel and cancels in-flight `mount()` imports cleanly (preventing orphaned or duplicate panels in React StrictMode).
- `@doccue/bridge`: The guide overlay now follows `--doccue-z` (`calc(var(--doccue-z, 2147483647) - 1)`) so the chat panel stays above the dim backdrop when customized, and the spotlight border follows `--doccue-accent`.
- `@doccue/bridge`: Aborted `XMLHttpRequest` calls are no longer recorded as `request_failed`, listeners use `{ once: true }`, and synchronous `send()` throws no longer leak the in-flight counter.
- `@doccue/core`: `toNodeHandler` now supports requests whose stream was already consumed by upstream middleware (such as `express.json()`, `express.text()`, or `express.raw()`) via `req.body`, while still enforcing `maxBodyBytes`; `res.on('close')` no longer aborts after normal completion.

### Added
- `@doccue/bridge`: `headers` (static or sync/async getter), `credentials`, and custom `fetch` options on `createBridge` for authenticated and cross-origin backends.
- API & integration reference (`docs/api.md`), contributor guide (`CONTRIBUTING.md`), security policy (`SECURITY.md`), `.editorconfig`, and GitHub issue/PR templates.
- `pnpm test:unit` script for running offline unit tests without an API key, plus CI verification of packed packages against `examples/basic`.

## [0.1.0] - Unreleased

### Added
- `@doccue/protocol`: Shared language-neutral types (`Screen`, `Locator`, `TimelineEntry`, `GuideStep`, `GuideResult`, `Item`, `TurnRequest`, `StreamEvent`) and `PROTOCOL_VERSION`.
- `@doccue/core`: Stateless Fetch handler (`createHandler`), Node/Express adapter (`toNodeHandler`), Anthropic and OpenAI-compatible streaming adapters (`createAnthropic`, `createOpenAI`, `createModelFromEnv`, `withRetry`), agent loop with backend and page tools, deterministic conversation rendering, Markdown docs search/reading (`markdownDocs`, `createDocs`), and JSONL logging/replay.
- `@doccue/bridge`: Browser action/effect recorder, prioritized DOM screen snapshotter, element relocator, spotlight-and-bubble guide runner with cross-page and full-reload resume, lazy-loaded Shadow DOM chat panel with light/dark/auto themes, mobile fullscreen layout, safe Markdown renderer, and English/Chinese message packs.
- Examples (`examples/basic`, `examples/nextjs`), playground app, evals, journeys, and real-app verification harnesses (Grafana, Homebox).
