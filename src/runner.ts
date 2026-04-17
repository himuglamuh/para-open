import { spawn, ChildProcess } from "node:child_process";
import { createWriteStream, WriteStream } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./util.js";
import {
  analyzeStdout,
  deriveStatus,
  DerivedStatus,
  RunAnalysis,
} from "./analysis.js";

export interface RunSpec {
  label: string;
  modelId: string;
  prompt: string;
  workspace: string;
  modelDir: string;
  timeoutMs: number;
}

export interface RunResult {
  label: string;
  modelId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: string | null;
  stdoutFile: string;
  stderrFile: string;
  metaFile: string;
  finalFile: string;
  argv: string[];
  /** Derived run status based on event analysis. */
  status: DerivedStatus;
  /** Human-readable reasons contributing to the status. */
  statusReasons: string[];
  /** Event-stream analysis. */
  analysis: RunAnalysis;
}

const activeChildren = new Set<ChildProcess>();
let signalForwardingInstalled = false;

export function installSignalForwarding(): void {
  if (signalForwardingInstalled) return;
  signalForwardingInstalled = true;
  const handler = (sig: NodeJS.Signals) => {
    for (const c of activeChildren) {
      try {
        c.kill(sig);
      } catch {
        // ignore
      }
    }
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

/** Track a child for signal forwarding. Safe to call without installSignalForwarding. */
export function registerChild(child: ChildProcess): void {
  activeChildren.add(child);
}

/** Stop tracking a child (typically on close/error). */
export function unregisterChild(child: ChildProcess): void {
  activeChildren.delete(child);
}

export interface SpawnOptions {
  binary?: string;
  extraArgs?: string[];
}

export async function runOpencode(
  spec: RunSpec,
  opts: SpawnOptions = {},
): Promise<RunResult> {
  const bin = opts.binary ?? "opencode";
  const argv = [
    "run",
    "--model",
    spec.modelId,
    "--format",
    "json",
    "--dangerously-skip-permissions",
    "--dir",
    spec.workspace,
    "--log-level",
    "INFO",
    "--print-logs",
    ...(opts.extraArgs ?? []),
    "--",
    spec.prompt,
  ];

  const stdoutFile = join(spec.modelDir, "stdout.jsonl");
  const stderrFile = join(spec.modelDir, "stderr.log");
  const metaFile = join(spec.modelDir, "meta.json");
  const finalFile = join(spec.modelDir, "final.md");
  const argvFile = join(spec.modelDir, "argv.json");
  await writeFile(argvFile, JSON.stringify([bin, ...argv], null, 2));

  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const startTs = Date.now();

  return await new Promise<RunResult>((resolvePromise) => {
    let stdoutStream: WriteStream | null = null;
    let stderrStream: WriteStream | null = null;
    let child: ChildProcess;
    try {
      stdoutStream = createWriteStream(stdoutFile);
      stderrStream = createWriteStream(stderrFile);
      child = spawn(bin, argv, {
        cwd: spec.workspace,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err) {
      const msg = (err as Error).message;
      log(`[${spec.label}] spawn failed: ${msg}`);
      stdoutStream?.end();
      stderrStream?.end();
      const endedAtDate = new Date();
      void finalizeWithAnalysis({
        spec,
        argv: [bin, ...argv],
        startedAt,
        endedAtISO: endedAtDate.toISOString(),
        durationMs: Date.now() - startTs,
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: msg,
        stdoutFile,
        stderrFile,
        metaFile,
        finalFile,
      }).then(resolvePromise);
      return;
    }

    activeChildren.add(child);
    child.stdout?.pipe(stdoutStream);
    child.stderr?.pipe(stderrStream);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`[${spec.label}] timeout after ${spec.timeoutMs}ms, killing`);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 10_000).unref();
    }, spec.timeoutMs);
    timer.unref();

    const finalize = async (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError: string | null,
    ) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      stdoutStream?.end();
      stderrStream?.end();
      const endedAtDate = new Date();
      const result = await finalizeWithAnalysis({
        spec,
        argv: [bin, ...argv],
        startedAt,
        endedAtISO: endedAtDate.toISOString(),
        durationMs: Date.now() - startTs,
        exitCode: code,
        signal,
        timedOut,
        spawnError,
        stdoutFile,
        stderrFile,
        metaFile,
        finalFile,
      });
      resolvePromise(result);
    };

    child.on("error", (err) => {
      void finalize(null, null, err.message);
    });
    child.on("close", (code, signal) => {
      void finalize(code, signal, null);
    });
  });
}

interface FinalizeInput {
  spec: RunSpec;
  argv: string[];
  startedAt: string;
  endedAtISO: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: string | null;
  stdoutFile: string;
  stderrFile: string;
  metaFile: string;
  finalFile: string;
}

