# Contributing to DocCue

Thanks for your interest in DocCue. This project aims to stay small, dependency-free in its runtime packages, and verified against real browsers and real apps.

## Prerequisites

- **Node.js 22+**
- **pnpm 11** (matching `packageManager` in `package.json`; `corepack enable` picks it up automatically)

```bash
git clone https://github.com/muyuzhong/DocCue.git
cd DocCue
pnpm install
```

## Running Checks Without an API Key

By default, `pnpm test` runs **all** tests, including tests that call a real LLM configured in `.env`, and fails loudly when no key is configured (no fake models for model-behaviour assertions).

If you do not have an API key configured, run the build, type-check, and offline unit tests:

```bash
pnpm build
pnpm typecheck
pnpm test:unit
```

(`pnpm test:unit` runs all tests in `packages/*` with `DOCCUE_SKIP_MODEL_TESTS=1`.)

## Running Real-Model Tests, Evals, and Host Apps

Copy `.env.example` to `.env` and set your API key (Anthropic or any OpenAI-compatible server):

```bash
cp .env.example .env
```

| Command | Purpose |
| :--- | :--- |
| `pnpm test` | Full test suite, including real-model core tests and playground Chrome tests |
| `pnpm playground` | Run the demo app locally at `http://localhost:5173` |
| `pnpm eval [filter]` | Single-step pointing evals against a real model |
| `pnpm journeys [filter]` | Multi-step browser journeys in local Chrome |
| `pnpm --filter @doccue/hosts serve <grafana\|homebox>` | Try DocCue injected into a real app via proxy |
| `pnpm --filter @doccue/hosts look <app> [filter]` | Inspect screen snapshots on a real app (no model calls) |
| `pnpm --filter @doccue/hosts ask <app> [filter]` | Run real-model scenarios on a real app |
| `pnpm chat` | Multi-turn CLI chat simulating bridge context |
| `pnpm replay <log> [n]` | Inspect or replay a logged model call |

## Repository Layout & Design Rules

```text
packages/protocol/   Shared TypeScript types + PROTOCOL_VERSION
packages/core/       Stateless backend (model → loop → render → agent → server)
packages/bridge/     Browser bridge (perception, guide overlay, conversation, chat panel)
apps/playground/     Demo app and real-browser end-to-end tests
apps/evals/          Single-step pointing evals
apps/hosts/          Injecting proxy and real-app test harnesses (Grafana, Homebox)
examples/            Standalone apps depending on published @doccue/* packages
```

Please keep these invariants in mind when making changes:

1. **Zero runtime dependencies** in `@doccue/protocol`, `@doccue/core`, and `@doccue/bridge` (besides `@doccue/core` and `@doccue/bridge` depending on `@doccue/protocol`).
2. **Layer boundaries**: `@doccue/bridge` and `@doccue/core` never depend on each other; `@doccue/core/node` keeps Node-only imports out of the runtime-agnostic `@doccue/core` entry.
3. **Generic fixes with minimal tests**: When fixing an issue discovered on a specific host app (Grafana, Homebox, or your own app), keep the fix general — no app-specific special cases — and pair it with a focused offline unit test.
4. **Append-only history**: Never mutate or strip earlier model messages in ways that break prompt caching or Anthropic thinking-block replay.

For deeper architecture notes (in Chinese), see [architecture_design.md](architecture_design.md) and [project_structure.md](project_structure.md).

## Pull Request Checklist

- Follow the formatting conventions in [.editorconfig](.editorconfig) (2-space indent, LF, UTF-8, strict TypeScript).
- Keep PRs focused on one clear change.
- Verify `pnpm build`, `pnpm typecheck`, and `pnpm test:unit` pass locally.
- If your change touches prompts, rendering, snapshots, or the agent loop, run `pnpm eval` / `pnpm journeys` (or note why they were not run) and mention which model you tested with.
