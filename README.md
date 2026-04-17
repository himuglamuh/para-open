# para-open

Run the same prompt across many [`opencode`](https://opencode.ai) models in parallel, then have a powerful "synthesizer" model (default: Claude Opus 4.7) read every model's tool transcript and final output and produce a single comparison report.

Useful for:
- **Model evaluation** — see how Claude vs GPT vs Gemini approach the same coding task on the same codebase.
- **Best-of-N answers** — when one model is wrong, another usually isn't; the synthesis report makes the disagreement visible.
- **Research / dossiers** — every run is captured to disk (prompt, raw event stream, file changes, derived status) so you can re-analyze later.

## Install

```sh
npm install -g @himuglamuh/para-open
```

Requirements:

- Node ≥ 20
- [`opencode`](https://opencode.ai) on `PATH` and at least one authenticated provider (`opencode auth`)
- Disk space — each model gets its own copy of the source dir under `runs/<run>/<label>/workspace/`. A 100MB repo × 6 models = 600MB per run. Use `--no-source` for prompt-only experiments.

> **Provider note:** the default `models.json` ships three `github-copilot/*` models (Claude / GPT / Gemini families). They require a GitHub Copilot subscription. To mix in `anthropic/*` or `openai/*` direct-API models, edit `models.json` (see `models.example.json` for a longer Copilot catalog) and ensure `opencode auth` has the relevant credentials.

## Usage

```sh
# inline prompt, runs against ./ as the source dir
para-open "Refactor foo.ts to use async/await and add a test."

# prompt from file
para-open --prompt-file ./prompt.md

# custom options
para-open --prompt-file p.md \
  --models ./models.json \
  --source-dir ./my-project \
  --out ./runs \
  --timeout 900 \
  --concurrency 4 \
  --no-synth

# re-synthesize an existing run (rebuilds dossier + report.md)
para-open synth ./runs/2026-04-17T16-20-05Z-4a6b57d1

# ask a follow-up question against the synthesizer's session
para-open ask ./runs/2026-04-17T16-20-05Z-4a6b57d1 \
  "Elaborate on why opus-4.7 hit the content filter."
```

### Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--prompt-file <path>` | — | Read prompt from file instead of positional. |
| `--models <path>` | `./models.json` | Override model config. |
| `--source-dir <path>` | `process.cwd()` | Directory cloned into each run's workspace. |
| `--no-source` | — | Skip cloning a source dir (empty workspaces). |
| `--out <path>` | `./runs` | Root for run outputs. |
| `--timeout <seconds>` | `900` | Per-run hard timeout. |
| `--concurrency <N>` | `6` | Max parallel model runs. |
| `--synth-timeout <seconds>` | `1800` | Timeout for the synthesis step. |
| `--synth-model <id>` | from config | Override the synthesizer model. |
| `--no-synth` | — | Skip the synthesis step. |
| `--dry-run` | — | Print planned spawn commands and exit. |
| `--ask-timeout <seconds>` | `300` | Timeout for `ask` follow-ups. |
| `--question-file <path>` | — | (`ask`) Read question from a file. |
| `--fresh` | — | (`ask`) Start a new session instead of resuming the synthesis session. |
| `-v, --version` | — | Print version. |
| `-h, --help` | — | Show help. |

### Subcommands

- **`synth <run-root>`** — rebuild `dossier.md` and `report.md` for an existing run. Refreshes each model's status/analysis from `stdout.jsonl` before synthesis. Captures the synthesizer's session ID to `synthesis.session.json` so follow-ups can resume it.
- **`ask <run-root> "<question>"`** — ask a follow-up against the captured synthesis session. Uses `opencode run -s <session>` for conversational continuity. Falls back to attaching `dossier.md` + `report.md` if no session is recorded.

Answers land in `<run-root>/followups/NNN.{question.md,stdout.jsonl,stderr.log,answer.md}`.

> **Note on resumed-session length:** Some providers (notably Copilot) give noticeably shorter answers when continuing a session that already absorbed a large dossier. If you want a long, structured follow-up, pass `--fresh` — that starts a new session and re-attaches `dossier.md` + `report.md`.

## Output layout

```
runs/<UTC-ISO>-<shortid>/
├── prompt.txt
├── index.json
├── dossier.md                # consolidated input handed to the synthesizer
├── report.md                 # final comparison, written by the synthesizer
├── synthesis.stdout.jsonl
├── synthesis.stderr.log
├── synthesis.session.json    # captured session id for follow-ups
├── followups/                # created on first `ask`
│   └── 001.{question,answer}.md + stdout.jsonl / stderr.log
├── <label>/
│   ├── workspace/            # isolated copy of --source-dir (post-run state)
│   ├── stdout.jsonl
│   ├── stderr.log
│   ├── final.md              # extracted final assistant message (with status header if non-ok)
│   ├── changes.txt           # files the model modified/created
│   └── meta.json             # model id, timing, exit code, signal, status, analysis
└── ...
```

## Model config

`models.json` schema:

```json
{
  "synthesizer": "github-copilot/claude-opus-4.7",
  "models": [
    { "id": "github-copilot/claude-sonnet-4.5", "label": "claude-sonnet-4.5" },
    { "id": "github-copilot/gpt-5.2",          "label": "gpt-5.2" },
    { "id": "github-copilot/gemini-2.5-pro",   "label": "gemini-2.5-pro" }
  ]
}
```

Labels are optional (auto-slugified from `id` if omitted). See [`models.example.json`](./models.example.json) for a larger Copilot catalog you can copy from.

### Bootstrapping `models.json`

Rather than hand-writing the file, run `para-open init-models` to generate one
from the providers you've already authenticated with `opencode`:

```bash
# Interactive picker (default when run from a TTY)
para-open init-models

# Every authenticated model
para-open init-models --all

# All models from one provider
para-open init-models --provider anthropic

# Glob-match (any number of patterns)
para-open init-models --filter '*opus*' '*gpt-5*'

# Curated presets (will go stale as new model versions ship)
para-open init-models --preset frontier        # one strong model per family
para-open init-models --preset cheap           # haiku / mini / flash tier
para-open init-models --preset claude-vs-gpt   # head-to-head pair

# Pin the synthesizer explicitly
para-open init-models --all --synth openai/gpt-5

# Print to stdout instead of writing a file
para-open init-models --preset frontier --stdout

# Overwrite an existing models.json
para-open init-models --all --force
```

The synthesizer defaults to `claude-opus-4.7` when available, falling back to
sonnet variants then `gpt-5`. Override with `--synth <id>`.

## Run status

Each run is classified into a `status` that the dossier, summary table, and `final.md` warning header all surface:

| Status | Meaning |
| --- | --- |
| `ok` | Finished with a normal stop reason and real assistant output. |
| `content-filtered` | Provider aborted one or more steps with `reason: "content-filter"`. Exit code is usually 0 — only the event stream reveals the failure. |
| `timeout` | Killed by the per-run timeout (`SIGTERM`). |
| `spawn-error` | Process failed to start (bad binary, missing auth, etc.). |
| `crashed` | Non-zero exit code that is not a timeout. |
| `empty` | Finished cleanly but produced no assistant text. |
| `tool-loop` | Heuristic: lots of steps ending in `tool-calls`, minimal final text. |
| `incomplete` | Finished without a natural stop reason. |

The synthesizer is explicitly told to treat non-`ok` runs as failures and to describe what the model was doing (via the tool transcript in the dossier) when it aborted.

## Examples

See [`examples/`](./examples/) for ready-to-run scenarios:

- `examples/bug-fix/` — find and fix an off-by-one bug.
- `examples/refactor/` — convert a callback-chain to async/await.
- `examples/greenfield/` — implement a small CLI tool from scratch.

Each scenario has a `prompt.md` and a `src/` you can pass to `--source-dir`.

## License

[MIT](./LICENSE)
