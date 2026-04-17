#!/usr/bin/env node
/**
 * Fake opencode binary used by para-open E2E tests.
 *
 * Behavior is controlled entirely by environment variables so a single binary
 * can simulate every code path. Stdin/stdout match the real `opencode run`
 * contract: write JSONL events to stdout, optional log lines to stderr, exit
 * with the requested code.
 *
 * Supported subcommands:
 *   run [...args] -- <prompt>     Simulate `opencode run`
 *   export <sessionID>            Simulate `opencode export <sid>` (writes JSON)
 *
 * Env vars:
 *   PARAOPEN_FAKE_MODE              ok|tool-loop|content-filter|crash|empty|incomplete|length-cutoff|synth-writes-report|synth-fallback (default: ok)
 *   PARAOPEN_FAKE_EXIT              integer override exit code
 *   PARAOPEN_FAKE_DELAY_MS          sleep this long before exiting (used to test timeouts)
 *   PARAOPEN_FAKE_SESSION_ID        session id to emit (default: ses_fake0001)
 *   PARAOPEN_FAKE_REPORT_TEXT       contents to write to report.md when mode=synth-writes-report
 *   PARAOPEN_FAKE_EXPORT_MALFORMED  if "1", `opencode export` writes invalid JSON
 *   PARAOPEN_FAKE_EXPORT_TEXT       text returned as the latest assistant message
 *   PARAOPEN_FAKE_LOG_FILE          if set, append a "[fake] called argv: ..." entry per invocation
 *   PARAOPEN_FAKE_IGNORE_SIGTERM    if "1", ignore SIGTERM (lets timeout escalate to SIGKILL)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SESSION_ID = process.env.PARAOPEN_FAKE_SESSION_ID || "ses_fake00000000000000000001";
const MODE = process.env.PARAOPEN_FAKE_MODE || "ok";
const DELAY_MS = parseInt(process.env.PARAOPEN_FAKE_DELAY_MS || "0", 10);

if (process.env.PARAOPEN_FAKE_LOG_FILE) {
  try {
    fs.appendFileSync(
      process.env.PARAOPEN_FAKE_LOG_FILE,
      JSON.stringify({
        pid: process.pid,
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        ts: Date.now(),
      }) + "\n",
    );
  } catch {
    // ignore
  }
}

if (process.env.PARAOPEN_FAKE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    /* swallow */
  });
}

function emit(part) {
  process.stdout.write(JSON.stringify({ sessionID: SESSION_ID, part }) + "\n");
}

function findDirArg(argv) {
  const i = argv.indexOf("--dir");
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return process.cwd();
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

async function runSubcommand(argv) {
  // Optional report writer for synth tests
  const dir = findDirArg(argv);
  const writeReport = (text) => {
    try {
      fs.writeFileSync(path.join(dir, "report.md"), text);
    } catch {
      // ignore
    }
  };

  switch (MODE) {
    case "ok": {
      emit({ type: "step-finish", reason: "tool-calls" });
      emit({
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "README.md" } },
      });
      emit({ type: "step-finish", reason: "stop" });
      emit({ type: "text", text: "All done. " + "Lorem ipsum ".repeat(40) });
      break;
    }
    case "tool-loop": {
      // 16 step-finishes ending with tool-calls, no substantive text
      for (let i = 0; i < 16; i++) {
        emit({
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: `echo step ${i}` } },
        });
        emit({ type: "step-finish", reason: "tool-calls" });
      }
      emit({ type: "text", text: "..." });
      break;
    }
    case "content-filter": {
      emit({ type: "step-finish", reason: "tool-calls" });
      emit({ type: "step-finish", reason: "content-filter" });
      emit({ type: "text", text: "I cannot help with that.", synthetic: true });
      break;
    }
    case "crash": {
      emit({ type: "step-finish", reason: "tool-calls" });
      process.stderr.write("[fake] crashing as requested\n");
      await sleep(DELAY_MS);
      process.exit(parseInt(process.env.PARAOPEN_FAKE_EXIT || "1", 10));
      return;
    }
    case "empty": {
      emit({ type: "step-finish", reason: "stop" });
      // No text events at all
      break;
    }
    case "incomplete": {
      emit({ type: "step-finish", reason: "length" });
      emit({ type: "text", text: "Beginning of an answer that got cut off mid-" });
      break;
    }
    case "length-cutoff": {
      emit({ type: "text", text: "Short." });
      emit({ type: "step-finish", reason: "length" });
      break;
    }
    case "synth-writes-report": {
      emit({ type: "step-finish", reason: "tool-calls" });
      emit({
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "report.md" } },
      });
      writeReport(
        process.env.PARAOPEN_FAKE_REPORT_TEXT ||
          "# Synthesis report\n\nWinner: alpha (per fake binary).\n",
      );
      emit({ type: "step-finish", reason: "stop" });
      emit({ type: "text", text: "Wrote report.md. Winner: alpha." });
      break;
    }
    case "synth-fallback": {
      // Synthesizer "forgets" to write report.md; just emits substantive text.
      emit({ type: "step-finish", reason: "stop" });
      emit({
        type: "text",
        text:
          "# Synthesis report\n\nWinner: beta (fallback path).\n" +
          "Lorem ipsum ".repeat(50),
      });
      break;
    }
    default: {
      process.stderr.write(`[fake] unknown PARAOPEN_FAKE_MODE: ${MODE}\n`);
      process.exit(99);
      return;
    }
  }

  await sleep(DELAY_MS);
  process.exit(parseInt(process.env.PARAOPEN_FAKE_EXIT || "0", 10));
}

async function exportSubcommand(_sessionId) {
  if (process.env.PARAOPEN_FAKE_EXPORT_MALFORMED === "1") {
    process.stdout.write("not valid json {{{\n");
    process.exit(0);
    return;
  }
  const text = process.env.PARAOPEN_FAKE_EXPORT_TEXT || "Exported answer text from fake.";
  const payload = {
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "first user msg" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "earlier assistant" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "follow up" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text }] },
    ],
  };
  process.stdout.write(JSON.stringify(payload));
  await sleep(DELAY_MS);
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "run") {
    await runSubcommand(argv.slice(1));
  } else if (argv[0] === "export") {
    await exportSubcommand(argv[1]);
  } else {
    process.stderr.write(`[fake] unknown subcommand: ${argv[0]}\n`);
    process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`[fake] error: ${e.stack || String(e)}\n`);
  process.exit(99);
});
