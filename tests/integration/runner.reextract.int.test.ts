import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { reextractFinal, extractFinalAssistantMessage } from "../../src/runner.ts";
import { makeTmpDir } from "../helpers/tmp.ts";
import { jsonl, stepFinish, textEvent } from "../helpers/jsonl.ts";

test("reextractFinal: rewrites final.md and patches meta.json analysis fields", async (t) => {
  const root = await makeTmpDir(t);
  const stdoutFile = join(root, "stdout.jsonl");
  const finalFile = join(root, "final.md");
  const metaFile = join(root, "meta.json");
  const stderrFile = join(root, "stderr.log");

  await writeFile(
    stdoutFile,
    jsonl(
      stepFinish("stop", { sessionID: "ses_reext" }),
      textEvent("Refreshed answer " + "z".repeat(300)),
    ),
  );
  // Stale prior content
  await writeFile(finalFile, "STALE");
  await writeFile(
    metaFile,
    JSON.stringify({ status: "incomplete", statusReasons: ["old"], analysis: { stepCount: 999 } }),
  );

  const refreshed = await reextractFinal(stdoutFile, finalFile, {
    label: "alpha",
    modelId: "vendor/m",
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    durationMs: 1234,
    stderrFile,
    metaFile,
  });

  assert.equal(refreshed.status, "ok");
  assert.equal(refreshed.analysis.lastFinishReason, "stop");

  // final.md has the new text and no warning header
  const finalText = await readFile(finalFile, "utf8");
  assert.match(finalText, /^Refreshed answer/);
  assert.ok(!/PARA-OPEN STATUS/.test(finalText));

  // meta.json refreshed
  const meta = JSON.parse(await readFile(metaFile, "utf8")) as {
    status: string;
    analysis: { stepCount: number; lastFinishReason: string };
  };
  assert.equal(meta.status, "ok");
  assert.equal(meta.analysis.stepCount, 1);
  assert.equal(meta.analysis.lastFinishReason, "stop");
});

test("reextractFinal: writes a non-ok header for crashed runs", async (t) => {
  const root = await makeTmpDir(t);
  const stdoutFile = join(root, "stdout.jsonl");
  const finalFile = join(root, "final.md");
  await writeFile(stdoutFile, jsonl(stepFinish("stop"), textEvent("partial")));

  await reextractFinal(stdoutFile, finalFile, {
    label: "x",
    modelId: "y",
    exitCode: 137,
    signal: null,
    timedOut: false,
    spawnError: null,
    durationMs: 0,
  });

  const finalText = await readFile(finalFile, "utf8");
  assert.match(finalText, /PARA-OPEN STATUS: crashed/);
  assert.match(finalText, /non-zero exit 137/);
});

test("extractFinalAssistantMessage: returns trimmed last assistant text + newline", async (t) => {
  const root = await makeTmpDir(t);
  const stdoutFile = join(root, "stdout.jsonl");
  await writeFile(
    stdoutFile,
    jsonl(textEvent("first chunk"), textEvent("  final answer  "), stepFinish("stop")),
  );
  const out = await extractFinalAssistantMessage(stdoutFile);
  // Last text wins, trimmed, with trailing newline
  assert.equal(out, "final answer\n");
});

test("extractFinalAssistantMessage: falls back to raw file contents when analysis text is empty", async (t) => {
  const root = await makeTmpDir(t);
  const stdoutFile = join(root, "stdout.jsonl");
  // No text events at all -> falls back to raw file contents
  await writeFile(stdoutFile, jsonl(stepFinish("stop")));
  const out = await extractFinalAssistantMessage(stdoutFile);
  assert.match(out, /step-finish/);
});

test("extractFinalAssistantMessage: missing file returns sentinel", async (t) => {
  const root = await makeTmpDir(t);
  // Reference a path that doesn't exist
  const out = await extractFinalAssistantMessage(join(root, "missing.jsonl"));
  assert.equal(out, "# (no stdout captured)\n");
});

// Touch mkdir so import is not unused if we add more tests later
void mkdir;
