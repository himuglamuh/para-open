import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../../src/index.ts";

test("parseCliArgs: positional prompt", () => {
  const r = parseCliArgs(["hello", "world"]);
  assert.deepEqual(r.positionals, ["hello", "world"]);
  assert.equal(r.values["prompt-file"], undefined);
});

test("parseCliArgs: --prompt-file string option", () => {
  const r = parseCliArgs(["--prompt-file", "/tmp/p.md"]);
  assert.equal(r.values["prompt-file"], "/tmp/p.md");
});

test("parseCliArgs: boolean --no-source / --no-synth / --dry-run / --fresh", () => {
  const r = parseCliArgs(["--no-source", "--no-synth", "--dry-run", "--fresh"]);
  assert.equal(r.values["no-source"], true);
  assert.equal(r.values["no-synth"], true);
  assert.equal(r.values["dry-run"], true);
  assert.equal(r.values.fresh, true);
});

test("parseCliArgs: numeric-style options stay as strings", () => {
  // parseArgs returns raw strings; numeric parsing happens inside main().
  const r = parseCliArgs(["--timeout", "120", "--concurrency", "3", "--synth-timeout", "600", "--ask-timeout", "90"]);
  assert.equal(r.values.timeout, "120");
  assert.equal(r.values.concurrency, "3");
  assert.equal(r.values["synth-timeout"], "600");
  assert.equal(r.values["ask-timeout"], "90");
});

test("parseCliArgs: short flags -h and -v", () => {
  assert.equal(parseCliArgs(["-h"]).values.help, true);
  assert.equal(parseCliArgs(["-v"]).values.version, true);
});

test("parseCliArgs: synth subcommand positional", () => {
  const r = parseCliArgs(["synth", "/path/to/run"]);
  assert.deepEqual(r.positionals, ["synth", "/path/to/run"]);
});

test("parseCliArgs: ask subcommand with question positionals", () => {
  const r = parseCliArgs(["ask", "/run/dir", "what", "happened"]);
  assert.deepEqual(r.positionals, ["ask", "/run/dir", "what", "happened"]);
});

test("parseCliArgs: --models, --out, --source-dir, --synth-model strings", () => {
  const r = parseCliArgs([
    "--models", "./m.json",
    "--out", "./out",
    "--source-dir", "./src",
    "--synth-model", "openai/gpt-5",
    "prompt",
  ]);
  assert.equal(r.values.models, "./m.json");
  assert.equal(r.values.out, "./out");
  assert.equal(r.values["source-dir"], "./src");
  assert.equal(r.values["synth-model"], "openai/gpt-5");
  assert.deepEqual(r.positionals, ["prompt"]);
});

test("parseCliArgs: ask --question-file", () => {
  const r = parseCliArgs(["ask", "/d", "--question-file", "/q.md"]);
  assert.equal(r.values["question-file"], "/q.md");
});
