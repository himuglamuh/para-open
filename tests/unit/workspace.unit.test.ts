import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceDirName, computeChanges, type FileSnapshot } from "../../src/workspace.ts";

test("sourceDirName: returns basename of resolved absolute path", () => {
  assert.equal(sourceDirName("/tmp/foo/bar"), "bar");
});

test("sourceDirName: ignores trailing slash", () => {
  assert.equal(sourceDirName("/tmp/foo/bar/"), "bar");
});

test("sourceDirName: resolves relative paths against cwd", () => {
  // basename(resolve(".")) == basename(cwd())
  const expected = process.cwd().split("/").pop();
  assert.equal(sourceDirName("."), expected);
});

/* ------------------------------ computeChanges ---------------------------- */

function snap(entries: Record<string, { mtimeMs: number; size: number }>): FileSnapshot {
  return { paths: new Map(Object.entries(entries)) };
}

test("computeChanges: identical snapshots produce no changes", () => {
  const s = snap({ "a.txt": { mtimeMs: 1, size: 10 } });
  assert.deepEqual(computeChanges(s, s), { created: [], modified: [], deleted: [] });
});

test("computeChanges: detects created files", () => {
  const before = snap({});
  const after = snap({ "a.txt": { mtimeMs: 1, size: 1 }, "b.txt": { mtimeMs: 1, size: 1 } });
  const r = computeChanges(before, after);
  assert.deepEqual(r.created, ["a.txt", "b.txt"]);
  assert.deepEqual(r.modified, []);
  assert.deepEqual(r.deleted, []);
});

test("computeChanges: detects deleted files", () => {
  const before = snap({ "gone.txt": { mtimeMs: 1, size: 1 } });
  const after = snap({});
  assert.deepEqual(computeChanges(before, after), {
    created: [],
    modified: [],
    deleted: ["gone.txt"],
  });
});

test("computeChanges: size change yields modified", () => {
  const before = snap({ "f.txt": { mtimeMs: 1, size: 10 } });
  const after = snap({ "f.txt": { mtimeMs: 1, size: 20 } });
  assert.deepEqual(computeChanges(before, after).modified, ["f.txt"]);
});

test("computeChanges: mtime-only change yields modified", () => {
  const before = snap({ "f.txt": { mtimeMs: 1, size: 10 } });
  const after = snap({ "f.txt": { mtimeMs: 2, size: 10 } });
  assert.deepEqual(computeChanges(before, after).modified, ["f.txt"]);
});

test("computeChanges: result lists are sorted", () => {
  const before = snap({ "z.txt": { mtimeMs: 1, size: 1 } });
  const after = snap({
    "b.txt": { mtimeMs: 1, size: 1 },
    "a.txt": { mtimeMs: 1, size: 1 },
    "c.txt": { mtimeMs: 1, size: 1 },
  });
  const r = computeChanges(before, after);
  assert.deepEqual(r.created, ["a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(r.deleted, ["z.txt"]);
});

test("computeChanges: mixed create/modify/delete in one diff", () => {
  const before = snap({
    "keep.txt": { mtimeMs: 1, size: 1 },
    "edit.txt": { mtimeMs: 1, size: 1 },
    "gone.txt": { mtimeMs: 1, size: 1 },
  });
  const after = snap({
    "keep.txt": { mtimeMs: 1, size: 1 },
    "edit.txt": { mtimeMs: 1, size: 5 },
    "new.txt": { mtimeMs: 1, size: 1 },
  });
  assert.deepEqual(computeChanges(before, after), {
    created: ["new.txt"],
    modified: ["edit.txt"],
    deleted: ["gone.txt"],
  });
});
