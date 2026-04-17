import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { synthesize, askFollowUp, __exportLatestAssistantText } from "../../src/synthesizer.ts";
import { __resetForTests } from "../../src/runner.ts";
import type { OrchestrationResult, ModelRunSummary } from "../../src/orchestrator.ts";
import { makeFakeBinDir } from "../helpers/fakeOpencode.ts";
import { makeTmpDir } from "../helpers/tmp.ts";
import { captureStderr } from "../helpers/silenceStderr.ts";

function withEnv(t: Parameters<typeof makeTmpDir>[0], env: Record<string, string>): void {
  const original: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    original[k] = process.env[k];
    process.env[k] = env[k];
  }
  t.after(() => {
    for (const k of Object.keys(original)) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    __resetForTests();
  });
}

async function setupRunRoot(t: Parameters<typeof makeTmpDir>[0]): Promise<{ runRoot: string; result: OrchestrationResult }> {
  const root = await makeTmpDir(t);
  await writeFile(join(root, "prompt.txt"), "what is 2+2?");
  const alphaDir = join(root, "alpha");
  await mkdir(alphaDir, { recursive: true });
  await writeFile(join(alphaDir, "final.md"), "Alpha says 4.");
  await writeFile(join(alphaDir, "changes.txt"), "# Created (0)\n");
  await writeFile(join(alphaDir, "stdout.jsonl"), "");
  await writeFile(join(alphaDir, "stderr.log"), "");
  const summary: ModelRunSummary = {
    label: "alpha",
    modelId: "vendor/alpha",
    durationMs: 100,
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    changes: { created: 0, modified: 0, deleted: 0 },
    stdoutFile: join(alphaDir, "stdout.jsonl"),
    stderrFile: join(alphaDir, "stderr.log"),
    finalFile: join(alphaDir, "final.md"),
    metaFile: join(alphaDir, "meta.json"),
    changesFile: join(alphaDir, "changes.txt"),
    workspace: join(alphaDir, "workspace"),
    modelDir: alphaDir,
    status: "ok",
    statusReasons: [],
    analysis: {
      stepCount: 1,
      finishReasons: ["stop"],
      lastFinishReason: "stop",
      contentFilterHit: false,
      firstContentFilterAt: null,
      toolCount: 0,
      toolBreakdown: {},
      toolSequence: [],
      assistantTextCount: 1,
      assistantTextBytes: 50,
      lastAssistantText: "Alpha says 4.",
      sessionId: "ses_alpha",
      toolLoopSuspected: false,
    },
  };
  return {
    runRoot: root,
    result: {
      runRoot: root,
      promptFile: join(root, "prompt.txt"),
      summaries: [summary],
    },
  };
}

test("synthesize: happy path - synthesizer writes report.md", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  withEnv(t, {
    PATH: pathEnv,
    PARAOPEN_FAKE_MODE: "synth-writes-report",
    PARAOPEN_FAKE_REPORT_TEXT: "# Verdict\n\nWinner: alpha.\n",
  });
  captureStderr(t);

  const { result } = await setupRunRoot(t);
  const synth = await synthesize(result, {
    synthesizerModel: "fake/synth",
    timeoutMs: 30_000,
  });

  assert.equal(synth.exitCode, 0);
  assert.equal(synth.spawnError, null);
  assert.equal(synth.timedOut, false);
  assert.match(await readFile(synth.reportFile, "utf8"), /Winner: alpha/);
  assert.match(await readFile(synth.dossierFile, "utf8"), /## Original prompt/);
  assert.match(await readFile(synth.dossierFile, "utf8"), /what is 2\+2\?/);
  assert.equal(synth.sessionId, "ses_fake00000000000000000001");
  // session.json persisted
  const session = JSON.parse(await readFile(synth.sessionFile, "utf8"));
  assert.equal(session.sessionId, "ses_fake00000000000000000001");
});

test("synthesize: fallback path - synthesizer doesn't write report.md, stdout text used", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  withEnv(t, { PATH: pathEnv, PARAOPEN_FAKE_MODE: "synth-fallback" });
  captureStderr(t);

  const { result } = await setupRunRoot(t);
  const synth = await synthesize(result, {
    synthesizerModel: "fake/synth",
    timeoutMs: 30_000,
  });

  const reportText = await readFile(synth.reportFile, "utf8");
  assert.match(reportText, /report\.md fallback/);
  assert.match(reportText, /Winner: beta/);
});

test("askFollowUp: fresh session attaches dossier+report and saves session.json", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  withEnv(t, { PATH: pathEnv, PARAOPEN_FAKE_MODE: "ok" });
  captureStderr(t);

  const { runRoot } = await setupRunRoot(t);
  // Pre-populate dossier/report so the -f flags are emitted
  await writeFile(join(runRoot, "dossier.md"), "DOSSIER");
  await writeFile(join(runRoot, "report.md"), "REPORT");

  const r = await askFollowUp({
    runRoot,
    question: "elaborate?",
    timeoutMs: 30_000,
    fresh: true,
    model: "fake/synth",
  });

  assert.equal(r.exitCode, 0);
  assert.ok(r.answer.length > 0);
  // Saves session.json since fresh + no prior session existed
  const session = JSON.parse(await readFile(join(runRoot, "synthesis.session.json"), "utf8"));
  assert.equal(session.sessionId, "ses_fake00000000000000000001");
});

test("askFollowUp: resume path uses opencode export to fetch the answer", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  withEnv(t, {
    PATH: pathEnv,
    PARAOPEN_FAKE_MODE: "ok",
    PARAOPEN_FAKE_EXPORT_TEXT: "Resumed-session canonical answer.",
  });
  captureStderr(t);

  const { runRoot } = await setupRunRoot(t);
  // Seed a saved session so askFollowUp resumes via -s.
  await writeFile(
    join(runRoot, "synthesis.session.json"),
    JSON.stringify({
      sessionId: "ses_resumed0000000000000001",
      synthesizerModel: "fake/synth",
      capturedAt: "2026-01-01T00:00:00Z",
    }),
  );

  const r = await askFollowUp({
    runRoot,
    question: "another question?",
    timeoutMs: 30_000,
  });
  assert.match(r.answer, /Resumed-session canonical answer/);
  // Answer file recorded under followups/001.answer.md
  const answerText = await readFile(join(runRoot, "followups", "001.answer.md"), "utf8");
  assert.match(answerText, /Resumed-session canonical answer/);
});

test("exportLatestAssistantText: returns the last assistant text from canned export JSON", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  withEnv(t, { PATH: pathEnv, PARAOPEN_FAKE_EXPORT_TEXT: "the-final-text" });
  const text = await __exportLatestAssistantText("ses_anything");
  assert.equal(text, "the-final-text");
});

test("exportLatestAssistantText: malformed JSON returns empty string (graceful failure)", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  withEnv(t, { PATH: pathEnv, PARAOPEN_FAKE_EXPORT_MALFORMED: "1" });
  const text = await __exportLatestAssistantText("ses_anything");
  assert.equal(text, "");
});
