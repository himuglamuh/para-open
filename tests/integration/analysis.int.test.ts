import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { analyzeStdout } from "../../src/analysis.ts";
import { makeTmpDir } from "../helpers/tmp.ts";
import { jsonl, stepFinish, textEvent, toolEvent } from "../helpers/jsonl.ts";

test("analyzeStdout: handles a multi-MB realistic JSONL stream end-to-end", async (t) => {
  const dir = await makeTmpDir(t);
  const p = join(dir, "stdout.jsonl");

  const lines: string[] = [];
  // 50 step/tool pairs
  for (let i = 0; i < 50; i++) {
    lines.push(toolEvent("read", "completed", { filePath: `f${i}.ts` }));
    lines.push(stepFinish("tool-calls"));
  }
  // big text payload (~1MB)
  const bigText = "ANSWER " + "x".repeat(1024 * 1024);
  lines.push(textEvent(bigText));
  lines.push(stepFinish("stop"));
  await writeFile(p, jsonl(...lines));

  const a = await analyzeStdout(p);
  assert.equal(a.stepCount, 51);
  assert.equal(a.toolCount, 50);
  assert.equal(a.assistantTextCount, 1);
  assert.ok(a.assistantTextBytes > 1_000_000);
  assert.equal(a.lastFinishReason, "stop");
});

test("analyzeStdout: tail-reads when file exceeds 50MB cap, dropping early events", async (t) => {
  const dir = await makeTmpDir(t);
  const p = join(dir, "huge.jsonl");
  // Write a 51MB file: a bunch of garbage filler, then valid trailing events.
  // We use fs.open + sparse padding to avoid actually allocating gigabytes.
  const fh = await open(p, "w");
  try {
    // Write 50MB of "junk\n" repeated. Use 1MB chunks.
    const chunkSize = 1 * 1024 * 1024;
    const filler = Buffer.alloc(chunkSize, "z".charCodeAt(0));
    // Start each 1MB chunk on a newline so the filler doesn't accidentally form
    // a too-large single line; the analyzer drops the first (partial) line of
    // tail anyway.
    for (let i = 0; i < 51; i++) {
      // Add a newline at start of each chunk to keep lines bounded
      await fh.write(Buffer.concat([Buffer.from("\n"), filler.slice(0, chunkSize - 1)]));
    }
    // Tail: real events that should be detected.
    const tail =
      "\n" +
      jsonl(
        toolEvent("read", "completed", { filePath: "tail.ts" }),
        stepFinish("stop"),
        textEvent("Tail answer payload " + "y".repeat(500)),
      );
    await fh.write(Buffer.from(tail));
  } finally {
    await fh.close();
  }

  const a = await analyzeStdout(p);
  // The early junk events are dropped, but the tail events are picked up.
  assert.ok(a.stepCount >= 1, "expected at least the tail step-finish");
  assert.equal(a.lastFinishReason, "stop");
  assert.equal(a.toolCount, 1);
  assert.ok(a.lastAssistantText.startsWith("Tail answer payload "));
});
