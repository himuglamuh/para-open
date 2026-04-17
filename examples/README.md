# para-open examples

Three scenarios you can run end-to-end to see how the tool works. Each has a
`prompt.md` (the task) and a `src/` directory (the codebase the model edits).

Run any of them like this (from the repo root):

```sh
para-open --prompt-file examples/bug-fix/prompt.md \
          --source-dir  examples/bug-fix/src \
          --models      ./models.json \
          --out         ./runs
```

Then inspect `runs/<latest>/report.md` for the synthesized comparison.

## Scenarios

| Folder | What the prompt asks |
| --- | --- |
| `bug-fix/` | Find and fix an off-by-one bug in `sum.js`; the failing test in `sum.test.js` pins the expected behavior. |
| `refactor/` | Convert nested callbacks in `fetcher.js` into modern `async/await` while preserving behavior. |
| `greenfield/` | Implement a `wc`-style word-count CLI from scratch in `src/` with no dependencies, plus tests. |

## Tips

- For fast iteration, start with `--no-synth` to skip the (slow) synthesis step.
- Use `--concurrency 2` if your provider rate-limits you.
- The `bug-fix` scenario is the cheapest to run — start there.
