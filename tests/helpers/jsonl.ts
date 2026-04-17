/**
 * Builders for the JSONL event shapes consumed by analyzeStdout. These match
 * the production schema: each line is `{sessionID, part: {...}}`.
 */

export interface JsonlLineOpts {
  sessionID?: string;
}

function line(sessionID: string | undefined, part: Record<string, unknown>): string {
  const obj: Record<string, unknown> = { part };
  if (sessionID) obj.sessionID = sessionID;
  return JSON.stringify(obj);
}

export function stepFinish(reason: string, opts: JsonlLineOpts = {}): string {
  return line(opts.sessionID, { type: "step-finish", reason });
}

export function toolEvent(
  tool: string,
  status: string = "completed",
  input?: Record<string, unknown>,
  opts: JsonlLineOpts = {},
): string {
  const state: Record<string, unknown> = { status };
  if (input !== undefined) state.input = input;
  return line(opts.sessionID, { type: "tool", tool, state });
}

export function textEvent(
  text: string,
  opts: JsonlLineOpts & { synthetic?: boolean } = {},
): string {
  const part: Record<string, unknown> = { type: "text", text };
  if (opts.synthetic) part.synthetic = true;
  return line(opts.sessionID, part);
}

export function rawSession(sessionID: string): string {
  // Produces a line where sessionID is set but no recognized part type.
  return JSON.stringify({ sessionID, part: { type: "ignored" } });
}

/**
 * Build a complete jsonl payload (newline-joined) from a list of events.
 * Adds a trailing newline.
 */
export function jsonl(...lines: string[]): string {
  return lines.join("\n") + "\n";
}
