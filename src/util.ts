import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function utcStamp(d: Date = new Date()): string {
  // 2026-04-17T19-23-45Z (filesystem-safe)
  return d.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
}

export function shortId(n = 4): string {
  return randomBytes(n).toString("hex");
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m${r.toString().padStart(2, "0")}s`;
}

export function pad(s: string, len: number): string {
  if (s.length >= len) return s;
  return s + " ".repeat(len - s.length);
}

export function log(...args: unknown[]): void {
  process.stderr.write(`[para-open] ${args.map(String).join(" ")}\n`);
}

/**
 * Read the package version from the bundled package.json. We read it
 * synchronously at module load time so callers can use it like a constant.
 * Falls back to "0.0.0" if the file can't be located (e.g., during weird
 * bundling scenarios). Resolves relative to this file: dist/util.js -> ../package.json.
 */
export function loadPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/util.js is one level below the package root.
    const pkgPath = join(here, "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
