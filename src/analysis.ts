import { open, readFile, stat } from "node:fs/promises";

export type DerivedStatus =
  | "ok"
  | "content-filtered"
  | "timeout"
  | "spawn-error"
  | "crashed"
  | "empty"
  | "tool-loop"
  | "incomplete";

export interface RunAnalysis {
  /** Count of step-finish events. */
  stepCount: number;
  /** Finish reasons in order. */
  finishReasons: string[];
  lastFinishReason: string | null;
  /** True if any step_finish event had reason="content-filter". */
  contentFilterHit: boolean;
  /** Index of the first content-filter step (0-based) or null. */
  firstContentFilterAt: number | null;
  /** Number of tool_use events. */
  toolCount: number;
  /** Tool name -> count. */
  toolBreakdown: Record<string, number>;
  /** Ordered list of tools used (for transcript). */
  toolSequence: Array<{ tool: string; status: string; summary?: string }>;
  /** Non-synthetic assistant text chunks. */
  assistantTextCount: number;
  /** Combined length of all non-synthetic assistant text. */
  assistantTextBytes: number;
  /** Last non-synthetic assistant text (trimmed, head-capped for convenience). */
  lastAssistantText: string;
  /** Session ID seen in events (for follow-up chats). */
  sessionId: string | null;
  /** True if tool-loop heuristic triggers (many steps, no final text, no stop reason). */
  toolLoopSuspected: boolean;
}

export interface DerivedStatusResult {
  status: DerivedStatus;
  reasons: string[];
}

/** Hard cap on stdout.jsonl bytes loaded into memory for analysis. */
const MAX_STDOUT_BYTES = 50 * 1024 * 1024;

export async function analyzeStdout(stdoutFile: string): Promise<RunAnalysis> {
  let raw = "";
  try {
    const st = await stat(stdoutFile);
    if (st.size > MAX_STDOUT_BYTES) {
      // Read only the tail to avoid OOM on pathological logs. We lose early
      // events (which would skew step counts), so callers should treat the
      // analysis as best-effort. The first newline is dropped to align lines.
      const fh = await open(stdoutFile, "r");
      try {
        const buf = Buffer.alloc(MAX_STDOUT_BYTES);
        await fh.read(buf, 0, MAX_STDOUT_BYTES, st.size - MAX_STDOUT_BYTES);
        raw = buf.toString("utf8");
        const nl = raw.indexOf("\n");
        if (nl >= 0) raw = raw.slice(nl + 1);
      } finally {
        await fh.close();
      }
    } else {
      raw = await readFile(stdoutFile, "utf8");
    }
  } catch {
    /* ignore */
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const analysis: RunAnalysis = {
    stepCount: 0,
    finishReasons: [],
    lastFinishReason: null,
    contentFilterHit: false,
    firstContentFilterAt: null,
    toolCount: 0,
    toolBreakdown: {},
    toolSequence: [],
    assistantTextCount: 0,
    assistantTextBytes: 0,
    lastAssistantText: "",
    sessionId: null,
    toolLoopSuspected: false,
  };

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const part = (obj.part as Record<string, unknown> | undefined) ?? {};
    if (!analysis.sessionId && typeof obj.sessionID === "string") {
      analysis.sessionId = obj.sessionID;
    }

    if (part.type === "step-finish") {
      const reason = typeof part.reason === "string" ? part.reason : "";
      analysis.stepCount += 1;
      analysis.finishReasons.push(reason);
      analysis.lastFinishReason = reason;
      if (reason === "content-filter") {
        if (!analysis.contentFilterHit) {
          analysis.firstContentFilterAt = analysis.stepCount - 1;
        }
        analysis.contentFilterHit = true;
      }
    } else if (part.type === "tool") {
      analysis.toolCount += 1;
      const toolName = typeof part.tool === "string" ? part.tool : "?";
      analysis.toolBreakdown[toolName] = (analysis.toolBreakdown[toolName] ?? 0) + 1;
      const state = (part.state as Record<string, unknown> | undefined) ?? {};
      const status = typeof state.status === "string" ? state.status : "?";
      analysis.toolSequence.push({
        tool: toolName,
        status,
        summary: summarizeToolInput(toolName, state),
      });
    } else if (part.type === "text") {
      const text = typeof part.text === "string" ? part.text : "";
      const synthetic = part.synthetic === true;
      if (!synthetic && text.trim().length > 0) {
        analysis.assistantTextCount += 1;
        analysis.assistantTextBytes += text.length;
        analysis.lastAssistantText = text;
      }
    }
  }

  // Tool-loop heuristic: last finish reason is "tool-calls" (not "stop"), stepCount
  // >= 15, and no assistant text produced OR assistant text is trivially small.
  if (
    analysis.lastFinishReason === "tool-calls" &&
    analysis.stepCount >= 15 &&
    (analysis.assistantTextCount === 0 || analysis.assistantTextBytes < 200)
  ) {
    analysis.toolLoopSuspected = true;
  }

  return analysis;
}

