import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeStdout, deriveStatus, type RunAnalysis } from "../../src/analysis.ts";
import { makeTmpDir } from "../helpers/tmp.ts";
import { jsonl, stepFinish, textEvent, toolEvent, rawSession } from "../helpers/jsonl.ts";

async function writeJsonl(t: Parameters<typeof makeTmpDir>[0], content: string): Promise<string> {
  const dir = await makeTmpDir(t);
  const p = join(dir, "stdout.jsonl");
  await writeFile(p, content);
  return p;
}

function emptyAnalysis(): RunAnalysis {
  return {
    stepCount: 0,
    finishReasons: [],
    lastFinishReason: null,
    contentFilterHit: false,
    firstContentFilterAt: null,
    toolCount: 0,
    toolBreakdown: {},
    toolSequence: [],
    assistantTextCount: 0,
    assistantTextBytes: 0,
    lastAssistantText: "",
    sessionId: null,
    toolLoopSuspected: false,
  };
}

/* ------------------------------ analyzeStdout ----------------------------- */

test("analyzeStdout: clean ok-style run", async (t) => {
  const p = await writeJsonl(
    t,
    jsonl(
      rawSession("ses_a"),
      stepFinish("tool-calls", { sessionID: "ses_a" }),
      toolEvent("read", "completed", { filePath: "README.md" }),
      stepFinish("stop"),
      textEvent("Final answer text " + "x".repeat(300)),
    ),
  );
  const a = await analyzeStdout(p);
  assert.equal(a.sessionId, "ses_a");
  assert.equal(a.stepCount, 2);
  assert.deepEqual(a.finishReasons, ["tool-calls", "stop"]);
  assert.equal(a.lastFinishReason, "stop");
  assert.equal(a.toolCount, 1);
  assert.deepEqual(a.toolBreakdown, { read: 1 });
  assert.equal(a.toolSequence.length, 1);
  assert.equal(a.toolSequence[0].tool, "read");
  assert.equal(a.toolSequence[0].summary, "README.md");
  assert.equal(a.assistantTextCount, 1);
  assert.ok(a.assistantTextBytes > 200);
  assert.match(a.lastAssistantText, /^Final answer text/);
  assert.equal(a.toolLoopSuspected, false);
  assert.equal(a.contentFilterHit, false);
});

test("analyzeStdout: tool-loop heuristic triggers at >=15 steps with no text", async (t) => {
  const lines: string[] = [];
  for (let i = 0; i < 16; i++) {
    lines.push(toolEvent("bash", "completed", { command: `cmd ${i}` }));
    lines.push(stepFinish("tool-calls"));
  }
  const p = await writeJsonl(t, jsonl(...lines));
  const a = await analyzeStdout(p);
  assert.equal(a.stepCount, 16);
  assert.equal(a.lastFinishReason, "tool-calls");
  assert.equal(a.assistantTextCount, 0);
  assert.equal(a.toolLoopSuspected, true);
});

test("analyzeStdout: tool-loop NOT triggered when assistant text >= 200 bytes", async (t) => {
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) lines.push(stepFinish("tool-calls"));
  lines.push(textEvent("z".repeat(300)));
  const p = await writeJsonl(t, jsonl(...lines));
  const a = await analyzeStdout(p);
  assert.equal(a.toolLoopSuspected, false);
});

test("analyzeStdout: content-filter event recorded with first-hit index", async (t) => {
  const p = await writeJsonl(
    t,
    jsonl(
      stepFinish("tool-calls"),
      stepFinish("content-filter"),
      stepFinish("content-filter"),
    ),
  );
  const a = await analyzeStdout(p);
  assert.equal(a.contentFilterHit, true);
  assert.equal(a.firstContentFilterAt, 1); // 0-based index of step 2
  assert.equal(a.stepCount, 3);
});

test("analyzeStdout: synthetic text events are excluded from counts", async (t) => {
  const p = await writeJsonl(
    t,
    jsonl(textEvent("real one"), textEvent("synthetic one", { synthetic: true })),
  );
  const a = await analyzeStdout(p);
  assert.equal(a.assistantTextCount, 1);
  assert.equal(a.lastAssistantText, "real one");
});

test("analyzeStdout: empty/whitespace text events are excluded", async (t) => {
  const p = await writeJsonl(t, jsonl(textEvent(""), textEvent("   \n  \t  ")));
  const a = await analyzeStdout(p);
  assert.equal(a.assistantTextCount, 0);
});

test("analyzeStdout: malformed JSON lines are skipped silently", async (t) => {
  const p = await writeJsonl(
    t,
    [
      "not json",
      stepFinish("stop"),
      "{still not} parseable",
      textEvent("ok"),
      "",
    ].join("\n") + "\n",
  );
  const a = await analyzeStdout(p);
  assert.equal(a.stepCount, 1);
  assert.equal(a.assistantTextCount, 1);
});

test("analyzeStdout: missing file returns empty analysis", async (t) => {
  const dir = await makeTmpDir(t);
  const a = await analyzeStdout(join(dir, "nope.jsonl"));
  assert.deepEqual(a, emptyAnalysis());
});

