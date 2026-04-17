import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

/**
 * Create a unique temp directory and register it for automatic cleanup when
 * the test (or describe block) finishes via t.after().
 */
export async function makeTmpDir(t: TestContext, prefix = "para-open-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return dir;
}
