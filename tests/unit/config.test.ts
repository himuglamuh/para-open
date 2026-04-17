import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { makeTmpDir } from "../helpers/tmp.ts";

async function writeConfig(t: Parameters<typeof makeTmpDir>[0], obj: unknown): Promise<string> {
  const dir = await makeTmpDir(t);
  const p = join(dir, "models.json");
  await writeFile(p, typeof obj === "string" ? obj : JSON.stringify(obj));
  return p;
}

test("loadConfig: minimal valid config with a single model", async (t) => {
  const p = await writeConfig(t, { models: [{ id: "anthropic/claude-3", label: "claude" }] });
  const cfg = await loadConfig(p);
  assert.deepEqual(cfg.models, [{ id: "anthropic/claude-3", label: "claude" }]);
  // default synthesizer
  assert.equal(cfg.synthesizer, "github-copilot/claude-opus-4.7");
});

test("loadConfig: respects explicit synthesizer", async (t) => {
  const p = await writeConfig(t, {
    synthesizer: "openai/gpt-5",
    models: [{ id: "x", label: "x" }],
  });
  const cfg = await loadConfig(p);
  assert.equal(cfg.synthesizer, "openai/gpt-5");
});

test("loadConfig: errors when models is missing", async (t) => {
  const p = await writeConfig(t, { synthesizer: "x" });
  await assert.rejects(() => loadConfig(p), /non-empty "models" array/);
});

test("loadConfig: errors when models is empty", async (t) => {
  const p = await writeConfig(t, { models: [] });
  await assert.rejects(() => loadConfig(p), /non-empty "models" array/);
});

test("loadConfig: errors when file is missing", async (t) => {
  const dir = await makeTmpDir(t);
  await assert.rejects(() => loadConfig(join(dir, "does-not-exist.json")), /Failed to read models config/);
});

test("loadConfig: errors when model id is missing", async (t) => {
  const p = await writeConfig(t, { models: [{ label: "no-id" }] });
  await assert.rejects(() => loadConfig(p), /missing a string "id"/);
});

test("loadConfig: derives label from id via slugify when omitted", async (t) => {
  const p = await writeConfig(t, { models: [{ id: "github-copilot/Claude Opus 4.7" }] });
  const cfg = await loadConfig(p);
  assert.equal(cfg.models[0].label, "github-copilot-claude-opus-4-7");
});

test("loadConfig: deduplicates duplicate labels with -2, -3 suffixes", async (t) => {
  const p = await writeConfig(t, {
    models: [
      { id: "a", label: "dup" },
      { id: "b", label: "dup" },
      { id: "c", label: "dup" },
    ],
  });
  const cfg = await loadConfig(p);
  assert.deepEqual(
    cfg.models.map((m) => m.label),
    ["dup", "dup-2", "dup-3"],
  );
});

test("loadConfig: accepts a string model entry (id-only)", async (t) => {
  const p = await writeConfig(t, { models: ["openai/gpt-4o-mini"] });
  const cfg = await loadConfig(p);
  assert.equal(cfg.models[0].id, "openai/gpt-4o-mini");
  assert.equal(cfg.models[0].label, "openai-gpt-4o-mini");
});

test("loadConfig: model with id that slugifies to empty falls back to model-N", async (t) => {
  const p = await writeConfig(t, { models: [{ id: "!!!", label: "" }] });
  const cfg = await loadConfig(p);
  assert.equal(cfg.models[0].label, "model-0");
});

test("loadConfig: invalid JSON surfaces as Failed to read", async (t) => {
  const p = await writeConfig(t, "{not valid json");
  await assert.rejects(() => loadConfig(p), /Failed to read models config/);
});

test("loadConfig: works against the real models.example.json fixture", async () => {
  const cfg = await loadConfig(new URL("../../models.example.json", import.meta.url).pathname);
  assert.ok(cfg.models.length > 0);
  for (const m of cfg.models) {
    assert.ok(m.id);
    assert.ok(m.label);
  }
});