test("analyzeStdout: tool input summarization picks first known field", async (t) => {
  const p = await writeJsonl(
    t,
    jsonl(
      toolEvent("bash", "completed", { command: "ls -la" }),
      toolEvent("grep", "completed", { pattern: "TODO" }),
      toolEvent("webfetch", "completed", { url: "https://example.com" }),
      toolEvent("custom", "completed", { somethingElse: "value" }),
      toolEvent("noargs", "completed"),
    ),
  );
  const a = await analyzeStdout(p);
  assert.equal(a.toolSequence[0].summary, "ls -la");
  assert.equal(a.toolSequence[1].summary, "pattern=TODO");
  assert.equal(a.toolSequence[2].summary, "https://example.com");
  assert.equal(a.toolSequence[3].summary, "somethingElse=value");
  assert.equal(a.toolSequence[4].summary, undefined);
});

test("analyzeStdout: bash command summary is trimmed at 120 chars with ellipsis", async (t) => {
  const longCmd = "echo " + "a".repeat(200);
  const p = await writeJsonl(t, jsonl(toolEvent("bash", "completed", { command: longCmd })));
  const a = await analyzeStdout(p);
  assert.ok(a.toolSequence[0].summary!.endsWith("…"));
  assert.ok(a.toolSequence[0].summary!.length <= 121);
});

/* ------------------------------ deriveStatus ------------------------------ */

const okAnalysis = (): RunAnalysis => ({
  ...emptyAnalysis(),
  stepCount: 1,
  finishReasons: ["stop"],
  lastFinishReason: "stop",
  assistantTextCount: 1,
  assistantTextBytes: 500,
  lastAssistantText: "ok",
});

test("deriveStatus: spawnError wins over everything else", () => {
  const r = deriveStatus({
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: "ENOENT",
    analysis: okAnalysis(),
  });
  assert.equal(r.status, "spawn-error");
  assert.deepEqual(r.reasons, ["ENOENT"]);
});

test("deriveStatus: timeout overrides exit code", () => {
  const r = deriveStatus({
    exitCode: 0,
    signal: "SIGTERM",
    timedOut: true,
    spawnError: null,
    analysis: okAnalysis(),
  });
  assert.equal(r.status, "timeout");
  assert.match(r.reasons[0], /timed out/);
});

test("deriveStatus: content-filter detected from analysis", () => {
  const r = deriveStatus({
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    analysis: { ...okAnalysis(), contentFilterHit: true, firstContentFilterAt: 2, stepCount: 5 },
  });
  assert.equal(r.status, "content-filtered");
  assert.match(r.reasons[0], /content-filter at step 2 of 5/);
});

test("deriveStatus: tool-loop detected", () => {
  const r = deriveStatus({
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    analysis: {
      ...emptyAnalysis(),
      stepCount: 16,
      lastFinishReason: "tool-calls",
      toolLoopSuspected: true,
    },
  });
  assert.equal(r.status, "tool-loop");
});

test("deriveStatus: non-zero exit yields crashed", () => {
  const r = deriveStatus({
    exitCode: 1,
    signal: null,
    timedOut: false,
    spawnError: null,
    analysis: okAnalysis(),
  });
  assert.equal(r.status, "crashed");
  assert.match(r.reasons[0], /non-zero exit 1/);
});

test("deriveStatus: signal yields crashed when exit code is null", () => {
  const r = deriveStatus({
    exitCode: null,
    signal: "SIGKILL",
    timedOut: false,
    spawnError: null,
    analysis: okAnalysis(),
  });
  assert.equal(r.status, "crashed");
  assert.match(r.reasons[0], /killed by signal SIGKILL/);
});

test("deriveStatus: empty when no assistant text", () => {
  const r = deriveStatus({
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    analysis: { ...emptyAnalysis(), lastFinishReason: "stop", stepCount: 1 },
  });
  assert.equal(r.status, "empty");
});

test("deriveStatus: incomplete when last finish reason is not 'stop'", () => {
  const r = deriveStatus({
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    analysis: {
      ...emptyAnalysis(),
      lastFinishReason: "length",
      stepCount: 1,
      assistantTextCount: 1,
      assistantTextBytes: 1000,
      lastAssistantText: "x",
    },
  });
  assert.equal(r.status, "incomplete");
  assert.match(r.reasons[0], /last finish reason=length/);
});

test("deriveStatus: incomplete when assistant text is under 200 bytes", () => {
  const r = deriveStatus({
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    analysis: {
      ...emptyAnalysis(),
      lastFinishReason: "stop",
      stepCount: 1,
      assistantTextCount: 1,
      assistantTextBytes: 50,
      lastAssistantText: "tiny",
    },
  });
  assert.equal(r.status, "incomplete");
  assert.match(r.reasons[0], /only 50 bytes/);
});

test("deriveStatus: ok happy path", () => {
  const r = deriveStatus({
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    analysis: okAnalysis(),
  });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.reasons, []);
});
