#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createRunRoot } from "./workspace.js";
import { orchestrate, OrchestrationResult, ModelRunSummary } from "./orchestrator.js";
import { synthesize, askFollowUp } from "./synthesizer.js";
import { reextractFinal, installSignalForwarding } from "./runner.js";
import { fmtDuration, log, loadPackageVersion } from "./util.js";

const HELP = `para-open - run one prompt across many opencode models in parallel

Usage:
  para-open "<prompt>"                      run with inline prompt
  para-open --prompt-file <path>            read prompt from a file
  para-open synth <run-root>                re-run synthesis on an existing run dir
  para-open ask <run-root> "<question>"     ask a follow-up about the results
  para-open ask <run-root> --question-file <path>

Options:
  --prompt-file <path>     Read prompt from file instead of positional arg.
  --models <path>          Path to models.json (default: ./models.json).
  --source-dir <path>      Directory cloned into each run's workspace
                           (default: current working directory).
                           Use --no-source to skip cloning (empty workspace).
  --no-source              Do not clone any source into workspaces.
  --out <path>             Runs root directory (default: ./runs).
  --timeout <seconds>      Per-run hard timeout (default: 900 = 15 min).
  --concurrency <N>        Max parallel model runs (default: 6).
  --synth-timeout <seconds> Timeout for the synthesis step (default: 1800).
  --synth-model <id>       Override synthesizer model ('synth' and 'ask').
  --no-synth               Skip the final Opus synthesis step.
  --dry-run                Print planned spawn commands and exit.

ask-subcommand options:
  --question-file <path>   Read follow-up question from a file.
  --fresh                  Start a new session instead of continuing synthesis.
  --ask-timeout <seconds>  Timeout for the follow-up (default: 300).

  -v, --version            Print version and exit.
  -h, --help               Show this help.
`;

interface Cli {
  values: Record<string, unknown>;
  positionals: string[];
}

/**
 * Parse para-open CLI arguments using node:util.parseArgs.
 *
 * Exported (and accepts a custom argv) so tests can exercise parsing without
 * spawning a subprocess. When `argv` is omitted, falls back to
 * process.argv.slice(2) (the parseArgs default).
 */
export function parseCliArgs(argv?: string[]): Cli {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "prompt-file": { type: "string" },
      models: { type: "string" },
      "source-dir": { type: "string" },
      "no-source": { type: "boolean" },
      out: { type: "string" },
      timeout: { type: "string" },
      concurrency: { type: "string" },
      "synth-timeout": { type: "string" },
      "synth-model": { type: "string" },
      "no-synth": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "question-file": { type: "string" },
      fresh: { type: "boolean" },
      "ask-timeout": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  return parsed as Cli;
}

function parse(): Cli {
  return parseCliArgs();
}

