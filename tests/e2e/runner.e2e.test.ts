import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runOpencode, __resetForTests, type RunSpec } from "../../src/runner.ts";
import { fakeBinaryPath } from "../helpers/fakeOpencode.ts";
import { makeTmpDir } from "../helpers/tmp.ts";

async function makeSpec(t: Parameters<typeof makeTmpDir>[0], timeoutMs = 30_000): Promise<RunSpec> {
  const root = await makeTmpDir(t);
  const modelDir = join(root, "alpha");
  const workspace = join(modelDir, "workspace");
  await mkdir(workspace, { recursive: true });
  return {
    label: "alpha",
    modelId: "vendor/alpha",
    prompt: "do the thing",
    workspace,
    modelDir,
    timeoutMs,
  };
}

function withMode(mode: string, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv } {
  // Note: runner.ts forwards process.env to the spawned child. We mutate
  // process.env temporarily; restore after the test.
  return { env: { ...process.env, PARAOPEN_FAKE_MODE: mode, ...extra } };
}

function withEnv(t: Parameters<typeof makeTmpDir>[0], env: Record<string, string>): void {
  const original: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    original[k] = process.env[k];
    process.env[k] = env[k];
  }
  t.after(() => {
    for (const k of Object.keys(original)) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    __resetForTests();
  });
}

test("runner E2E: ok run produces final.md/meta.json/argv.json with status=ok", async (t) => {
  withEnv(t, { PARAOPEN_FAKE_MODE: "ok" });
  const spec = await makeSpec(t);
  const result = await runOpencode(spec, { binary: fakeBinaryPath() });
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.equal(result.spawnError, null);
  assert.equal(result.signal, null);
  assert.match(await readFile(result.finalFile, "utf8"), /Lorem ipsum/);
  const meta = JSON.parse(await readFile(result.metaFile, "utf8"));
  assert.equal(meta.status, "ok");
  const argv = JSON.parse(await readFile(join(spec.modelDir, "argv.json"), "utf8"));
  assert.equal(argv[0], fakeBinaryPath());
  assert.ok(argv.includes("--model"));
});

test("runner E2E: empty mode -> status=empty", async (t) => {
  withEnv(t, { PARAOPEN_FAKE_MODE: "empty" });
  const spec = await makeSpec(t);
  const r = await runOpencode(spec, { binary: fakeBinaryPath() });
  assert.equal(r.status, "empty");
});

test("runner E2E: incomplete mode (length finish reason) -> status=incomplete", async (t) => {
  withEnv(t, { PARAOPEN_FAKE_MODE: "incomplete" });
  const spec = await makeSpec(t);
  const r = await runOpencode(spec, { binary: fakeBinaryPath() });
  assert.equal(r.status, "incomplete");
});

test("runner E2E: tool-loop mode -> status=tool-loop with header in final.md", async (t) => {
  withEnv(t, { PARAOPEN_FAKE_MODE: "tool-loop" });
  const spec = await makeSpec(t);
  const r = await runOpencode(spec, { binary: fakeBinaryPath() });
  assert.equal(r.status, "tool-loop");
  assert.match(await readFile(r.finalFile, "utf8"), /PARA-OPEN STATUS: tool-loop/);
});

test("runner E2E: content-filter mode -> status=content-filtered", async (t) => {
  withEnv(t, { PARAOPEN_FAKE_MODE: "content-filter" });
  const spec = await makeSpec(t);
  const r = await runOpencode(spec, { binary: fakeBinaryPath() });
  assert.equal(r.status, "content-filtered");
});

test("runner E2E: crash mode -> status=crashed with non-zero exit", async (t) => {
  withEnv(t, { PARAOPEN_FAKE_MODE: "crash", PARAOPEN_FAKE_EXIT: "2" });
  const spec = await makeSpec(t);
  const r = await runOpencode(spec, { binary: fakeBinaryPath() });
  assert.equal(r.status, "crashed");
  assert.equal(r.exitCode, 2);
});

test("runner E2E: missing binary -> status=spawn-error", async (t) => {
  withEnv(t, {});
  const spec = await makeSpec(t);
  const r = await runOpencode(spec, { binary: "/path/that/does/not/exist/opencode-xyz" });
  assert.equal(r.status, "spawn-error");
  assert.ok(r.spawnError && r.spawnError.length > 0);
});

test("runner E2E: timeout mode -> status=timeout, child SIGTERMed", async (t) => {
  withEnv(t, { PARAOPEN_FAKE_MODE: "ok", PARAOPEN_FAKE_DELAY_MS: "5000" });
  const spec = await makeSpec(t, 200); // 200ms timeout
  const t0 = Date.now();
  const r = await runOpencode(spec, { binary: fakeBinaryPath() });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, "timeout");
  assert.equal(r.timedOut, true);
  // Should not wait the full 5s
  assert.ok(elapsed < 4000, `expected fast exit, got ${elapsed}ms`);
});
