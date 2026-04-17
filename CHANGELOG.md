# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-17

### Added

- `para-open init-models` subcommand bootstraps a `models.json` from the
  providers you've already authenticated with `opencode`. Supports five
  selection modes (`--interactive`, `--all`, `--provider`, `--filter`,
  `--preset`), three curated presets (`frontier`, `cheap`, `claude-vs-gpt`),
  auto-picking a sensible synthesizer (override with `--synth`), and
  output to a file or `--stdout`. No new runtime dependencies.

### Internal

- Extracted `validateModelsConfig` from `loadConfig` so the new
  `init-models` command can validate generated configs in-memory before
  writing them.

## [0.1.7] - 2026-04-17

### Fixed

- `runner`: Guard against double-invocation of the spawn finalizer. When
  `opencode` failed to spawn (e.g. binary not on PATH), some Node versions
  emitted both `'error'` and `'close'` events on the child process, causing
  the second handler to overwrite the spawn error and produce a misleading
  `crashed` status. Status is now correctly reported as `spawn-error`.

### Internal

- Release pipeline switched to npm OIDC trusted publishing with provenance.
- Test suite (132 tests, `node:test` + `tsx`) added across unit, integration,
  and e2e layers.

## [0.1.0] - 2026-04-17

### Added

- Initial public release.
- Parallel multi-model orchestration via the `opencode` CLI.
- Per-run capture: `stdout.jsonl`, `stderr.log`, `final.md`, `changes.txt`,
  `meta.json`, plus a top-level `index.json` and `prompt.txt`.
- Derived run status taxonomy: `ok`, `content-filtered`, `timeout`,
  `spawn-error`, `crashed`, `empty`, `tool-loop`, `incomplete`.
- Opus-4.7-by-default synthesis step producing a single `report.md`.
- `synth <run-root>` subcommand to (re)synthesize an existing run, refreshing
  each model's status/analysis from its stored event stream.
- `ask <run-root> "<question>"` subcommand with captured-session continuity
  (`synthesis.session.json`), `--fresh`, `--question-file`, and `--ask-timeout`.
- `--concurrency <N>` flag (default 6) to cap parallel model runs.
- `-v, --version` flag.
- Signal forwarding: `Ctrl-C` propagates to every tracked child process,
  including those spawned during `synth` and `ask`.
- 50 MB cap on stdout analysis to prevent OOM on pathological event streams.
- GitHub Actions CI matrix (Node 20, 22).
- Example scenarios under `examples/` (bug-fix, refactor, greenfield).
