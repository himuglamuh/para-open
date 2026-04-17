import { createWriteStream } from "node:fs";
import { writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { OrchestrationResult, ModelRunSummary } from "./orchestrator.js";
import { extractFinalAssistantMessage, registerChild, unregisterChild } from "./runner.js";
import { analyzeStdout, RunAnalysis } from "./analysis.js";
import { fmtDuration, log } from "./util.js";

export interface SynthesisOptions {
  synthesizerModel: string;
  timeoutMs: number;
}

export interface SynthesisResult {
  reportFile: string;
  stdoutFile: string;
  stderrFile: string;
  dossierFile: string;
  sessionFile: string;
  sessionId: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  spawnError: string | null;
}

const MAX_FINAL_BYTES = 60_000;
const MAX_CHANGES_LINES = 200;
const MAX_STDERR_TAIL_BYTES = 4_000;
const MAX_TOOL_TRANSCRIPT_ROWS = 40;

const SYNTH_PROMPT = `You are the synthesis judge for a parallel multi-model experiment run by the
"para-open" tool. A single "dossier.md" file has been attached. It contains:

- The original user prompt (verbatim).
- A run-overview table showing each model's derived status ('ok',
  'content-filtered', 'timeout', 'tool-loop', 'empty', 'incomplete',
  'spawn-error', 'crashed').
- For each model: run metadata, a tool-use transcript (chronological list of
  tool calls the model made), file-change list, and the final assistant text.
- For models whose status is NOT 'ok', the final section will be preceded by
  a blockquote warning describing the failure mode.

Your job: read dossier.md carefully, then WRITE a thorough comparison report as
Markdown to the file "report.md" in the current working directory using the
write tool. (Do not just print to stdout; write the file.)

Important: when a model's status is not 'ok' (e.g. 'content-filtered',
'tool-loop', 'timeout'), DO NOT evaluate its final text as if it were a real
answer. Instead, treat it as a failed run and note what the tool transcript
shows it was trying to do before it failed.

The report MUST contain, in this order:

# Parallel opencode run report

## 1. The prompt
Quote the prompt verbatim (fenced).

## 2. Run overview table
Markdown table with columns: label | model id | status | duration | steps |
tools | assistant-text-chunks | files created/modified/deleted. Include every
model from the dossier.

## 3. Per-model summary
One subsection per model. For 'ok' models, 3-8 bullets covering approach,
notable decisions, code/files produced, and any errors. For non-ok models,
state the failure mode explicitly and describe (from the tool transcript) what
the model was attempting before it stopped.

## 4. Comparison & contrast
Group 'ok' models by approach. Call out agreements, disagreements, scope
divergence, stylistic differences. Separately, group the failed models by
failure mode.

## 5. Correctness & quality assessment
For each 'ok' model, rate (1-5) on: correctness, completeness, code quality,
adherence to the prompt. Justify briefly. Flag hallucinations, unsupported
claims, or broken code. Do NOT rate failed models on these axes; just note
the failure.

## 6. Unique insights
Surface anything one model noticed that others missed.

## 7. Failure modes
Enumerate every non-'ok' run. Group by failure mode (content-filter, timeout,
tool-loop, empty, etc.). For each, note what the model was doing when it
failed, based on the tool transcript.

## 8. Ranking & recommendation
Rank the models that produced real answers for THIS task with a one-line
justification each. Name the overall winner and explain why. Call out any
model that was clearly unsuitable.

## 9. Meta notes
Timing deltas, anomalies, tool-use patterns that surprised you, anything else
worth flagging.

Be concrete. Quote short snippets from the final messages when they illustrate
a point. Avoid vague praise. After writing report.md, print a two-line summary
to stdout confirming the file path and overall winner.`;

async function readTextSafe(path: string, maxBytes?: number): Promise<string> {
  try {
    const buf = await readFile(path, "utf8");
    if (maxBytes && buf.length > maxBytes) {
      const head = buf.slice(0, Math.floor(maxBytes * 0.8));
      const tail = buf.slice(buf.length - Math.floor(maxBytes * 0.15));
      return (
        head +
        `\n\n... [TRUNCATED ${buf.length - head.length - tail.length} bytes] ...\n\n` +
        tail
      );
    }
    return buf;
  } catch {
    return "";
  }
}

async function tailText(path: string, maxBytes: number): Promise<string> {
  try {
    const buf = await readFile(path, "utf8");
    if (buf.length <= maxBytes) return buf;
    return (
      `... [truncated; showing tail ${maxBytes} of ${buf.length} bytes] ...\n` +
      buf.slice(-maxBytes)
    );
  } catch {
    return "";
  }
}

/**
 * Return an analysis for a summary: prefer the one already attached; otherwise
 * re-analyze stdout on disk (used by `synth` subcommand on older runs).
 */
async function getAnalysis(s: ModelRunSummary): Promise<RunAnalysis | null> {
  if (s.analysis) return s.analysis;
  if (s.stdoutFile) {
    try {
      return await analyzeStdout(s.stdoutFile);
    } catch {
      return null;
    }
  }
  return null;
}

async function buildDossier(
  runRoot: string,
  summaries: ModelRunSummary[],
): Promise<string> {
  const promptText = await readTextSafe(join(runRoot, "prompt.txt"));

  const lines: string[] = [];
  lines.push("# para-open run dossier");
  lines.push("");
  lines.push(`Run root: \`${runRoot}\``);
  lines.push("");
  lines.push("## Original prompt");
  lines.push("");
  lines.push("```");
  lines.push(promptText.trimEnd());
  lines.push("```");
  lines.push("");

  // Overview table
  lines.push("## Overview");
  lines.push("");
  lines.push(
    "| label | model | status | duration | steps | tools | texts | exit | signal | timedOut | created | modified | deleted |",
  );
  lines.push(
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  const analyses = new Map<string, RunAnalysis | null>();
  for (const s of summaries) {
    const a = await getAnalysis(s);
    analyses.set(s.label, a);
    lines.push(
      `| ${s.label} | ${s.modelId} | **${s.status}** | ${s.durationMs}ms | ${a?.stepCount ?? ""} | ${a?.toolCount ?? ""} | ${a?.assistantTextCount ?? ""} | ${s.exitCode ?? ""} | ${s.signal ?? ""} | ${s.timedOut ? "yes" : ""} | ${s.changes.created} | ${s.changes.modified} | ${s.changes.deleted} |`,
    );
  }
  lines.push("");

  // Per-model details
  for (const s of summaries) {
    const a = analyses.get(s.label) ?? null;
    lines.push(`---`);
    lines.push("");
    lines.push(`## Model: ${s.label} (${s.modelId})`);
    lines.push("");
    lines.push(`**Derived status:** \`${s.status}\``);
    if (s.statusReasons.length > 0) {
      lines.push("");
      lines.push("**Status reasons:**");
      for (const r of s.statusReasons) lines.push(`- ${r}`);
    }
    lines.push("");

    // Metadata
    lines.push("### Run metadata");
    lines.push("```json");
    lines.push(
      JSON.stringify(
        {
          modelId: s.modelId,
          durationMs: s.durationMs,
          exitCode: s.exitCode,
          signal: s.signal,
          timedOut: s.timedOut,
          spawnError: s.spawnError,
          stepCount: a?.stepCount ?? null,
          finishReasons: a?.finishReasons ?? null,
          lastFinishReason: a?.lastFinishReason ?? null,
          contentFilterHit: a?.contentFilterHit ?? null,
          firstContentFilterAt: a?.firstContentFilterAt ?? null,
          toolCount: a?.toolCount ?? null,
          toolBreakdown: a?.toolBreakdown ?? null,
          assistantTextCount: a?.assistantTextCount ?? null,
          assistantTextBytes: a?.assistantTextBytes ?? null,
        },
        null,
        2,
      ),
    );
    lines.push("```");
    lines.push("");

    // Tool transcript
    if (a && a.toolSequence.length > 0) {
      const rows = a.toolSequence;
      lines.push("### Tool transcript");
      lines.push("");
      lines.push("| # | tool | status | input summary |");
      lines.push("|---|---|---|---|");
      const shown = rows.slice(0, MAX_TOOL_TRANSCRIPT_ROWS);
      for (let i = 0; i < shown.length; i++) {
        const r = shown[i];
        const summary = (r.summary ?? "").replace(/\|/g, "\\|").slice(0, 200);
        lines.push(`| ${i + 1} | ${r.tool} | ${r.status} | ${summary} |`);
      }
      if (rows.length > MAX_TOOL_TRANSCRIPT_ROWS) {
        lines.push(
          `| ... | ... | ... | (${rows.length - MAX_TOOL_TRANSCRIPT_ROWS} more tool calls omitted) |`,
        );
      }
      lines.push("");
    }

    // File changes
    let changesText = await readTextSafe(s.changesFile);
    const changeLines = changesText.split("\n");
    if (changeLines.length > MAX_CHANGES_LINES) {
      changesText =
        changeLines.slice(0, MAX_CHANGES_LINES).join("\n") +
        `\n... [${changeLines.length - MAX_CHANGES_LINES} more lines truncated]`;
    }
    lines.push("### File changes");
    lines.push("```");
    lines.push(changesText.trimEnd() || "(none)");
    lines.push("```");
    lines.push("");

    // Final assistant text (already has warning header for non-ok runs)
    const finalText = await readTextSafe(s.finalFile, MAX_FINAL_BYTES);
    lines.push("### Final assistant message");
    lines.push("");
    if (finalText.trim()) {
      lines.push(finalText.trimEnd());
    } else {
      lines.push("_(empty)_");
    }
    lines.push("");

    // Stderr tail only on failure
    if (s.status !== "ok") {
      const tail = await tailText(s.stderrFile, MAX_STDERR_TAIL_BYTES);
      if (tail.trim()) {
        lines.push("### stderr tail");
        lines.push("```");
        lines.push(tail.trimEnd());
        lines.push("```");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

async function extractSessionId(stdoutFile: string): Promise<string | null> {
  try {
    const raw = await readFile(stdoutFile, "utf8");
    const m = raw.match(/"sessionID":"(ses_[A-Za-z0-9]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function synthesize(
  result: OrchestrationResult,
  opts: SynthesisOptions,
): Promise<SynthesisResult> {
  const runRoot = result.runRoot;
  const dossierFile = join(runRoot, "dossier.md");
  const stdoutFile = join(runRoot, "synthesis.stdout.jsonl");
  const stderrFile = join(runRoot, "synthesis.stderr.log");
  const reportFile = join(runRoot, "report.md");
  const sessionFile = join(runRoot, "synthesis.session.json");

  const dossier = await buildDossier(runRoot, result.summaries);
  await writeFile(dossierFile, dossier);
  log(`Synthesis: wrote dossier.md (${dossier.length} bytes)`);

  const argv = [
    "run",
    "--model",
    opts.synthesizerModel,
    "--format",
    "json",
    "--dangerously-skip-permissions",
    "--dir",
    runRoot,
    "--log-level",
    "INFO",
    "--print-logs",
    "-f",
    "dossier.md",
    "--",
    SYNTH_PROMPT,
  ];

  await writeFile(
    join(runRoot, "synthesis.argv.json"),
    JSON.stringify(["opencode", ...argv], null, 2),
  );

  log(`Synthesis: spawning ${opts.synthesizerModel}`);

  const startTs = Date.now();

  const synthResult = await new Promise<SynthesisResult>((resolvePromise) => {
    let out, err;
    try {
      out = createWriteStream(stdoutFile);
      err = createWriteStream(stderrFile);
    } catch (e) {
      resolvePromise({
        reportFile,
        stdoutFile,
        stderrFile,
        dossierFile,
        sessionFile,
        sessionId: null,
        exitCode: null,
        signal: null,
        durationMs: 0,
        timedOut: false,
        spawnError: (e as Error).message,
      });
      return;
    }

    const child = spawn("opencode", argv, {
      cwd: runRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    registerChild(child);

    child.stdout?.pipe(out);
    child.stderr?.pipe(err);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`Synthesis timeout after ${opts.timeoutMs}ms, killing`);
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
    }, opts.timeoutMs);
    timer.unref();

    child.on("error", (e) => {
      clearTimeout(timer);
      unregisterChild(child);
      out.end();
      err.end();
      resolvePromise({
        reportFile,
        stdoutFile,
        stderrFile,
        dossierFile,
        sessionFile,
        sessionId: null,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startTs,
        timedOut,
        spawnError: e.message,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      unregisterChild(child);
      out.end();
      err.end();
      resolvePromise({
        reportFile,
        stdoutFile,
        stderrFile,
        dossierFile,
        sessionFile,
        sessionId: null,
        exitCode: code,
        signal,
        durationMs: Date.now() - startTs,
        timedOut,
        spawnError: null,
      });
    });
  });

  log(
    `Synthesis finished in ${fmtDuration(synthResult.durationMs)} (exit ${synthResult.exitCode ?? "?"}${
      synthResult.signal ? `, signal ${synthResult.signal}` : ""
    }${synthResult.timedOut ? ", timed out" : ""})`,
  );

  // Capture the opencode session ID for follow-up chats.
  const sessionId = await extractSessionId(stdoutFile);
  synthResult.sessionId = sessionId;
  if (sessionId) {
    await writeFile(
      sessionFile,
      JSON.stringify(
        {
          sessionId,
          synthesizerModel: opts.synthesizerModel,
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    log(`Synthesis session recorded: ${sessionId}`);
  } else {
    log(`Warning: could not determine synthesis session ID`);
  }

  // Fallback: if the model didn't write report.md, extract final assistant text.
  try {
    await stat(reportFile);
    log(`report.md present (written by synthesizer)`);
  } catch {
    try {
      const fallback = await extractFinalAssistantMessage(stdoutFile);
      await writeFile(
        reportFile,
        `<!-- report.md fallback: synthesizer did not call the write tool; this is the extracted final assistant message. -->\n\n${fallback}`,
      );
      log(`Wrote fallback report.md from synthesizer stdout (${fallback.length} bytes)`);
    } catch (e) {
      await writeFile(
        reportFile,
        `# Synthesis failed\n\nCould not extract a final message. See ${stderrFile}.\n\nError: ${(e as Error).message}\n`,
      );
    }
  }

  return synthResult;
}

/* ----------------------------- Follow-up chat ----------------------------- */

export interface AskOptions {
  runRoot: string;
  question: string;
  /** Override the synthesizer model for this turn (defaults to the one recorded). */
  model?: string;
  /** Timeout in ms. */
  timeoutMs: number;
  /** If true, start a fresh session (ignore the saved synthesis session). */
  fresh?: boolean;
}

export interface AskResult {
  transcriptFile: string;
  stdoutFile: string;
  stderrFile: string;
  sessionId: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  spawnError: string | null;
  answer: string;
}

interface SessionFile {
  sessionId: string;
  synthesizerModel: string;
  capturedAt: string;
}

/**
 * Run a follow-up question against the synthesizer session so it has all prior
 * context (dossier, report, previous questions). Each call appends to
 * followups/<n>.{stdout.jsonl,stderr.log,answer.md}.
 */
export async function askFollowUp(opts: AskOptions): Promise<AskResult> {
  const { runRoot, question, timeoutMs, fresh } = opts;

  // Load session info
  let session: SessionFile | null = null;
  try {
    const raw = await readFile(join(runRoot, "synthesis.session.json"), "utf8");
    session = JSON.parse(raw) as SessionFile;
  } catch {
    /* no prior session */
  }

  const model =
    opts.model ?? session?.synthesizerModel ?? "github-copilot/claude-opus-4.7";

  // Find next follow-up index
  const followupsDir = join(runRoot, "followups");
  await writeFile(join(runRoot, ".keep"), "").catch(() => undefined);
  try {
    await stat(followupsDir);
  } catch {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(followupsDir, { recursive: true });
  }
  const n = await nextFollowupIndex(followupsDir);
  const slug = String(n).padStart(3, "0");
  const base = join(followupsDir, slug);
  const stdoutFile = `${base}.stdout.jsonl`;
  const stderrFile = `${base}.stderr.log`;
  const answerFile = `${base}.answer.md`;
  const transcriptFile = `${base}.question.md`;

  await writeFile(
    transcriptFile,
    `# Follow-up #${n}\n\nModel: \`${model}\`\nSession: \`${session?.sessionId ?? "(new)"}\`\nAsked at: ${new Date().toISOString()}\n\n## Question\n\n${question}\n`,
  );

  const argv: string[] = [
    "run",
    "--model",
    model,
    "--format",
    "json",
    "--dangerously-skip-permissions",
    "--dir",
    runRoot,
    "--log-level",
    "INFO",
    "--print-logs",
  ];
  if (!fresh && session?.sessionId) {
    argv.push("-s", session.sessionId);
  } else {
    // No session to continue: attach dossier so the model has context.
    try {
      await stat(join(runRoot, "dossier.md"));
      argv.push("-f", "dossier.md");
    } catch {
      /* ignore */
    }
    try {
      await stat(join(runRoot, "report.md"));
      argv.push("-f", "report.md");
    } catch {
      /* ignore */
    }
  }
  argv.push("--", question);

  log(
    `Follow-up #${n}: ${model}${
      !fresh && session?.sessionId ? ` continuing session ${session.sessionId}` : " (new session)"
    }`,
  );

  const startTs = Date.now();
  const result = await new Promise<AskResult>((resolvePromise) => {
    let out, err;
    try {
      out = createWriteStream(stdoutFile);
      err = createWriteStream(stderrFile);
    } catch (e) {
      resolvePromise({
        transcriptFile,
        stdoutFile,
        stderrFile,
        sessionId: session?.sessionId ?? null,
        exitCode: null,
        signal: null,
        durationMs: 0,
        timedOut: false,
        spawnError: (e as Error).message,
        answer: "",
      });
      return;
    }

    const child = spawn("opencode", argv, {
      cwd: runRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    registerChild(child);

    child.stdout?.pipe(out);
    child.stderr?.pipe(err);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
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
    }, timeoutMs);
    timer.unref();

    const done = async (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError: string | null,
    ) => {
      clearTimeout(timer);
      unregisterChild(child);
      out.end();
      err.end();
      const analysis = await analyzeStdout(stdoutFile);
      const sid = analysis.sessionId ?? session?.sessionId ?? null;
      // For follow-ups, always prefer `opencode export` over the stdout text
      // event. On resumed sessions, opencode often emits only a partial text
      // snapshot to stdout (or none at all) while streaming the full response
      // via stderr deltas; the database has the complete final message.
      let answer = "";
      if (sid) {
        const exported = await exportLatestAssistantText(sid);
        if (exported) answer = exported.trim();
      }
      if (!answer) {
        // Fallback to whatever stdout captured
        answer = analysis.lastAssistantText.trim();
      }
      const finalAnswer = answer || "_(no answer produced)_";
      await writeFile(answerFile, `# Follow-up #${n} answer\n\n${finalAnswer}\n`);
      resolvePromise({
        transcriptFile,
        stdoutFile,
        stderrFile,
        sessionId: sid,
        exitCode: code,
        signal,
        durationMs: Date.now() - startTs,
        timedOut,
        spawnError,
        answer: finalAnswer,
      });
    };

    child.on("error", (e) => void done(null, null, e.message));
    child.on("close", (code, signal) => void done(code, signal, null));
  });

  // If we started a fresh session and had none before, save its ID so future
  // follow-ups can continue it.
  if (fresh && result.sessionId && !session) {
    await writeFile(
      join(runRoot, "synthesis.session.json"),
      JSON.stringify(
        {
          sessionId: result.sessionId,
          synthesizerModel: model,
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  return result;
}

async function nextFollowupIndex(dir: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let n = 1;
  try {
    const entries = await readdir(dir);
    const used = new Set<number>();
    for (const e of entries) {
      const m = e.match(/^(\d+)\./);
      if (m) used.add(parseInt(m[1], 10));
    }
    while (used.has(n)) n++;
  } catch {
    /* ignore */
  }
  return n;
}

/**
 * Use `opencode export <sessionID>` to retrieve the latest assistant message
 * text directly from opencode's database. Used as a fallback when the JSON
 * stream from `opencode run` doesn't include a final `text` event (which
 * happens on resumed sessions).
 *
 * Note: we redirect stdout to a temp file rather than piping it back through
 * Node, because large session exports can exceed the default pipe buffer and
 * arrive truncated. File redirection avoids the issue entirely.
 */
async function exportLatestAssistantText(sessionId: string): Promise<string> {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createWriteStream } = await import("node:fs");
  const dir = await mkdtemp(join(tmpdir(), "para-open-export-"));
  const tmp = join(dir, "session.json");
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const out = createWriteStream(tmp);
      const child = spawn("opencode", ["export", sessionId], {
        stdio: ["ignore", "pipe", "ignore"],
        env: process.env,
      });
      child.stdout?.pipe(out);
      child.on("error", (e) => rejectPromise(e));
      child.on("close", () => {
        out.end(() => resolvePromise());
      });
      setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 30_000).unref();
    });
    const raw = await readFile(tmp, "utf8");
    const parsed = JSON.parse(raw) as {
      messages?: Array<{
        info?: { role?: string };
        parts?: Array<{ type?: string; text?: string }>;
      }>;
    };
    const msgs = parsed.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.info?.role !== "assistant") continue;
      const text = (m.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  } catch {
    return "";
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
