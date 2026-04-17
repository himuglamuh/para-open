import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFakeBinDir } from "../helpers/fakeOpencode.ts";
import { makeTmpDir } from "../helpers/tmp.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(HERE, "..", "..", "src", "index.ts");

interface RunCliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd?: string, timeoutMs = 30_000): Promise<RunCliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, ...args],
      {
        env,
        // Inherit project cwd by default so tsx (a devDep) is resolvable.
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
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        signal,
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

test("CLI: --help prints usage and exits 0", async (t) => {
  void t;
  const r = await runCli(["--help"], { ...process.env });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /para-open - run one prompt across many opencode models/);
});

test("CLI: --version prints a semver and exits 0", async (t) => {
  void t;
  const r = await runCli(["--version"], { ...process.env });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test("CLI: missing prompt and no positional fails with usage", async (t) => {
  void t;
  const r = await runCli([], { ...process.env });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /provide a prompt/);
});

test("CLI: full happy-path run with fake binary writes report.md and exits 0", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  const tmp = await makeTmpDir(t);
  const modelsPath = join(tmp, "models.json");
  await writeFile(modelsPath, JSON.stringify({
    synthesizer: "fake/synth",
    models: [{ id: "vendor/alpha", label: "alpha" }],
  }));
  const outRoot = join(tmp, "runs");

  // The fake binary uses one global mode; we set it to "ok" for the model run
  // and rely on the same mode for synthesis (which won't write report.md, so
  // the fallback path is used). To exercise the synth-writes-report path, we
  // would need per-invocation modes. For end-to-end CLI smoke, ok+fallback
  // is enough to assert exit codes and outputs.
  const env = {
    ...process.env,
    PATH: pathEnv,
    PARAOPEN_FAKE_MODE: "ok",
  };

  const r = await runCli([
    "--no-source",
    "--models", modelsPath,
    "--out", outRoot,
    "--timeout", "30",
    "--synth-timeout", "30",
    "what is 2+2?",
  ], env);

  assert.equal(r.exitCode, 0, `expected exit 0; stderr:\n${r.stderr}`);

  // A run dir was created under outRoot
  const runs = await readdir(outRoot);
  assert.equal(runs.length, 1);
  const runDir = join(outRoot, runs[0]);
  // index.json present
  const idx = JSON.parse(await readFile(join(runDir, "index.json"), "utf8"));
  assert.equal(idx.models.length, 1);
  assert.equal(idx.models[0].status, "ok");
  // report.md present (either from synth or fallback)
  const report = await readFile(join(runDir, "report.md"), "utf8");
  assert.ok(report.length > 0);
});

test("CLI: --no-synth skips the synth step and exits 0 when models ok", async (t) => {
  const { pathEnv } = await makeFakeBinDir(t);
  const tmp = await makeTmpDir(t);
  const modelsPath = join(tmp, "models.json");
  await writeFile(modelsPath, JSON.stringify({
    models: [{ id: "vendor/alpha", label: "alpha" }],
  }));
  const outRoot = join(tmp, "runs");
  const env = { ...process.env, PATH: pathEnv, PARAOPEN_FAKE_MODE: "ok" };

  const r = await runCli([
    "--no-source", "--no-synth",
    "--models", modelsPath,
    "--out", outRoot,
    "--timeout", "30",
    "ping",
  ], env);

  assert.equal(r.exitCode, 0);
  const runs = await readdir(outRoot);
  // No report.md should exist
  await assert.rejects(readFile(join(outRoot, runs[0], "report.md"), "utf8"));
});

test("CLI: --dry-run prints planned argv and creates no stdout.jsonl", async (t) => {
  const tmp = await makeTmpDir(t);
  const modelsPath = join(tmp, "models.json");
  await writeFile(modelsPath, JSON.stringify({
    models: [{ id: "vendor/alpha", label: "alpha" }],
  }));
  const outRoot = join(tmp, "runs");

  const r = await runCli([
    "--no-source", "--dry-run",
    "--models", modelsPath,
    "--out", outRoot,
    "ping",
  ], { ...process.env });

  assert.equal(r.exitCode, 0);
  const runs = await readdir(outRoot);
  await assert.rejects(readFile(join(outRoot, runs[0], "alpha", "stdout.jsonl"), "utf8"));
});

test("CLI: invalid --timeout fails fast with exit 2", async (t) => {
  void t;
  const r = await runCli(["--timeout", "abc", "p"], { ...process.env });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /--timeout must be a positive integer/);
});

test("CLI: 'ask' subcommand requires a run-root", async (t) => {
  void t;
  const r = await runCli(["ask"], { ...process.env });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /'ask' requires a run-root path/);
});

test("CLI: 'synth' subcommand requires a run-root", async (t) => {
  void t;
  const r = await runCli(["synth"], { ...process.env });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /'synth' requires a run-root path/);
});