function summarizeToolInput(
  toolName: string,
  state: Record<string, unknown>,
): string | undefined {
  const input = state.input as Record<string, unknown> | undefined;
  if (!input) return undefined;
  try {
    // Common shapes: bash { command }, read { filePath }, write { filePath }, edit { filePath }, grep { pattern }
    if (typeof input.command === "string") return trim(input.command, 120);
    if (typeof input.filePath === "string") return input.filePath;
    if (typeof input.path === "string") return input.path;
    if (typeof input.pattern === "string") return `pattern=${trim(input.pattern, 80)}`;
    if (typeof input.url === "string") return input.url;
    const first = Object.entries(input)[0];
    if (first) return `${first[0]}=${trim(String(first[1]), 80)}`;
  } catch {
    /* ignore */
  }
  void toolName;
  return undefined;
}

function trim(s: string, n: number): string {
  if (s.length <= n) return s.replace(/\s+/g, " ");
  return s.slice(0, n).replace(/\s+/g, " ") + "…";
}

export interface DeriveStatusInput {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
  analysis: RunAnalysis;
}

export function deriveStatus(input: DeriveStatusInput): DerivedStatusResult {
  const reasons: string[] = [];

  if (input.spawnError) {
    return { status: "spawn-error", reasons: [input.spawnError] };
  }
  if (input.timedOut) {
    return { status: "timeout", reasons: [`timed out; signal=${input.signal ?? "?"}`] };
  }
  if (input.analysis.contentFilterHit) {
    reasons.push(
      `content-filter at step ${input.analysis.firstContentFilterAt ?? "?"} of ${input.analysis.stepCount}`,
    );
    return { status: "content-filtered", reasons };
  }
  if (input.analysis.toolLoopSuspected) {
    reasons.push(
      `${input.analysis.stepCount} steps, last reason=tool-calls, ${input.analysis.assistantTextBytes} bytes of assistant text`,
    );
    return { status: "tool-loop", reasons };
  }
  if (input.exitCode !== 0 && input.exitCode !== null) {
    reasons.push(`non-zero exit ${input.exitCode}`);
    return { status: "crashed", reasons };
  }
  if (input.signal) {
    reasons.push(`killed by signal ${input.signal}`);
    return { status: "crashed", reasons };
  }
  if (input.analysis.assistantTextCount === 0) {
    return { status: "empty", reasons: ["no non-synthetic assistant text"] };
  }
  if (
    input.analysis.lastFinishReason !== "stop" &&
    input.analysis.lastFinishReason !== null
  ) {
    reasons.push(
      `last finish reason=${input.analysis.lastFinishReason} (expected "stop")`,
    );
    return { status: "incomplete", reasons };
  }
  if (input.analysis.assistantTextBytes < 200) {
    reasons.push(`only ${input.analysis.assistantTextBytes} bytes of assistant text`);
    return { status: "incomplete", reasons };
  }
  return { status: "ok", reasons: [] };
}
