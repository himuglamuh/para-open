import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFinalMarkdown, buildStatusHeader, type RunResult } from "../../src/runner.ts";
import type { RunAnalysis, DerivedStatus } from "../../src/analysis.ts";

function mkAnalysis(overrides: Partial<RunAnalysis> = {}): RunAnalysis {
  return {
    stepCount: 1,
    finishReasons: ["stop"],
    lastFinishReason: "stop",
    contentFilterHit: false,
    firstContentFilterAt: null,
    toolCount: 0,
    toolBreakdown: {},
    toolSequence: [],
    assistantTextCount: 1,
    assistantTextBytes: 100,
    lastAssistantText: "Hello world",
    sessionId: null,
    toolLoopSuspected: false,
    ...overrides,
  };
}

function mkResult(
  status: DerivedStatus,
  overrides: Partial<RunResult> = {},
  analysis = mkAnalysis(),
): RunResult {
  return {
    label: "lbl",
    modelId: "vendor/model",
    startedAt: "",
    endedAt: "",
    durationMs: 0,
    exitCode: status === "ok" ? 0 : 1,
    signal: null,
    timedOut: false,
    spawnError: null,
    stdoutFile: "",
    stderrFile: "",
    metaFile: "",
    finalFile: "",
    argv: [],
    status,
    statusReasons: [],
    analysis,
    ...overrides,
  };
}

test("buildFinalMarkdown: ok status returns no header, just trimmed text + newline", () => {
  const out = buildFinalMarkdown(
    mkResult("ok", {}, mkAnalysis({ lastAssistantText: "  Hello\n" })),
  );
  assert.equal(out, "Hello\n");
});

test("buildFinalMarkdown: ok status with empty text shows the no-substantive notice", () => {
  const out = buildFinalMarkdown(
    mkResult("ok", {}, mkAnalysis({ lastAssistantText: "  " })),
  );
  assert.match(out, /no substantive assistant text was produced/);
});

test("buildFinalMarkdown: non-ok status emits a status comment and warning blockquote", () => {
  const out = buildFinalMarkdown(
    mkResult(
      "tool-loop",
      { statusReasons: ["16 steps, last reason=tool-calls, 0 bytes"] },
      mkAnalysis({
        stepCount: 16,
        lastFinishReason: "tool-calls",
        toolBreakdown: { bash: 16 },
        assistantTextCount: 0,
        assistantTextBytes: 0,
        lastAssistantText: "",
      }),
    ),
  );
  assert.match(out, /<!-- PARA-OPEN STATUS: tool-loop -->/);
  assert.match(out, /Run status: `tool-loop`/);
  assert.match(out, /16 steps, last reason=tool-calls/);
  assert.match(out, /stepCount=16/);
  assert.match(out, /tools used: bash×16/);
  assert.match(out, /no substantive assistant text was produced/);
});

test("buildStatusHeader: ok returns empty string", () => {
  assert.equal(buildStatusHeader(mkResult("ok")), "");
});

test("buildStatusHeader: includes 'tools used: none' when no tools recorded", () => {
  const h = buildStatusHeader(mkResult("crashed"));
  assert.match(h, /tools used: none/);
});

test("buildStatusHeader: prints lastFinishReason or 'none' when null", () => {
  const h = buildStatusHeader(
    mkResult("empty", {}, mkAnalysis({ lastFinishReason: null, assistantTextCount: 0 })),
  );
  assert.match(h, /lastFinishReason=none/);
});

test("buildStatusHeader: every status produces a comment + blockquote header", () => {
  for (const s of ["content-filtered", "timeout", "spawn-error", "crashed", "empty", "tool-loop", "incomplete"] as DerivedStatus[]) {
    const h = buildStatusHeader(mkResult(s));
    assert.match(h, new RegExp(`PARA-OPEN STATUS: ${s}`));
    assert.match(h, new RegExp(`Run status: \`${s}\``));
  }
});
