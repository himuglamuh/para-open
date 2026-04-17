import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, utimes, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createRunRoot,
  createModelWorkspace,
  snapshotWorkspace,
  diffWorkspace,
  writeChangesFile,
} from "../../src/workspace.ts";
import { makeTmpDir } from "../helpers/tmp.ts";

test("createRunRoot: creates a uniquely-named subdir under outRoot", async (t) => {
  const out = await makeTmpDir(t);
  const a = await createRunRoot(out);
  const b = await createRunRoot(out);
  assert.notEqual(a.runRoot, b.runRoot);
  assert.ok(a.runRoot.startsWith(out + "/"));
  assert.equal(a.promptFile, join(a.runRoot, "prompt.txt"));
  // Both are real dirs
  for (const d of [a.runRoot, b.runRoot]) {
    const st = await stat(d);
    assert.ok(st.isDirectory());
  }
});

test("createModelWorkspace: with no sourceDir creates an empty workspace dir", async (t) => {
  const root = await makeTmpDir(t);
  const { modelDir, workspace } = await createModelWorkspace(root, "alpha", null);
  assert.equal(modelDir, join(root, "alpha"));
  assert.equal(workspace, join(root, "alpha", "workspace"));
  const st = await stat(workspace);
  assert.ok(st.isDirectory());
});

test("createModelWorkspace: copies sourceDir contents while excluding noisy dirs", async (t) => {
  const src = await makeTmpDir(t);
  // Files we expect to be copied:
  await writeFile(join(src, "README.md"), "hi");
  await mkdir(join(src, "sub"), { recursive: true });
  await writeFile(join(src, "sub", "x.ts"), "export const x = 1;");
  // Excluded directories that should NOT be copied:
  for (const ex of ["node_modules", ".git", "dist", "runs", ".cache", "__pycache__"]) {
    await mkdir(join(src, ex), { recursive: true });
    await writeFile(join(src, ex, "junk.bin"), "junk");
  }

  const root = await makeTmpDir(t);
  const { workspace } = await createModelWorkspace(root, "alpha", src);

  // Copied
  assert.equal(await readFile(join(workspace, "README.md"), "utf8"), "hi");
  assert.equal(await readFile(join(workspace, "sub", "x.ts"), "utf8"), "export const x = 1;");
  // Excluded
  for (const ex of ["node_modules", ".git", "dist", "runs", ".cache", "__pycache__"]) {
    await assert.rejects(stat(join(workspace, ex)));
  }
});

test("snapshotWorkspace: walks recursively, returns relative paths, applies excludes", async (t) => {
  const root = await makeTmpDir(t);
  const ws = join(root, "ws");
  await mkdir(join(ws, "a", "b"), { recursive: true });
  await writeFile(join(ws, "top.txt"), "1");
  await writeFile(join(ws, "a", "mid.txt"), "22");
  await writeFile(join(ws, "a", "b", "deep.txt"), "333");
  // Excluded:
  await mkdir(join(ws, "node_modules"), { recursive: true });
  await writeFile(join(ws, "node_modules", "junk.txt"), "junk");

  const snap = await snapshotWorkspace(ws);
  const keys = Array.from(snap.paths.keys()).sort();
  assert.deepEqual(keys, ["a/b/deep.txt", "a/mid.txt", "top.txt"]);
  // Sizes captured
  assert.equal(snap.paths.get("top.txt")!.size, 1);
  assert.equal(snap.paths.get("a/mid.txt")!.size, 2);
  assert.equal(snap.paths.get("a/b/deep.txt")!.size, 3);
});

test("snapshotWorkspace: missing workspace yields empty snapshot", async (t) => {
  const root = await makeTmpDir(t);
  const snap = await snapshotWorkspace(join(root, "nope"));
  assert.equal(snap.paths.size, 0);
});

test("diffWorkspace: end-to-end create/modify/delete", async (t) => {
  const root = await makeTmpDir(t);
  const ws = join(root, "ws");
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, "keep.txt"), "k");
  await writeFile(join(ws, "edit.txt"), "before");
  await writeFile(join(ws, "gone.txt"), "g");
  // Make timestamps deterministic
  const t1 = new Date("2026-01-01T00:00:00Z");
  for (const f of ["keep.txt", "edit.txt", "gone.txt"]) {
    await utimes(join(ws, f), t1, t1);
  }

  const before = await snapshotWorkspace(ws);

  // Mutate
  await writeFile(join(ws, "edit.txt"), "after-different-size");
  await writeFile(join(ws, "new.txt"), "n");
  // Bump mtime explicitly to ensure it differs even if size were preserved
  const t2 = new Date("2026-01-02T00:00:00Z");
  await utimes(join(ws, "edit.txt"), t2, t2);
  // Delete gone.txt
  const { rm } = await import("node:fs/promises");
  await rm(join(ws, "gone.txt"));

  const changes = await diffWorkspace(ws, before);
  assert.deepEqual(changes.created, ["new.txt"]);
  assert.deepEqual(changes.modified, ["edit.txt"]);
  assert.deepEqual(changes.deleted, ["gone.txt"]);
});

test("writeChangesFile: writes the expected shape to changes.txt", async (t) => {
  const root = await makeTmpDir(t);
  const out = await writeChangesFile(root, {
    created: ["a", "b"],
    modified: ["c"],
    deleted: [],
  });
  assert.equal(out, join(root, "changes.txt"));
  const text = await readFile(out, "utf8");
  assert.match(text, /# Created \(2\)/);
  assert.match(text, /^\+ a$/m);
  assert.match(text, /^\+ b$/m);
  assert.match(text, /# Modified \(1\)/);
  assert.match(text, /^~ c$/m);
  assert.match(text, /# Deleted \(0\)/);
});
