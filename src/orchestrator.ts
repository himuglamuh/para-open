import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ResolvedConfig } from "./config.js";
import {
  RunLayout,
  createModelWorkspace,
  diffWorkspace,
  snapshotWorkspace,
  writeChangesFile,
} from "./workspace.js";
import { installSignalForwarding, runOpencode, RunResult } from "./runner.js";
import { DerivedStatus, RunAnalysis } from "./analysis.js";
import { fmtDuration, log, pad } from "./util.js";

export interface OrchestrationOptions {
  prompt: string;
  sourceDir: string | null;
  timeoutMs: number;
  dryRun: boolean;
  /** Max concurrent model runs. Defaults to 6 if omitted or invalid. */
  concurrency?: number;
}

export interface ModelRunSummary {
  label: string;
  modelId: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: string | null;
  changes: { created: number; modified: number; deleted: number };
  stdoutFile: string;
  stderrFile: string;
  finalFile: string;
  metaFile: string;
  changesFile: string;
  workspace: string;
  modelDir: string;
  status: DerivedStatus;
  statusReasons: string[];
  analysis: RunAnalysis | null;
}

export interface OrchestrationResult {
  runRoot: string;
  promptFile: string;
  summaries: ModelRunSummary[];
}

export async function orchestrate(
  layout: RunLayout,
  config: ResolvedConfig,
  opts: OrchestrationOptions,
): Promise<OrchestrationResult> {
  installSignalForwarding();
  await writeFile(layout.promptFile, opts.prompt);

  const concurrency =
    opts.concurrency && Number.isFinite(opts.concurrency) && opts.concurrency > 0
      ? Math.floor(opts.concurrency)
      : 6;
  const effectiveConcurrency = Math.min(concurrency, config.models.length);

  log(
    `Launching ${config.models.length} model run(s), up to ${effectiveConcurrency} in parallel (timeout ${fmtDuration(opts.timeoutMs)} each)`,
  );

  const runOne = async (m: typeof config.models[number]): Promise<ModelRunSummary> => {
    const { modelDir, workspace } = await createModelWorkspace(
      layout.runRoot,
      m.label,
      opts.sourceDir,
    );
    const before = await snapshotWorkspace(workspace);

    if (opts.dryRun) {
      const argv = [
        "opencode",
        "run",
        "--model",
        m.id,
        "--format",
        "json",
        "--dangerously-skip-permissions",
        "--dir",
        workspace,
        "--log-level",
        "INFO",
        "--print-logs",
        "--",
        opts.prompt,
      ];
      log(`[dry-run] ${m.label}: ${argv.map(shellQuote).join(" ")}`);
      const summary: ModelRunSummary = {
        label: m.label,
        modelId: m.id,
        durationMs: 0,
        exitCode: 0,
        signal: null,
        timedOut: false,
        spawnError: null,
        changes: { created: 0, modified: 0, deleted: 0 },
        stdoutFile: join(modelDir, "stdout.jsonl"),
        stderrFile: join(modelDir, "stderr.log"),
        finalFile: join(modelDir, "final.md"),
        metaFile: join(modelDir, "meta.json"),
        changesFile: join(modelDir, "changes.txt"),
        workspace,
        modelDir,
        status: "ok",
        statusReasons: [],
        analysis: null,
      };
      return summary;
    }

    const t0 = Date.now();
    log(`[${m.label}] start (${m.id})`);
    const result: RunResult = await runOpencode({
      label: m.label,
      modelId: m.id,
      prompt: opts.prompt,
      workspace,
      modelDir,
      timeoutMs: opts.timeoutMs,
    });
    const statusDesc = result.spawnError
      ? `spawn-error(${result.spawnError})`
      : result.timedOut
        ? "timeout"
        : result.signal
          ? `signal(${result.signal})`
          : `${result.status} (exit ${result.exitCode ?? "?"})`;
    log(`[${m.label}] done in ${fmtDuration(Date.now() - t0)} -> ${statusDesc}`);

    const changes = await diffWorkspace(workspace, before);
    const changesFile = await writeChangesFile(modelDir, changes);

    const summary: ModelRunSummary = {
      label: m.label,
      modelId: m.id,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
      changes: {
        created: changes.created.length,
        modified: changes.modified.length,
        deleted: changes.deleted.length,
      },
      stdoutFile: result.stdoutFile,
      stderrFile: result.stderrFile,
      finalFile: result.finalFile,
      metaFile: result.metaFile,
      changesFile,
      workspace,
      modelDir,
      status: result.status,
      statusReasons: result.statusReasons,
      analysis: result.analysis,
    };
    return summary;
  };

  // Bounded worker-pool: at most `effectiveConcurrency` runOne calls in flight.
  const summaries: ModelRunSummary[] = new Array(config.models.length);
  let nextIdx = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < effectiveConcurrency; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= config.models.length) return;
          const m = config.models[i];
          try {
            summaries[i] = await runOne(m);
          } catch (err) {
            log(`[${m.label}] orchestration error: ${String(err)}`);
            summaries[i] = {
              label: m.label,
              modelId: m.id,
              durationMs: 0,
              exitCode: null,
              signal: null,
              timedOut: false,
              spawnError: String(err),
              changes: { created: 0, modified: 0, deleted: 0 },
              stdoutFile: "",
              stderrFile: "",
              finalFile: "",
              metaFile: "",
              changesFile: "",
              workspace: "",
              modelDir: "",
              status: "spawn-error",
              statusReasons: [String(err)],
              analysis: null,
            };
          }
        }
      })(),
    );
  }
  await Promise.all(workers);

  const index = {
    runRoot: layout.runRoot,
    promptFile: layout.promptFile,
    createdAt: new Date().toISOString(),
    timeoutMs: opts.timeoutMs,
    concurrency: effectiveConcurrency,
    sourceDir: opts.sourceDir,
    synthesizer: config.synthesizer,
    models: summaries,
  };
  await writeFile(join(layout.runRoot, "index.json"), JSON.stringify(index, null, 2));

  printSummaryTable(summaries);

  return { runRoot: layout.runRoot, promptFile: layout.promptFile, summaries };
}

function printSummaryTable(
  summaries: ModelRunSummary[],
  sink: { write(s: string): void } = process.stderr,
): void {
  const header = [
    "label",
    "model",
    "duration",
    "status",
    "steps",
    "tools",
    "texts",
    "created",
    "modified",
    "deleted",
  ];
  const rows: string[][] = [header];
  for (const s of summaries) {
    const a = s.analysis;
    rows.push([
      s.label,
      s.modelId,
      fmtDuration(s.durationMs),
      s.status,
      a ? String(a.stepCount) : "",
      a ? String(a.toolCount) : "",
      a ? String(a.assistantTextCount) : "",
      String(s.changes.created),
      String(s.changes.modified),
      String(s.changes.deleted),
    ]);
  }
  const widths = header.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => pad(c, widths[i])).join("  ");
  sink.write("\n" + line(rows[0]) + "\n");
  sink.write(widths.map((w) => "-".repeat(w)).join("  ") + "\n");
  for (let i = 1; i < rows.length; i++) sink.write(line(rows[i]) + "\n");
  sink.write("\n");
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./:=]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/* Test-only re-exports of internal helpers. */
export { printSummaryTable as __printSummaryTable, shellQuote as __shellQuote };