async function finalizeWithAnalysis(input: FinalizeInput): Promise<RunResult> {
  const analysis = await analyzeStdout(input.stdoutFile);
  const derived = deriveStatus({
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    spawnError: input.spawnError,
    analysis,
  });

  const result: RunResult = {
    label: input.spec.label,
    modelId: input.spec.modelId,
    startedAt: input.startedAt,
    endedAt: input.endedAtISO,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    spawnError: input.spawnError,
    stdoutFile: input.stdoutFile,
    stderrFile: input.stderrFile,
    metaFile: input.metaFile,
    finalFile: input.finalFile,
    argv: input.argv,
    status: derived.status,
    statusReasons: derived.reasons,
    analysis,
  };

  try {
    await writeFile(input.metaFile, JSON.stringify(result, null, 2));
  } catch {
    /* ignore */
  }
  try {
    const finalText = buildFinalMarkdown(result);
    await writeFile(input.finalFile, finalText);
  } catch (err) {
    await writeFile(
      input.finalFile,
      `# Final message extraction failed\n\n${(err as Error).message}\n`,
    );
  }
  return result;
}

/**
 * Build the final.md content: the last non-synthetic assistant text, preceded
 * by a warning header when the run's status is anything other than "ok".
 */
export function buildFinalMarkdown(result: RunResult): string {
  const text = result.analysis.lastAssistantText.trim();
  const header = buildStatusHeader(result);
  if (text.length > 0) {
    return `${header}${text}\n`;
  }
  return `${header}_(no substantive assistant text was produced)_\n`;
}

function buildStatusHeader(result: RunResult): string {
  if (result.status === "ok") return "";
  const a = result.analysis;
  const parts: string[] = [];
  parts.push(`<!-- PARA-OPEN STATUS: ${result.status} -->`);
  parts.push(`> **⚠ Run status: \`${result.status}\`**`);
  if (result.statusReasons.length > 0) {
    for (const r of result.statusReasons) parts.push(`> - ${r}`);
  }
  parts.push(`> - stepCount=${a.stepCount}, lastFinishReason=${a.lastFinishReason ?? "none"}`);
  parts.push(
    `> - assistantTextChunks=${a.assistantTextCount}, bytes=${a.assistantTextBytes}`,
  );
  parts.push(
    `> - tools used: ${
      Object.keys(a.toolBreakdown).length > 0
        ? Object.entries(a.toolBreakdown)
            .map(([k, v]) => `${k}×${v}`)
            .join(", ")
        : "none"
    }`,
  );
  parts.push("");
  return parts.join("\n") + "\n";
}

/**
 * Re-extract final.md from stdout.jsonl for an existing run. Used by the `synth`
 * subcommand to refresh incremental content before building the dossier.
 * Returns the newly computed analysis so callers can update downstream state.
 */
export async function reextractFinal(
  stdoutFile: string,
  finalFile: string,
  baseResult: {
    label: string;
    modelId: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    spawnError: string | null;
    durationMs: number;
    startedAt?: string;
    endedAt?: string;
    argv?: string[];
    stderrFile?: string;
    metaFile?: string;
  },
): Promise<RunResult> {
  const analysis = await analyzeStdout(stdoutFile);
  const derived = deriveStatus({
    exitCode: baseResult.exitCode,
    signal: baseResult.signal,
    timedOut: baseResult.timedOut,
    spawnError: baseResult.spawnError,
    analysis,
  });
  const result: RunResult = {
    label: baseResult.label,
    modelId: baseResult.modelId,
    startedAt: baseResult.startedAt ?? "",
    endedAt: baseResult.endedAt ?? "",
    durationMs: baseResult.durationMs,
    exitCode: baseResult.exitCode,
    signal: (baseResult.signal as NodeJS.Signals | null) ?? null,
    timedOut: baseResult.timedOut,
    spawnError: baseResult.spawnError,
    stdoutFile,
    stderrFile: baseResult.stderrFile ?? "",
    metaFile: baseResult.metaFile ?? "",
    finalFile,
    argv: baseResult.argv ?? [],
    status: derived.status,
    statusReasons: derived.reasons,
    analysis,
  };
  await writeFile(finalFile, buildFinalMarkdown(result));
  // Persist the refreshed status/analysis back to meta.json so later inspections
  // (and subsequent synth/ask invocations) see the enriched fields on disk.
  if (baseResult.metaFile) {
    try {
      const raw = await readFile(baseResult.metaFile, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed.status = result.status;
      parsed.statusReasons = result.statusReasons;
      parsed.analysis = result.analysis;
      await writeFile(baseResult.metaFile, JSON.stringify(parsed, null, 2));
    } catch {
      // non-fatal: meta.json may not exist or be writable; dossier is the source of truth
    }
  }
  return result;
}

/**
 * Back-compat wrapper: returns the raw "last assistant text" extracted from a
 * stdout.jsonl file. Used by the synthesis fallback.
 */
export async function extractFinalAssistantMessage(stdoutFile: string): Promise<string> {
  const analysis = await analyzeStdout(stdoutFile);
  if (analysis.lastAssistantText.trim()) {
    return analysis.lastAssistantText.trim() + "\n";
  }
  // Ultimate fallback: raw file content (old behavior).
  try {
    return await readFile(stdoutFile, "utf8");
  } catch {
    return "# (no stdout captured)\n";
  }
}