async function runSynthSubcommand(
  runRoot: string,
  values: Record<string, unknown>,
): Promise<number> {
  const abs = resolve(runRoot);
  let index: {
    runRoot: string;
    promptFile: string;
    synthesizer?: string;
    models: ModelRunSummary[];
  };
  try {
    const text = await readFile(`${abs}/index.json`, "utf8");
    index = JSON.parse(text);
  } catch (e) {
    log(`error: cannot read ${abs}/index.json: ${(e as Error).message}`);
    return 2;
  }

  const synthModel =
    (values["synth-model"] as string | undefined) ??
    index.synthesizer ??
    "github-copilot/claude-opus-4.7";

  const synthTimeoutSec = Number.parseInt(
    (values["synth-timeout"] as string | undefined) ?? "1800",
    10,
  );
  if (!Number.isFinite(synthTimeoutSec) || synthTimeoutSec <= 0) {
    log("error: --synth-timeout must be a positive integer (seconds)");
    return 2;
  }

  // Rebuild file paths to be absolute (in case the run dir was moved).
  const summaries: ModelRunSummary[] = index.models.map((s) => ({
    ...s,
    finalFile: s.finalFile && s.finalFile.startsWith(abs) ? s.finalFile : `${abs}/${s.label}/final.md`,
    metaFile: s.metaFile && s.metaFile.startsWith(abs) ? s.metaFile : `${abs}/${s.label}/meta.json`,
    changesFile:
      s.changesFile && s.changesFile.startsWith(abs) ? s.changesFile : `${abs}/${s.label}/changes.txt`,
    stdoutFile:
      s.stdoutFile && s.stdoutFile.startsWith(abs) ? s.stdoutFile : `${abs}/${s.label}/stdout.jsonl`,
    stderrFile:
      s.stderrFile && s.stderrFile.startsWith(abs) ? s.stderrFile : `${abs}/${s.label}/stderr.log`,
    modelDir: s.modelDir && s.modelDir.startsWith(abs) ? s.modelDir : `${abs}/${s.label}`,
  }));

  log(`Re-running synthesis on ${abs} with ${synthModel}`);

  // Re-extract final.md from each stdout.jsonl using the current extractor
  // AND refresh analysis/status fields on each ModelRunSummary.
  for (const s of summaries) {
    try {
      const refreshed = await reextractFinal(s.stdoutFile, s.finalFile, {
        label: s.label,
        modelId: s.modelId,
        exitCode: s.exitCode,
        signal: s.signal as string | null,
        timedOut: s.timedOut,
        spawnError: s.spawnError,
        durationMs: s.durationMs,
        stderrFile: s.stderrFile,
        metaFile: s.metaFile,
      });
      s.status = refreshed.status;
      s.statusReasons = refreshed.statusReasons;
      s.analysis = refreshed.analysis;
    } catch (e) {
      log(`[${s.label}] re-extract failed: ${(e as Error).message}`);
    }
  }

  const result: OrchestrationResult = {
    runRoot: abs,
    promptFile: `${abs}/prompt.txt`,
    summaries,
  };

  const synth = await synthesize(result, {
    synthesizerModel: synthModel,
    timeoutMs: synthTimeoutSec * 1000,
  });
  log(`Report: ${synth.reportFile}`);
  return !synth.spawnError && !synth.timedOut && synth.exitCode === 0 ? 0 : 1;
}

async function runAskSubcommand(
  runRoot: string,
  question: string,
  values: Record<string, unknown>,
): Promise<number> {
  const abs = resolve(runRoot);
  const timeoutSec = Number.parseInt(
    (values["ask-timeout"] as string | undefined) ?? "300",
    10,
  );
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    log("error: --ask-timeout must be a positive integer (seconds)");
    return 2;
  }
  const model = values["synth-model"] as string | undefined;
  const fresh = Boolean(values.fresh);

  const result = await askFollowUp({
    runRoot: abs,
    question,
    model,
    timeoutMs: timeoutSec * 1000,
    fresh,
  });

  log(
    `Follow-up finished in ${fmtDuration(result.durationMs)} (exit ${result.exitCode ?? "?"}${
      result.timedOut ? ", timed out" : ""
    })`,
  );
  log(`Question recorded: ${result.transcriptFile}`);
  log(`Answer file:        ${result.transcriptFile.replace(/\.question\.md$/, ".answer.md")}`);

  // Also print the answer to stdout for immediate consumption.
  process.stdout.write(result.answer.endsWith("\n") ? result.answer : result.answer + "\n");

  return !result.spawnError && !result.timedOut && result.exitCode === 0 ? 0 : 1;
}

