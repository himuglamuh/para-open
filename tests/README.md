# para-open test suite

Comprehensive tests for `para-open`, organized in four layers:

```
tests/
  unit/         pure functions (no fs, no spawn) — fast
  integration/  real fs in tmp dirs (no spawn)   — fast
  e2e/          spawns the fake opencode binary  — medium
  smoke/        spawns the REAL opencode binary  — opt-in (network + tokens)
  fixtures/     fake-opencode.cjs (test double)
  helpers/      shared utilities (tmp dirs, jsonl builders, env helpers)
```

## Running

```sh
npm test               # unit + integration + e2e
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:coverage  # everything above with --experimental-test-coverage
```

All test scripts run with `--test-concurrency=1`. Several E2E tests mutate
`process.env` (and the orchestrator/runner forward `process.env` to children),
so serial execution avoids cross-test interference.

## Smoke tests (real network, opt-in)

The smoke test exercises the real `opencode` binary against a real model. It
is skipped by default and requires two env vars to run:

```sh
PARA_OPEN_SMOKE=1 PARA_OPEN_SMOKE_MODEL=github-copilot/gpt-4o-mini npm run test:smoke
```

There is intentionally **no default** for `PARA_OPEN_SMOKE_MODEL`. If
`PARA_OPEN_SMOKE=1` is set without choosing a model, the test fails loudly
rather than silently spending tokens on a default.

## The fake opencode binary

`tests/fixtures/fake-opencode.cjs` is a small Node script that mimics the
contract of `opencode run` and `opencode export`. Its behavior is controlled
entirely by environment variables (see the file header for the full list).

Two helpers expose it to tests:

- `fakeBinaryPath()` — returns the absolute path to the fake script. Pass it
  to `runOpencode(spec, { binary: ... })` when calling the runner directly.
- `makeFakeBinDir(t)` — creates a temp directory with a shell shim named
  `opencode` that execs the fake script, returns `{ binDir, pathEnv }` so you
  can prepend it to `PATH` when spawning the para-open CLI itself (which calls
  `opencode` by name).

## What is NOT covered

- The actual `opencode` binary's behavior (only its contract is mocked). The
  smoke test layer exists for that.
- Cross-platform behavior (Windows). The fake binary uses POSIX shell shims
  for `PATH` injection; on Windows you'd need a different shim strategy.
- The SIGINT/SIGTERM forwarding installed by `installSignalForwarding()` is
  exercised indirectly (timeout escalates to SIGTERM, child receives it via
  the same mechanism), but a dedicated "signal propagation across nested
  children" test is not included.
