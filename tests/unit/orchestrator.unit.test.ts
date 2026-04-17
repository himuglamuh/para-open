import { test } from "node:test";
import assert from "node:assert/strict";
import { __shellQuote, __printSummaryTable, type ModelRunSummary } from "../../src/orchestrator.ts";

test("shellQuote: simple safe identifiers pass through", () => {
  assert.equal(__shellQuote("foo"), "foo");
  assert.equal(__shellQuote("FOO_bar-1.2"), "FOO_bar-1.2");
  assert.equal(__shellQuote("path/to/file"), "path/to/file");
  assert.equal(__shellQuote("KEY=value"), "KEY=value");
});

test("shellQuote: spaces force single-quoted form", () => {
  assert.equal(__shellQuote("hello world"), "'hello world'");
});

test("shellQuote: empty string is single-quoted", () => {
  assert.equal(__shellQuote(""), "''");
});

test("shellQuote: embedded single quotes use the '\\'' escape", () => {
  assert.equal(__shellQuote("don't"), "'don'\\''t'");
});

test("shellQuote: special shell chars are quoted", () => {
  assert.equal(__shellQuote("$VAR; rm -rf /"), "'$VAR; rm -rf /'");
});

/* ----------------------------- printSummaryTable -------------------------- */

function mkSummary(overrides: Partial<ModelRunSummary> = {}): ModelRunSummary {
  return {
    label: "alpha",
    modelId: "v/m",
    durationMs: 0,
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    changes: { created: 0, modified: 0, deleted: 0 },
    stdoutFile: "",
    stderrFile: "",
    finalFile: "",
    metaFile: "",
    changesFile: "",
    workspace: "",
    modelDir: "",
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
      assistantTextBytes: 100,
      lastAssistantText: "x",
      sessionId: null,
      toolLoopSuspected: false,
    },
    ...overrides,
  };
}

test("printSummaryTable: writes header, separator, and one line per summary to injected sink", () => {
  const buf: string[] = [];
  const sink = { write: (s: string) => void buf.push(s) };
  __printSummaryTable(
    [
      mkSummary({ label: "alpha", status: "ok", durationMs: 1500 }),
      mkSummary({ label: "beta", status: "tool-loop", durationMs: 60_000, analysis: null }),
    ],
    sink,
  );
  const out = buf.join("");
  // Header row contains all column names
  for (const col of ["label", "model", "duration", "status", "steps", "tools", "texts", "created", "modified", "deleted"]) {
    assert.match(out, new RegExp(col));
  }
  // Separator line of dashes
  assert.match(out, /-{3,}/);
  // Both labels present
  assert.match(out, /alpha/);
  assert.match(out, /beta/);
  // Status values present
  assert.match(out, /\bok\b/);
  assert.match(out, /tool-loop/);
});

