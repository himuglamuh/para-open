# Contributing

Thanks for your interest in `para-open`!

## Project posture

`para-open` is a one-person project — built and maintained by a single human with heavy use of AI coding assistants (it's both the author's tool and his testbed for the very thing it does: comparing models on real work).

That means:

- **Issues and PRs are welcome**, including small fixes, doc improvements, new examples, and bug reports with reproductions.
- **Response times vary.** This isn't anyone's day job. A nudge after a couple of weeks is fine.
- **No roadmap promises.** Larger features may sit, get redesigned, or be politely declined if they don't fit the tool's scope (run N opencode models in parallel, synthesize a comparison). If you're planning something non-trivial, open an issue first so we can sanity-check the direction before you spend time on it.
- **Forks are encouraged** if you want to take it somewhere I won't.

## Prerequisites

- **Node.js ≥ 20** (the project is ESM + TypeScript via `tsx`).
- **[`opencode`](https://opencode.ai)** on your `PATH` for anything beyond the unit/integration tests. End-to-end tests use a fake `opencode` binary and don't need it; the optional smoke test does.
- **Provider auth** (`opencode auth`) for at least one model in `models.json` if you want to run the CLI for real. The default `models.json` uses `github-copilot/*` models — see the [README](./README.md#install) for alternatives.

## Setup

```sh
git clone https://github.com/himuglamuh/para-open.git
cd para-open
npm install
```

Common scripts:

```sh
npm run build      # tsc -> dist/
npm run dev        # tsx src/index.ts (run the CLI from source)
npm run clean      # rm -rf dist
npm start          # node dist/index.js (run the built CLI)
```

## Source layout

```
src/
├── index.ts          # CLI entry: arg parsing, subcommand dispatch
├── orchestrator.ts   # top-level run flow + summary table
├── runner.ts         # spawns opencode children, manages concurrency/timeouts
├── workspace.ts      # per-model source-dir cloning + change detection
├── analysis.ts       # parses stdout.jsonl into status/finishReasons/tool stats
├── synthesizer.ts    # builds dossier.md, runs the synth model, captures session
├── config.ts         # models.json loading + validation
└── util.ts           # small pure helpers (slugify, fmtDuration, pad, etc.)
tests/                # see tests/README.md
```

## Tests

The full suite is `node:test` + `tsx`, no extra test deps. All commands run from the repo root.

| Command | What it runs |
| --- | --- |
| `npm test` | Unit + integration + e2e (default; ~5s, no network, no real `opencode`). |
| `npm run test:unit` | Pure-function tests for `src/*`. |
| `npm run test:integration` | Filesystem-touching tests (workspace cloning, change detection, etc.). |
| `npm run test:e2e` | Spawns the CLI as a subprocess against a fake `opencode` binary. |
| `npm run test:smoke` | **Opt-in.** Spawns the real `opencode` against a real model — costs tokens. See below. |
| `npm run test:coverage` | Same as `npm test` plus `--experimental-test-coverage`. |

All suites run with `--test-concurrency=1` because several e2e tests mutate `process.env`.

### Smoke test (opt-in, costs tokens)

The smoke test is skipped by default and has **no default model** — you have to be explicit:

```sh
PARA_OPEN_SMOKE=1 \
PARA_OPEN_SMOKE_MODEL=github-copilot/gpt-5.2 \
npm run test:smoke
```

Optional knobs: `PARA_OPEN_SMOKE_TIMEOUT` (seconds, default 120). Make sure `opencode auth` is set up for the chosen provider first.

### Test architecture

For test-helper internals, the fake-opencode protocol, and notes on how the e2e harness works, see [`tests/README.md`](./tests/README.md).

## Style

- TypeScript strict mode, ESM, Node ≥ 20 APIs are fair game.
- No new runtime dependencies without a strong reason — keeping the install light is a goal.
- Prefer small pure functions for anything testable.
- New behavior should come with at least one test.

## Submitting changes

1. Fork + branch.
2. `npm test` should pass.
3. If you touched the CLI surface, update `README.md`. If you touched the test layout, update `tests/README.md`.
4. Open a PR with a short description of the *why*, not just the *what*.

That's it. Thanks for reading this far.
