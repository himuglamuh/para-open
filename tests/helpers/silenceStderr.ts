import type { TestContext } from "node:test";

/**
 * Replace process.stderr.write with a buffer collector for the duration of the
 * test. Returns a `getOutput()` accessor. Restoration is registered via t.after.
 */
export function captureStderr(t: TestContext): () => string {
  const original = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  // @ts-expect-error - we deliberately swap a narrower signature
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });
  return () => chunks.join("");
}