export async function main(argv?: string[]): Promise<number> {
  const { values, positionals } = parseCliArgs(argv);

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(loadPackageVersion() + "\n");
    return 0;
  }

  // Forward Ctrl-C / SIGTERM to all tracked child processes regardless of subcommand.
  installSignalForwarding();

  // synth subcommand: `para-open synth <run-root>`
  if (positionals[0] === "synth") {
    const runRoot = positionals[1];
    if (!runRoot) {
      log("error: 'synth' requires a run-root path: para-open synth <run-root>");
      return 2;
    }
    return await runSynthSubcommand(runRoot, values);
  }

  // ask subcommand: `para-open ask <run-root> [question...]`
  if (positionals[0] === "ask") {
    const runRoot = positionals[1];
    if (!runRoot) {
      log("error: 'ask' requires a run-root path: para-open ask <run-root> \"<question>\"");
      return 2;
    }
    let question: string;
    const questionFile = values["question-file"] as string | undefined;
    if (questionFile) {
      try {
        question = await readFile(resolve(questionFile), "utf8");
      } catch (e) {
        log(`error: cannot read question file: ${(e as Error).message}`);
        return 2;
      }
    } else {
      const rest = positionals.slice(2);
      if (rest.length === 0) {
        log(
          'error: provide a question after the run-root, or use --question-file. Example: para-open ask ./runs/XYZ "elaborate on gpt-5.4\'s approach"',
        );
        return 2;
      }
      question = rest.join(" ");
    }
    question = question.trim();
    if (!question) {
      log("error: question is empty");
      return 2;
    }
    return await runAskSubcommand(runRoot, question, values);
  }

  let prompt: string;
  const promptFile = values["prompt-file"] as string | undefined;
  if (promptFile) {
    try {
      prompt = await readFile(resolve(promptFile), "utf8");
    } catch (e) {
      log(`error: cannot read prompt file: ${(e as Error).message}`);
      return 2;
    }
  } else if (positionals.length > 0) {
    prompt = positionals.join(" ");
  } else {
    process.stderr.write("error: provide a prompt (positional) or --prompt-file <path>\n\n" + HELP);
    return 2;
  }
  prompt = prompt.trim();
  if (!prompt) {
    log("error: prompt is empty");
    return 2;
  }

  const modelsPath = resolve((values.models as string | undefined) ?? "./models.json");
  const outRoot = resolve((values.out as string | undefined) ?? "./runs");
  const sourceDir = values["no-source"]
    ? null
    : resolve((values["source-dir"] as string | undefined) ?? process.cwd());
  const timeoutSec = Number.parseInt((values.timeout as string | undefined) ?? "900", 10);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    log("error: --timeout must be a positive integer (seconds)");
    return 2;
  }
  const synthTimeoutSec = Number.parseInt(
    (values["synth-timeout"] as string | undefined) ?? "1800",
    10,
  );
  if (!Number.isFinite(synthTimeoutSec) || synthTimeoutSec <= 0) {
    log("error: --synth-timeout must be a positive integer (seconds)");
    return 2;
  }
  const concurrencyRaw = values.concurrency as string | undefined;
  const concurrency = concurrencyRaw ? Number.parseInt(concurrencyRaw, 10) : 6;
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    log("error: --concurrency must be a positive integer");
    return 2;
  }

  let config;
  try {
    config = await loadConfig(modelsPath);
  } catch (e) {
    log(`error: ${(e as Error).message}`);
    return 2;
  }

  const layout = await createRunRoot(outRoot);
  log(`Run root: ${layout.runRoot}`);
  log(`Models (${config.models.length}): ${config.models.map((m) => m.label).join(", ")}`);
  if (sourceDir) log(`Cloning source dir into each workspace: ${sourceDir}`);
  else log(`No source dir cloning (empty workspaces)`);

  const dryRun = Boolean(values["dry-run"]);
  const result = await orchestrate(layout, config, {
    prompt,
    sourceDir,
    timeoutMs: timeoutSec * 1000,
    dryRun,
    concurrency,
  });

  if (dryRun) {
    log(`Dry run complete. Outputs scaffolded under ${layout.runRoot}`);
    return 0;
  }

  const skipSynth = Boolean(values["no-synth"]);
  if (skipSynth) {
    log(`--no-synth: skipping synthesis. Outputs in ${result.runRoot}`);
    return 0;
  }

  const synth = await synthesize(result, {
    synthesizerModel: config.synthesizer,
    timeoutMs: synthTimeoutSec * 1000,
  });

  log(`Report: ${synth.reportFile}`);
  log(`Run root: ${result.runRoot}`);
  if (synth.sessionId) {
    log(`Follow-up with: para-open ask ${result.runRoot} "<your question>"`);
  }

  const anyModelOk = result.summaries.some((s) => s.status === "ok");
  const synthOk = !synth.spawnError && !synth.timedOut && synth.exitCode === 0;
  return anyModelOk && synthOk ? 0 : 1;
}

// Auto-run only when invoked as the program entry point (preserves existing
// CLI behavior). Importing this module from tests does NOT trigger main().
function isMainModule(): boolean {
  try {
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
    const here = realpathSync(fileURLToPath(import.meta.url));
    return entry === here;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      log(`fatal: ${(err as Error).stack ?? String(err)}`);
      process.exit(1);
    },
  );
}
