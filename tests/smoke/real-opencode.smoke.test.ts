import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createRunRoot } from "../../src/workspace.ts";
import { orchestrate } from "../../src/orchestrator.ts";
import { __resetForTests } from "../../src/runner.ts";
import { makeTmpDir } from "../helpers/tmp.ts";

const SMOKE_ENABLED = process.env.PARA_OPEN_SMOKE === "1";
const SMOKE_MODEL = process.env.PARA_OPEN_SMOKE_MODEL;

/**
 * Real-network smoke test. Disabled by default; opt in by setting:
 *   PARA_OPEN_SMOKE=1
 *   PARA_OPEN_SMOKE_MODEL=<your model id>     (e.g. github-copilot/gpt-4o-mini)
 *
 * Requires the real `opencode` binary on PATH and credentials configured.
 *
 * The model id is intentionally NOT defaulted to anything - we want this to
 * fail loudly if you flip the flag without choosing a model, rather than
 * silently spending tokens on a default.
 */
test(
  "smoke: real opencode produces an ok run with --no-synth",
  { skip: !SMOKE_ENABLED ? "Set PARA_OPEN_SMOKE=1 to run smoke tests" : false },
  async (t) => {
    if (!SMOKE_MODEL) {
      assert.fail(
        "PARA_OPEN_SMOKE=1 requires PARA_OPEN_SMOKE_MODEL=<model id> to be set",
      );
    }
    t.after(() => __resetForTests());

    const tmp = await makeTmpDir(t, "para-open-smoke-");
    const modelsPath = join(tmp, "models.smoke.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        synthesizer: SMOKE_MODEL,
        models: [{ id: SMOKE_MODEL, label: "smoke" }],
      }),
    );

    const cfg = await loadConfig(modelsPath);
    const layout = await createRunRoot(join(tmp, "runs"));
    // Prompt asks for >200 bytes so the run clears the analysis.ts
    // "incomplete" threshold and exercises the real `ok` classification.
    const result = await orchestrate(layout, cfg, {
      prompt:
        "Write a single paragraph of at least 60 words explaining what a hash map is. " +
        "No code, no headings, no lists - just one plain prose paragraph.",
      sourceDir: null,
      timeoutMs: 120_000,
      dryRun: false,
      concurrency: 1,
    });

    assert.equal(result.summaries.length, 1);
    const s = result.summaries[0];
    assert.equal(
      s.status,
      "ok",
      `expected ok, got ${s.status}: ${s.statusReasons.join("; ")}`,
    );

    // final.md exists and is non-empty
    const final = await readFile(s.finalFile, "utf8");
    assert.ok(final.trim().length > 0, "final.md should be non-empty");

    // index.json was written and agrees with the in-memory summary
    const runs = await readdir(join(tmp, "runs"));
    assert.equal(runs.length, 1);
    const idx = JSON.parse(
      await readFile(join(tmp, "runs", runs[0], "index.json"), "utf8"),
    );
    assert.equal(idx.models[0].status, "ok");
  },
);
