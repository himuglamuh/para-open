import { test } from "node:test";
import assert from "node:assert/strict";
import {
  globToRegExp,
  matchGlobs,
  parseOpencodeModelsOutput,
  resolvePreset,
  pickSynthesizerDefault,
  buildModelsConfig,
  applySelector,
  parseInitModelsArgs,
} from "../../src/init-models.ts";

// --- globToRegExp ----------------------------------------------------------

test("globToRegExp: matches plain string exactly", () => {
  const re = globToRegExp("anthropic/claude");
  assert.equal(re.test("anthropic/claude"), true);
  assert.equal(re.test("anthropic/claude-3"), false);
  assert.equal(re.test("xanthropic/claude"), false);
});

test("globToRegExp: * is greedy any-string wildcard", () => {
  const re = globToRegExp("*sonnet*");
  assert.equal(re.test("anthropic/claude-sonnet-4.5"), true);
  assert.equal(re.test("openai/gpt-5"), false);
});

test("globToRegExp: ? matches a single character", () => {
  const re = globToRegExp("gpt-?");
  assert.equal(re.test("gpt-5"), true);
  assert.equal(re.test("gpt-55"), false);
});

test("globToRegExp: regex meta chars are escaped", () => {
  const re = globToRegExp("a.b+c");
  assert.equal(re.test("a.b+c"), true);
  assert.equal(re.test("axbxc"), false);
});

// --- matchGlobs ------------------------------------------------------------

test("matchGlobs: empty pattern list yields empty result", () => {
  assert.deepEqual(matchGlobs([], ["a", "b"]), []);
});

test("matchGlobs: union of all matching patterns", () => {
  const ids = ["anthropic/claude-opus-4.7", "openai/gpt-5", "openai/gpt-4o"];
  assert.deepEqual(matchGlobs(["*opus*", "*gpt-5*"], ids), [
    "anthropic/claude-opus-4.7",
    "openai/gpt-5",
  ]);
});

// --- parseOpencodeModelsOutput --------------------------------------------

test("parseOpencodeModelsOutput: trims and filters blank lines", () => {
  const text = "  anthropic/claude\n\nopenai/gpt-5\n   \n";
  assert.deepEqual(parseOpencodeModelsOutput(text), ["anthropic/claude", "openai/gpt-5"]);
});

test("parseOpencodeModelsOutput: requires a slash and rejects JSON-looking lines", () => {
  const text = "anthropic/claude\nplain-noslash\n{\"id\":\"x\"}\nopenai/gpt-5\n";
  assert.deepEqual(parseOpencodeModelsOutput(text), ["anthropic/claude", "openai/gpt-5"]);
});

// --- resolvePreset --------------------------------------------------------

test("resolvePreset frontier: picks one per family in priority order", () => {
  const ids = [
    "anthropic/claude-opus-4.7",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5",
    "google/gemini-2.5-pro",
    "openai/gpt-4o-mini",
  ];
  const got = resolvePreset("frontier", ids);
  assert.deepEqual(got, [
    "anthropic/claude-opus-4.7",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5",
    "google/gemini-2.5-pro",
  ]);
});

test("resolvePreset cheap: picks small/fast models", () => {
  const ids = [
    "anthropic/claude-haiku-4",
    "openai/gpt-5-mini",
    "google/gemini-2.5-flash",
    "anthropic/claude-opus-4.7",
  ];
  const got = resolvePreset("cheap", ids);
  assert.deepEqual(got, [
    "anthropic/claude-haiku-4",
    "openai/gpt-5-mini",
    "google/gemini-2.5-flash",
  ]);
});

test("resolvePreset claude-vs-gpt: picks one Claude and one GPT", () => {
  const ids = [
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5",
    "google/gemini-2.5-pro",
  ];
  const got = resolvePreset("claude-vs-gpt", ids);
  assert.deepEqual(got, ["anthropic/claude-sonnet-4.5", "openai/gpt-5"]);
});

test("resolvePreset: unknown name throws", () => {
  assert.throws(() => resolvePreset("nope", ["a/b"]), /unknown preset/);
});

test("resolvePreset: returns empty array when nothing matches", () => {
  assert.deepEqual(resolvePreset("frontier", ["foo/bar-baz"]), []);
});

// --- pickSynthesizerDefault -----------------------------------------------

test("pickSynthesizerDefault: prefers opus-4.7 over everything", () => {
  const got = pickSynthesizerDefault([
    "openai/gpt-5",
    "anthropic/claude-sonnet-4.5",
    "github-copilot/claude-opus-4.7",
  ]);
  assert.equal(got, "github-copilot/claude-opus-4.7");
});

test("pickSynthesizerDefault: falls back to sonnet when no opus", () => {
  const got = pickSynthesizerDefault(["openai/gpt-4o", "anthropic/claude-sonnet-4.6"]);
  assert.equal(got, "anthropic/claude-sonnet-4.6");
});

test("pickSynthesizerDefault: prefers gpt-5 over arbitrary model", () => {
  const got = pickSynthesizerDefault(["foo/bar", "openai/gpt-5"]);
  assert.equal(got, "openai/gpt-5");
});

