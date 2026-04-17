import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  __readTextSafe,
  __tailText,
  __extractSessionId,
  __nextFollowupIndex,
  __buildDossier,
} from "../../src/synthesizer.ts";
import type { ModelRunSummary } from "../../src/orchestrator.ts";
import type { RunAnalysis } from "../../src/analysis.ts";
import { makeTmpDir } from "../helpers/tmp.ts";

/* ------------------------------ readTextSafe ------------------------------ */

test("readTextSafe: returns full content when under maxBytes", async (t) => {
  const dir = await makeTmpDir(t);
  const p = join(dir, "f.txt");
  await writeFile(p, "hello");
  assert.equal(await __readTextSafe(p, 100), "hello");
});

test("readTextSafe: returns empty string for missing file", async (t) => {
  const dir = await makeTmpDir(t);
  assert.equal(await __readTextSafe(join(dir, "missing.txt")), "");
});

test("readTextSafe: truncates with TRUNCATED marker when over maxBytes", async (t) => {
  const dir = await makeTmpDir(t);
  const p = join(dir, "big.txt");
  const content = "A".repeat(10_000);
  await writeFile(p, content);
  const out = await __readTextSafe(p, 1_000);
  assert.match(out, /\[TRUNCATED \d+ bytes\]/);
  // 80% head + 15% tail of maxBytes
  assert.ok(out.length < content.length);
  assert.ok(out.startsWith("A"));
});

/* -------------------------------- tailText -------------------------------- */

test("tailText: returns whole content when small", async (t) => {
  const dir = await makeTmpDir(t);
  const p = join(dir, "s.txt");
  await writeFile(p, "tiny");
  assert.equal(await __tailText(p, 100), "tiny");
});

test("tailText: emits truncation banner and returns last N bytes", async (t) => {
  const dir = await makeTmpDir(t);
  const p = join(dir, "long.txt");
  const content = "X".repeat(500) + "TAILEND";
  await writeFile(p, content);
  const out = await __tailText(p, 10);
  assert.match(out, /\[truncated; showing tail 10 of \d+ bytes\]/);
  assert.ok(out.endsWith("TAILEND".slice(-10) + "TAILEND".slice(0)) || out.endsWith("AILEND"));
});

test("tailText: missing file returns empty string", async (t) => {
  const dir = await makeTmpDir(t);
  assert.equal(await __tailText(join(dir, "nope"), 100), "");
});

/* ----------------------------- extractSessionId --------------------------- */

test("extractSessionId: pulls first ses_ id from stdout file", async (t) => {
  const dir = await makeTmpDir(t);
  const p = join(dir, "stdout.jsonl");
  await writeFile(
    p,
    [
      `{"sessionID":"ses_abcDEF1234567890","part":{"type":"step-finish","reason":"stop"}}`,
      `{"sessionID":"ses_abcDEF1234567890","part":{"type":"text","text":"ok"}}`,
    ].join("\n"),
  );
  assert.equal(await __extractSessionId(p), "ses_abcDEF1234567890");
});

test("extractSessionId: returns null when no session id is present", async (t) => {
  const dir = await makeTmpDir(t);
  const p = join(dir, "stdout.jsonl");
  await writeFile(p, `{"part":{"type":"text","text":"x"}}\n`);
  assert.equal(await __extractSessionId(p), null);
});

test("extractSessionId: returns null on missing file", async (t) => {
  const dir = await makeTmpDir(t);
  assert.equal(await __extractSessionId(join(dir, "nope")), null);
});

/* --------------------------- nextFollowupIndex --------------------------- */

test("nextFollowupIndex: empty/missing dir returns 1", async (t) => {
  const dir = await makeTmpDir(t);
  // Missing entirely
  assert.equal(await __nextFollowupIndex(join(dir, "absent")), 1);
  // Empty existing dir
  await mkdir(join(dir, "empty"));
  assert.equal(await __nextFollowupIndex(join(dir, "empty")), 1);
});

test("nextFollowupIndex: skips existing numbered prefixes and fills the first gap", async (t) => {
  const dir = await makeTmpDir(t);
  await writeFile(join(dir, "001.question.md"), "");
  await writeFile(join(dir, "002.question.md"), "");
  await writeFile(join(dir, "004.question.md"), "");
  await writeFile(join(dir, "README.md"), ""); // ignored: no leading digits
  assert.equal(await __nextFollowupIndex(dir), 3);
});

/* ------------------------------- buildDossier ----------------------------- */

