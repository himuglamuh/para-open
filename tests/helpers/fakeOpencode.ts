import { mkdir, symlink, writeFile, chmod } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { makeTmpDir } from "./tmp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_OPENCODE_SCRIPT = resolve(HERE, "..", "fixtures", "fake-opencode.cjs");

/**
 * Returns the path to the fake-opencode script. Always pass this as
 * SpawnOptions.binary when invoking runner/synthesizer functions directly.
 */
export function fakeBinaryPath(): string {
  return FAKE_OPENCODE_SCRIPT;
}

/**
 * Build a PATH-injectable directory containing an `opencode` shim that execs
 * the fake script. Useful for E2E tests that spawn the para-open CLI itself
 * (which calls `opencode` by name and cannot have a binary path injected).
 *
 * Returns { binDir, pathEnv } where pathEnv is a value safe to use as PATH.
 */
export async function makeFakeBinDir(t: TestContext): Promise<{ binDir: string; pathEnv: string }> {
  const dir = await makeTmpDir(t, "para-open-bin-");
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const shim = join(binDir, "opencode");
  // Use a tiny shell shim that execs node on the fake script. This means PATH
  // injection works regardless of whether the consumer uses execvp or spawn.
  await writeFile(
    shim,
    `#!/bin/sh\nexec node ${JSON.stringify(FAKE_OPENCODE_SCRIPT)} "$@"\n`,
    { mode: 0o755 },
  );
  await chmod(shim, 0o755);
  const pathEnv = `${binDir}:${process.env.PATH ?? ""}`;
  return { binDir, pathEnv };
}

/**
 * Convenience: build the env object for spawning the para-open CLI such that
 * it picks up the fake `opencode` binary, plus any extra env settings.
 */
export async function fakeOpencodeEnv(
  t: TestContext,
  extra: Record<string, string> = {},
): Promise<NodeJS.ProcessEnv> {
  const { pathEnv } = await makeFakeBinDir(t);
  return { ...process.env, ...extra, PATH: pathEnv };
}