test("pickSynthesizerDefault: returns first model if no preferences match", () => {
  const got = pickSynthesizerDefault(["foo/bar", "baz/quux"]);
  assert.equal(got, "foo/bar");
});

test("pickSynthesizerDefault: throws on empty input", () => {
  assert.throws(() => pickSynthesizerDefault([]), /no models/);
});

// --- buildModelsConfig ----------------------------------------------------

test("buildModelsConfig: produces the expected schema", () => {
  const got = buildModelsConfig(["anthropic/claude", "openai/gpt-5"], "openai/gpt-5");
  assert.deepEqual(got, {
    synthesizer: "openai/gpt-5",
    models: [{ id: "anthropic/claude" }, { id: "openai/gpt-5" }],
  });
});

// --- applySelector --------------------------------------------------------

const AVAIL = [
  "anthropic/claude-opus-4.7",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-5",
  "openai/gpt-4o",
];

test("applySelector all: returns full list copy", () => {
  const got = applySelector({ kind: "all" }, AVAIL);
  assert.deepEqual(got, AVAIL);
  assert.notEqual(got, AVAIL); // copy, not same ref
});

test("applySelector provider: filters by prefix (with or without trailing slash)", () => {
  assert.deepEqual(applySelector({ kind: "provider", id: "anthropic" }, AVAIL), [
    "anthropic/claude-opus-4.7",
    "anthropic/claude-sonnet-4.5",
  ]);
  assert.deepEqual(applySelector({ kind: "provider", id: "openai/" }, AVAIL), [
    "openai/gpt-5",
    "openai/gpt-4o",
  ]);
});

test("applySelector filter: glob-matches", () => {
  assert.deepEqual(applySelector({ kind: "filter", patterns: ["*opus*", "*gpt-5*"] }, AVAIL), [
    "anthropic/claude-opus-4.7",
    "openai/gpt-5",
  ]);
});

test("applySelector preset: delegates to resolvePreset", () => {
  const got = applySelector({ kind: "preset", name: "claude-vs-gpt" }, AVAIL);
  assert.deepEqual(got, ["anthropic/claude-sonnet-4.5", "openai/gpt-5"]);
});

test("applySelector interactive: throws (caller must handle)", () => {
  assert.throws(() => applySelector({ kind: "interactive" }, AVAIL), /interactive/);
});

// --- parseInitModelsArgs --------------------------------------------------

test("parseInitModelsArgs: empty argv defaults to interactive selector", () => {
  const got = parseInitModelsArgs([]);
  assert.equal(got.selector.kind, "interactive");
  assert.equal(got.explicitInteractive, false);
  assert.equal(got.synth, null);
  assert.equal(got.out, "./models.json");
  assert.equal(got.force, false);
  assert.equal(got.stdout, false);
});

test("parseInitModelsArgs: --interactive marks explicit", () => {
  const got = parseInitModelsArgs(["--interactive"]);
  assert.equal(got.selector.kind, "interactive");
  assert.equal(got.explicitInteractive, true);
});

test("parseInitModelsArgs: --all", () => {
  const got = parseInitModelsArgs(["--all"]);
  assert.deepEqual(got.selector, { kind: "all" });
});

test("parseInitModelsArgs: --provider with value", () => {
  const got = parseInitModelsArgs(["--provider", "anthropic"]);
  assert.deepEqual(got.selector, { kind: "provider", id: "anthropic" });
});

test("parseInitModelsArgs: --filter accepts repeated values", () => {
  const got = parseInitModelsArgs(["--filter", "*opus*", "*gpt-5*", "--force"]);
  assert.deepEqual(got.selector, { kind: "filter", patterns: ["*opus*", "*gpt-5*"] });
  assert.equal(got.force, true);
});

test("parseInitModelsArgs: multiple --filter flags concatenate", () => {
  const got = parseInitModelsArgs(["--filter", "*opus*", "--filter", "*gpt*"]);
  assert.deepEqual(got.selector, { kind: "filter", patterns: ["*opus*", "*gpt*"] });
});

test("parseInitModelsArgs: --preset", () => {
  const got = parseInitModelsArgs(["--preset", "frontier"]);
  assert.deepEqual(got.selector, { kind: "preset", name: "frontier" });
});

test("parseInitModelsArgs: --synth, --out, --stdout", () => {
  const got = parseInitModelsArgs([
    "--all",
    "--synth",
    "openai/gpt-5",
    "--out",
    "./custom.json",
    "--stdout",
  ]);
  assert.equal(got.synth, "openai/gpt-5");
  assert.equal(got.out, "./custom.json");
  assert.equal(got.stdout, true);
});

test("parseInitModelsArgs: combining selectors throws", () => {
  assert.throws(() => parseInitModelsArgs(["--all", "--preset", "frontier"]), /cannot combine/);
});

test("parseInitModelsArgs: unknown flag throws", () => {
  assert.throws(() => parseInitModelsArgs(["--bogus"]), /unknown init-models flag/);
});

test("parseInitModelsArgs: --provider without value throws", () => {
  assert.throws(() => parseInitModelsArgs(["--provider"]), /requires a value/);
});

test("parseInitModelsArgs: --filter without value throws", () => {
  assert.throws(() => parseInitModelsArgs(["--filter"]), /requires/);
});
