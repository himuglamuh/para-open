import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, basename } from "node:path";
import { utcStamp, shortId } from "./util.js";

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "runs",
  ".turbo",
  ".parcel-cache",
]);

export interface RunLayout {
  runRoot: string;
  promptFile: string;
}

export async function createRunRoot(outRoot: string): Promise<RunLayout> {
  const name = `${utcStamp()}-${shortId()}`;
  const runRoot = resolve(outRoot, name);
  await mkdir(runRoot, { recursive: true });
  const promptFile = join(runRoot, "prompt.txt");
  return { runRoot, promptFile };
}

export async function createModelWorkspace(
  runRoot: string,
  label: string,
  sourceDir: string | null,
): Promise<{ modelDir: string; workspace: string }> {
  const modelDir = join(runRoot, label);
  const workspace = join(modelDir, "workspace");
  await mkdir(workspace, { recursive: true });

  if (sourceDir) {
    const absSrc = resolve(sourceDir);
    await cp(absSrc, workspace, {
      recursive: true,
      dereference: false,
      errorOnExist: false,
      force: true,
      filter: (src) => {
        const rel = relative(absSrc, src);
        if (!rel) return true;
        const parts = rel.split(/[\\/]/);
        for (const p of parts) {
          if (EXCLUDE_DIRS.has(p)) return false;
        }
        // Skip the out root itself if it's inside source
        return true;
      },
    });
  }

  return { modelDir, workspace };
}

export interface FileSnapshot {
  paths: Map<string, { mtimeMs: number; size: number }>;
}

export async function snapshotWorkspace(workspace: string): Promise<FileSnapshot> {
  const paths = new Map<string, { mtimeMs: number; size: number }>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          const st = await stat(full);
          paths.set(relative(workspace, full), {
            mtimeMs: st.mtimeMs,
            size: st.size,
          });
        } catch {
          // ignore
        }
      }
    }
  }
  await walk(workspace);
  return { paths };
}

export interface ChangeSummary {
  created: string[];
  modified: string[];
  deleted: string[];
}

export async function diffWorkspace(
  workspace: string,
  before: FileSnapshot,
): Promise<ChangeSummary> {
  const after = await snapshotWorkspace(workspace);
  return computeChanges(before, after);
}

/**
 * Pure diff between two snapshots. Exported so tests can verify diff semantics
 * without touching the filesystem.
 */
export function computeChanges(
  before: FileSnapshot,
  after: FileSnapshot,
): ChangeSummary {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [p, meta] of after.paths) {
    const prev = before.paths.get(p);
    if (!prev) created.push(p);
    else if (prev.mtimeMs !== meta.mtimeMs || prev.size !== meta.size) modified.push(p);
  }
  for (const p of before.paths.keys()) {
    if (!after.paths.has(p)) deleted.push(p);
  }
  created.sort();
  modified.sort();
  deleted.sort();
  return { created, modified, deleted };
}

export async function writeChangesFile(modelDir: string, changes: ChangeSummary): Promise<string> {
  const out = join(modelDir, "changes.txt");
  const lines: string[] = [];
  lines.push(`# Created (${changes.created.length})`);
  for (const p of changes.created) lines.push(`+ ${p}`);
  lines.push("");
  lines.push(`# Modified (${changes.modified.length})`);
  for (const p of changes.modified) lines.push(`~ ${p}`);
  lines.push("");
  lines.push(`# Deleted (${changes.deleted.length})`);
  for (const p of changes.deleted) lines.push(`- ${p}`);
  lines.push("");
  await writeFile(out, lines.join("\n"), "utf8");
  return out;
}

export function sourceDirName(p: string): string {
  return basename(resolve(p));
}
