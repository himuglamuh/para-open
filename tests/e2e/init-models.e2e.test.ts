import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, readFile, access } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFakeBinDir } from "../helpers/fakeOpencode.ts";
import { makeTmpDir } from "../helpers/tmp.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(HERE, "..", "..", "src", "index.ts");

interface RunCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
  timeoutMs = 30_000,
): Promise<RunCliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, ...args],
      {
        env,
        cwd: cwd ?? resolve(HERE, "..", ".."),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (b) => stdout.push(b));
    child.stderr.on("data", (b) => stderr.push(b));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectPromise(e);
    });
  });
}

const FAKE_LIST = [
  "anthropic/claude-opus-4.7",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-5",
  "openai/gpt-4o-mini",
  "google/gemini-2.5-pro",
].join("\n");

test("init-models: --provider writes filtered models.json", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  const tmp = await makeTmpDir(t);
  const out = join(tmp, "models.json");

  const r = await runCli(
    ["init-models", "--provider", "anthropic", "--out", out],
    { ...process.env, PATH: pathEnv, PARAOPEN_FAKE_MODELS_LIST: FAKE_LIST },
  );

  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  const written = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual(written.models, [
    { id: "anthropic/claude-opus-4.7" },
    { id: "anthropic/claude-sonnet-4.5" },
  ]);
  // Auto-picked synthesizer should be opus-4.7
  assert.equal(written.synthesizer, "anthropic/claude-opus-4.7");
});

test("init-models: --filter with multiple globs", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  const tmp = await makeTmpDir(t);
  const out = join(tmp, "models.json");

  const r = await runCli(
    ["init-models", "--filter", "*opus*", "*gpt-5*", "--out", out],
    { ...process.env, PATH: pathEnv, PARAOPEN_FAKE_MODELS_LIST: FAKE_LIST },
  );

  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  const written = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual(
    written.models.map((m: { id: string }) => m.id),
    ["anthropic/claude-opus-4.7", "openai/gpt-5"],
  );
});

test("init-models: --preset frontier", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  const tmp = await makeTmpDir(t);
  const out = join(tmp, "models.json");

  const r = await runCli(
    ["init-models", "--preset", "frontier", "--out", out],
    { ...process.env, PATH: pathEnv, PARAOPEN_FAKE_MODELS_LIST: FAKE_LIST },
  );

  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  const written = JSON.parse(await readFile(out, "utf8"));
  const ids = written.models.map((m: { id: string }) => m.id);
  assert.ok(ids.includes("anthropic/claude-opus-4.7"));
  assert.ok(ids.includes("anthropic/claude-sonnet-4.5"));
  assert.ok(ids.includes("openai/gpt-5"));
  assert.ok(ids.includes("google/gemini-2.5-pro"));
});

test("init-models: --stdout prints JSON without writing a file", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  const tmp = await makeTmpDir(t);
  const out = join(tmp, "models.json");

  const r = await runCli(
    ["init-models", "--all", "--stdout", "--out", out],
    { ...process.env, PATH: pathEnv, PARAOPEN_FAKE_MODELS_LIST: FAKE_LIST },
  );

  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.models.length, 5);
  // File was NOT written
  await assert.rejects(() => access(out));
});

test("init-models: refuses to overwrite without --force", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  const tmp = await makeTmpDir(t);
  const out = join(tmp, "models.json");
  await writeFile(out, '{"existing":true}');

  const r = await runCli(
    ["init-models", "--all", "--out", out],
    { ...process.env, PATH: pathEnv, PARAOPEN_FAKE_MODELS_LIST: FAKE_LIST },
  );

  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /already exists/);
  // File preserved
  const preserved = JSON.parse(await readFile(out, "utf8"));
  assert.equal(preserved.existing, true);
});

test("init-models: --force overwrites existing file", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  const tmp = await makeTmpDir(t);
  const out = join(tmp, "models.json");
  await writeFile(out, '{"existing":true}');

  const r = await runCli(
    ["init-models", "--all", "--force", "--out", out],
    { ...process.env, PATH: pathEnv, PARAOPEN_FAKE_MODELS_LIST: FAKE_LIST },
  );

  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  const written = JSON.parse(await readFile(out, "utf8"));
  assert.equal(written.models.length, 5);
  assert.equal(written.existing, undefined);
});

test("init-models: empty selection exits non-zero with helpful message", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  const tmp = await makeTmpDir(t);
  const out = join(tmp, "models.json");

  const r = await runCli(
    ["init-models", "--provider", "nonexistent", "--out", out],
    { ...process.env, PATH: pathEnv, PARAOPEN_FAKE_MODELS_LIST: FAKE_LIST },
  );

  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /matched no authenticated models/);
});

test("init-models: --synth overrides auto-pick", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  const tmp = await makeTmpDir(t);
  const out = join(tmp, "models.json");

  const r = await runCli(
    ["init-models", "--all", "--synth", "openai/gpt-5", "--out", out],
    { ...process.env, PATH: pathEnv, PARAOPEN_FAKE_MODELS_LIST: FAKE_LIST },
  );

  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  const written = JSON.parse(await readFile(out, "utf8"));
  assert.equal(written.synthesizer, "openai/gpt-5");
});

test("init-models: invalid flag combination exits 2", async (t) => {
  void t;
  const r = await runCli(["init-models", "--all", "--preset", "frontier"], {
    ...process.env,
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /cannot combine/);
});