function mkAnalysis(overrides: Partial<RunAnalysis> = {}): RunAnalysis {
  return {
    stepCount: 2,
    finishReasons: ["tool-calls", "stop"],
    lastFinishReason: "stop",
    contentFilterHit: false,
    firstContentFilterAt: null,
    toolCount: 1,
    toolBreakdown: { read: 1 },
    toolSequence: [{ tool: "read", status: "completed", summary: "README.md" }],
    assistantTextCount: 1,
    assistantTextBytes: 50,
    lastAssistantText: "Hello",
    sessionId: "ses_x",
    toolLoopSuspected: false,
    ...overrides,
  };
}

function mkSummary(overrides: Partial<ModelRunSummary> = {}): ModelRunSummary {
  return {
    label: "alpha",
    modelId: "v/m",
    durationMs: 1234,
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    changes: { created: 1, modified: 0, deleted: 0 },
    stdoutFile: "",
    stderrFile: "",
    finalFile: "",
    metaFile: "",
    changesFile: "",
    workspace: "",
    modelDir: "",
    status: "ok",
    statusReasons: [],
    analysis: mkAnalysis(),
    ...overrides,
  };
}

test("buildDossier: includes prompt, overview table, per-model sections", async (t) => {
  const runRoot = await makeTmpDir(t);
  await writeFile(join(runRoot, "prompt.txt"), "What is the meaning of life?");

  const alphaDir = join(runRoot, "alpha");
  const betaDir = join(runRoot, "beta");
  await mkdir(alphaDir);
  await mkdir(betaDir);
  await writeFile(join(alphaDir, "final.md"), "Alpha's final answer.");
  await writeFile(join(alphaDir, "changes.txt"), "# Created (1)\n+ foo.txt\n");
  await writeFile(join(betaDir, "final.md"), "Beta did not answer.");
  await writeFile(join(betaDir, "changes.txt"), "# Created (0)\n");
  await writeFile(join(betaDir, "stderr.log"), "panic: something\n".repeat(20));

  const summaries = [
    mkSummary({
      label: "alpha",
      modelId: "vendor/alpha",
      finalFile: join(alphaDir, "final.md"),
      changesFile: join(alphaDir, "changes.txt"),
    }),
    mkSummary({
      label: "beta",
      modelId: "vendor/beta",
      status: "tool-loop",
      statusReasons: ["loop detected"],
      finalFile: join(betaDir, "final.md"),
      changesFile: join(betaDir, "changes.txt"),
      stderrFile: join(betaDir, "stderr.log"),
      analysis: mkAnalysis({ lastFinishReason: "tool-calls", toolLoopSuspected: true }),
    }),
  ];

  const dossier = await __buildDossier(runRoot, summaries);

  // Prompt block (fenced)
  assert.match(dossier, /## Original prompt/);
  assert.match(dossier, /What is the meaning of life\?/);

  // Overview header
  assert.match(dossier, /\| label \| model \| status \|/);
  // Both models in overview
  assert.match(dossier, /\| alpha \| vendor\/alpha \| \*\*ok\*\*/);
  assert.match(dossier, /\| beta \| vendor\/beta \| \*\*tool-loop\*\*/);

  // Per-model sections
  assert.match(dossier, /## Model: alpha \(vendor\/alpha\)/);
  assert.match(dossier, /## Model: beta \(vendor\/beta\)/);

  // Status reasons rendered for non-ok
  assert.match(dossier, /\*\*Status reasons:\*\*/);
  assert.match(dossier, /- loop detected/);

  // Tool transcript table
  assert.match(dossier, /### Tool transcript/);
  assert.match(dossier, /\| 1 \| read \| completed \| README\.md \|/);

  // File changes block
  assert.match(dossier, /### File changes/);
  assert.match(dossier, /\+ foo\.txt/);

  // Final assistant message included for both
  assert.match(dossier, /Alpha's final answer/);
  assert.match(dossier, /Beta did not answer/);

  // Stderr tail only for non-ok (beta)
  assert.match(dossier, /### stderr tail/);
  assert.match(dossier, /panic: something/);
});

test("buildDossier: tool transcript truncates beyond MAX_TOOL_TRANSCRIPT_ROWS", async (t) => {
  const runRoot = await makeTmpDir(t);
  await writeFile(join(runRoot, "prompt.txt"), "p");
  const seq = Array.from({ length: 60 }, (_, i) => ({
    tool: "bash",
    status: "completed",
    summary: `cmd ${i}`,
  }));
  const s = mkSummary({
    finalFile: join(runRoot, "missing-final.md"),
    changesFile: join(runRoot, "missing-changes.txt"),
    analysis: mkAnalysis({ toolSequence: seq, toolCount: 60 }),
  });
  const dossier = await __buildDossier(runRoot, [s]);
  assert.match(dossier, /20 more tool calls omitted/); // 60 - 40 = 20
  assert.match(dossier, /\| 40 \| bash \|/); // last shown row
  assert.ok(!/\| 41 \| bash \|/.test(dossier));
});
