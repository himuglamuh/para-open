import { spawn } from "node:child_process";
import { writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import * as readline from "node:readline";
import { validateModelsConfig } from "./config.js";
import { log } from "./util.js";

/**
 * `para-open init-models` — bootstrap a models.json from the set of
 * authenticated `opencode` providers.
 *
 * Selection modes (mutually exclusive):
 *   --interactive    arrow-key picker (default if stdin is a TTY)
 *   --all            every authenticated model
 *   --provider <id>  every model from one provider
 *   --filter <glob>  glob-style patterns matched against provider/model-id
 *   --preset <name>  curated set: frontier | cheap | claude-vs-gpt
 *
 * Output:
 *   --out <path>     default ./models.json
 *   --force          overwrite existing file
 *   --stdout         print JSON to stdout, write nothing
 *   --synth <id>     synthesizer override (else auto-pick or interactive prompt)
 */

export interface InitModelsOpts {
  selector:
    | { kind: "interactive" }
    | { kind: "all" }
    | { kind: "provider"; id: string }
    | { kind: "filter"; patterns: string[] }
    | { kind: "preset"; name: string };
  synth: string | null;
  out: string;
  force: boolean;
  stdout: boolean;
  /** Override the binary used to list models. Default: "opencode" on PATH. */
  opencodeBin?: string;
  /** Inject a model list instead of spawning opencode. Used by tests. */
  injectModels?: string[];
  /** Stream for prompts and progress messages. Default: process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Stream the final JSON is written to in --stdout mode. Default: process.stdout. */
  stdoutStream?: NodeJS.WritableStream;
  /** Used by interactive mode. Default: process.stdin. */
  stdinStream?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (m: boolean) => void };
}

// ----------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ----------------------------------------------------------------------------

/**
 * Compile a single glob pattern (* and ? wildcards only, no character
 * classes) into a RegExp that matches the entire input.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re);
}

/** Filter `ids` to those matching at least one of the given glob patterns. */
export function matchGlobs(patterns: string[], ids: string[]): string[] {
  if (patterns.length === 0) return [];
  const res = patterns.map(globToRegExp);
  return ids.filter((id) => res.some((r) => r.test(id)));
}

/**
 * Parse the output of `opencode models` into a list of `provider/model-id`
 * strings. Tolerant of blank lines and surrounding whitespace.
 */
export function parseOpencodeModelsOutput(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.includes("/") && !s.startsWith("{"));
}

/**
 * Resolve a preset name against an available model list. Each preset
 * returns at most one model per family, picked from what's authenticated.
 * Empty result is allowed (the caller decides whether that's an error).
 *
 * Maintenance note: as new model versions ship, the priority lists below
 * will need updating to reflect the new "frontier" or "cheap" choices.
 */
export function resolvePreset(name: string, available: string[]): string[] {
  const lower = available.map((id) => ({ id, lc: id.toLowerCase() }));
  const pickFirst = (...patterns: string[]): string | null => {
    for (const p of patterns) {
      const re = globToRegExp(p.toLowerCase());
      const hit = lower.find(({ lc }) => re.test(lc));
      if (hit) return hit.id;
    }
    return null;
  };

  const picks: (string | null)[] = [];
  switch (name) {
    case "frontier":
      picks.push(pickFirst("*claude-opus-4.7*", "*claude-opus-4.6*", "*claude-opus-4*", "*opus*"));
      picks.push(
        pickFirst("*claude-sonnet-4.6*", "*claude-sonnet-4.5*", "*claude-sonnet-4*", "*sonnet*"),
      );
      picks.push(pickFirst("*gpt-5.4*", "*gpt-5.3*", "*gpt-5.2*", "*gpt-5*", "*gpt-4*"));
      picks.push(pickFirst("*gemini-3*pro*", "*gemini-2.5-pro*", "*gemini*pro*"));
      break;
    case "cheap":
      picks.push(pickFirst("*haiku*"));
      picks.push(pickFirst("*gpt-5-mini*", "*gpt-5*mini*", "*gpt-4*mini*", "*mini*"));
      picks.push(pickFirst("*gemini*flash*", "*flash*"));
      break;
    case "claude-vs-gpt":
      picks.push(pickFirst("*claude-sonnet-4.6*", "*claude-sonnet-4.5*", "*sonnet*", "*claude*"));
      picks.push(pickFirst("*gpt-5.4*", "*gpt-5.2*", "*gpt-5*", "*gpt*"));
      break;
    default:
      throw new Error(
        `unknown preset "${name}". Valid presets: frontier, cheap, claude-vs-gpt`,
      );
  }
  // De-dup, drop nulls, preserve order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of picks) {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Pick a sensible synthesizer when the user didn't specify one. Preference
 * order favors strong frontier models. Returns the first selected model
 * if nothing matches.
 */
export function pickSynthesizerDefault(selected: string[]): string {
  if (selected.length === 0) {
    throw new Error("pickSynthesizerDefault: no models to choose from");
  }
  const prefer = [
    /claude-opus-4\.7/i,
    /claude-opus/i,
    /4\.7/i,
    /claude-sonnet-4\.6/i,
    /claude-sonnet-4\.5/i,
    /sonnet/i,
    /gpt-5\.4/i,
    /gpt-5/i,
  ];
  for (const re of prefer) {
    const hit = selected.find((id) => re.test(id));
    if (hit) return hit;
  }
  return selected[0];
}

/** Build the JSON object that gets written to models.json. */
export function buildModelsConfig(modelIds: string[], synth: string): unknown {
  return {
    synthesizer: synth,
    models: modelIds.map((id) => ({ id })),
  };
}

// ----------------------------------------------------------------------------
// I/O glue
// ----------------------------------------------------------------------------

/** Spawn `opencode models` and return the parsed list of provider/id strings. */
export function listOpencodeModels(opencodeBin = "opencode"): Promise<string[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(opencodeBin, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      rejectPromise(
        new Error(
          `failed to spawn "${opencodeBin} models": ${(err as Error).message}. ` +
            `Is opencode installed and on your PATH?`,
        ),
      );
      return;
    }
    child.stdout?.on("data", (b) => (stdout += String(b)));
    child.stderr?.on("data", (b) => (stderr += String(b)));
    child.on("error", (err) => {
      rejectPromise(
        new Error(
          `failed to run "${opencodeBin} models": ${err.message}. ` +
            `Is opencode installed and on your PATH?`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(
            `"${opencodeBin} models" exited with code ${code}. ` +
              `stderr: ${stderr.trim() || "(empty)"}`,
          ),
        );
        return;
      }
      const ids = parseOpencodeModelsOutput(stdout);
      if (ids.length === 0) {
        rejectPromise(
          new Error(
            `"${opencodeBin} models" returned no models. ` +
              `Run "opencode auth" to authenticate at least one provider first.`,
          ),
        );
        return;
      }
      resolvePromise(ids);
    });
  });
}

// ----------------------------------------------------------------------------
// Interactive picker (node:readline only)
// ----------------------------------------------------------------------------

/**
 * Render an arrow-key checkbox picker. Returns the IDs the user selected.
 * Returns null if the user cancels (Ctrl-C / Esc).
 */
export async function interactivePickModels(
  ids: string[],
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (m: boolean) => void },
  stderr: NodeJS.WritableStream,
): Promise<string[] | null> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error(
      "interactive picker requires a TTY. Use --provider, --filter, --preset, or --all instead.",
    );
  }
  const items = ids.map((id) => ({ id, selected: false }));
  let cursor = 0;

  const render = () => {
    const lines: string[] = [];
    lines.push("Pick models (space to toggle, a = select all, n = none, enter = confirm, q = cancel):");
    for (let i = 0; i < items.length; i++) {
      const marker = items[i].selected ? "[x]" : "[ ]";
      const arrow = i === cursor ? ">" : " ";
      lines.push(`${arrow} ${marker} ${items[i].id}`);
    }
    stderr.write("\x1b[2J\x1b[H"); // clear + home
    stderr.write(lines.join("\n") + "\n");
  };

  return new Promise<string[] | null>((resolvePromise) => {
    stdin.setRawMode!(true);
    stdin.resume();
    readline.emitKeypressEvents(stdin as NodeJS.ReadStream);
    render();

    const cleanup = () => {
      try {
        stdin.setRawMode!(false);
      } catch {
        /* ignore */
      }
      (stdin as NodeJS.ReadStream).removeListener("keypress", onKey);
      stdin.pause();
    };

    const onKey = (
      _str: string,
      key: { name?: string; ctrl?: boolean; sequence?: string },
    ) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolvePromise(null);
        return;
      }
      switch (key.name) {
        case "up":
        case "k":
          cursor = (cursor - 1 + items.length) % items.length;
          render();
          break;
        case "down":
        case "j":
          cursor = (cursor + 1) % items.length;
          render();
          break;
        case "space":
          items[cursor].selected = !items[cursor].selected;
          render();
          break;
        case "a":
          for (const it of items) it.selected = true;
          render();
          break;
        case "n":
          for (const it of items) it.selected = false;
          render();
          break;
        case "q":
        case "escape":
          cleanup();
          resolvePromise(null);
          return;
        case "return":
        case "enter": {
          const picked = items.filter((i) => i.selected).map((i) => i.id);
          if (picked.length === 0) {
            stderr.write("\nSelect at least one model (space), or q to cancel.\n");
            return;
          }
          cleanup();
          resolvePromise(picked);
          return;
        }
      }
    };

    (stdin as NodeJS.ReadStream).on("keypress", onKey);
  });
}

/**
 * After model selection, prompt for the synthesizer choice. Lets the user
 * pick from selected models or escape to type any model id.
 */
export async function interactivePickSynth(
  selected: string[],
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (m: boolean) => void },
  stderr: NodeJS.WritableStream,
): Promise<string | null> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return pickSynthesizerDefault(selected);
  }
  const choices: string[] = [...selected, "<other: type a model id>"];
  let cursor = Math.min(
    selected.indexOf(pickSynthesizerDefault(selected)),
    selected.length - 1,
  );
  if (cursor < 0) cursor = 0;

  const render = () => {
    const lines = ["Pick synthesizer (arrows + enter, q = cancel):"];
    for (let i = 0; i < choices.length; i++) {
      const arrow = i === cursor ? ">" : " ";
      lines.push(`${arrow} ${choices[i]}`);
    }
    stderr.write("\x1b[2J\x1b[H");
    stderr.write(lines.join("\n") + "\n");
  };

  return new Promise<string | null>((resolvePromise) => {
    stdin.setRawMode!(true);
    stdin.resume();
    readline.emitKeypressEvents(stdin as NodeJS.ReadStream);
    render();

    const cleanup = () => {
      try {
        stdin.setRawMode!(false);
      } catch {
        /* ignore */
      }
      (stdin as NodeJS.ReadStream).removeListener("keypress", onKey);
      stdin.pause();
    };

    const onKey = (_s: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolvePromise(null);
        return;
      }
      switch (key.name) {
        case "up":
        case "k":
          cursor = (cursor - 1 + choices.length) % choices.length;
          render();
          break;
        case "down":
        case "j":
          cursor = (cursor + 1) % choices.length;
          render();
          break;
        case "q":
        case "escape":
          cleanup();
          resolvePromise(null);
          return;
        case "return":
        case "enter": {
          const pick = choices[cursor];
          if (pick.startsWith("<other:")) {
            cleanup();
            const rl = readline.createInterface({ input: stdin, output: stderr });
            rl.question("Synthesizer model id: ", (answer) => {
              rl.close();
              const trimmed = answer.trim();
              resolvePromise(trimmed.length > 0 ? trimmed : null);
            });
            return;
          }
          cleanup();
          resolvePromise(pick);
          return;
        }
      }
    };

    (stdin as NodeJS.ReadStream).on("keypress", onKey);
  });
}

// ----------------------------------------------------------------------------
// Top-level entry
// ----------------------------------------------------------------------------

/**
 * Resolve a selector against an available model list. Pure function, used
 * for non-interactive selection modes.
 */
export function applySelector(
  selector: InitModelsOpts["selector"],
  available: string[],
): string[] {
  switch (selector.kind) {
    case "all":
      return [...available];
    case "provider": {
      const prefix = selector.id.endsWith("/") ? selector.id : `${selector.id}/`;
      return available.filter((id) => id.startsWith(prefix));
    }
    case "filter":
      return matchGlobs(selector.patterns, available);
    case "preset":
      return resolvePreset(selector.name, available);
    case "interactive":
      throw new Error("applySelector: interactive must be handled by the caller");
  }
}

export async function runInitModels(opts: InitModelsOpts): Promise<number> {
  const stderr = opts.stderr ?? process.stderr;
  const stdout = opts.stdoutStream ?? process.stdout;
  const stdin = opts.stdinStream ?? (process.stdin as NodeJS.ReadStream);

  // 1. List available models.
  let available: string[];
  try {
    available = opts.injectModels ?? (await listOpencodeModels(opts.opencodeBin));
  } catch (err) {
    log(`error: ${(err as Error).message}`);
    return 2;
  }

  // 2. Apply the selector.
  let selected: string[];
  if (opts.selector.kind === "interactive") {
    const picked = await interactivePickModels(available, stdin, stderr);
    if (picked === null) {
      stderr.write("aborted.\n");
      return 1;
    }
    selected = picked;
  } else {
    try {
      selected = applySelector(opts.selector, available);
    } catch (err) {
      log(`error: ${(err as Error).message}`);
      return 2;
    }
  }

  if (selected.length === 0) {
    log("error: selector matched no authenticated models.");
    log(`available: ${available.join(", ") || "(none)"}`);
    return 1;
  }

  // 3. Resolve synthesizer.
  let synth = opts.synth;
  if (!synth) {
    if (opts.selector.kind === "interactive" && stdin.isTTY) {
      const picked = await interactivePickSynth(selected, stdin, stderr);
      if (!picked) {
        stderr.write("aborted.\n");
        return 1;
      }
      synth = picked;
    } else {
      synth = pickSynthesizerDefault(selected);
      stderr.write(`(auto-picked synthesizer: ${synth}; override with --synth)\n`);
    }
  }

  // 4. Build + validate.
  const config = buildModelsConfig(selected, synth);
  try {
    validateModelsConfig(config, "<generated>");
  } catch (err) {
    log(`internal error: generated config failed validation: ${(err as Error).message}`);
    return 1;
  }
  const json = JSON.stringify(config, null, 2) + "\n";

  // 5. Write or print.
  if (opts.stdout) {
    stdout.write(json);
    return 0;
  }

  const outAbs = resolve(opts.out);
  if (!opts.force) {
    let exists = false;
    try {
      await access(outAbs);
      exists = true;
    } catch {
      /* doesn't exist, fine */
    }
    if (exists) {
      log(`error: ${outAbs} already exists. Use --force to overwrite, or --out to choose another path.`);
      return 1;
    }
  }
  await writeFile(outAbs, json);
  stderr.write(`wrote ${selected.length} model${selected.length === 1 ? "" : "s"} to ${outAbs}\n`);
  return 0;
}

// ----------------------------------------------------------------------------
// Argv parsing (subcommand-local; called from src/index.ts)
// ----------------------------------------------------------------------------

export interface InitModelsCli {
  selector: InitModelsOpts["selector"];
  synth: string | null;
  out: string;
  force: boolean;
  stdout: boolean;
  /** Whether the user explicitly chose interactive (vs. defaulted to it). */
  explicitInteractive: boolean;
}

/**
 * Parse argv tail (everything after the `init-models` subcommand) into an
 * InitModelsCli. Throws on invalid combinations.
 */
export function parseInitModelsArgs(argv: string[]): InitModelsCli {
  let selectorKind: InitModelsOpts["selector"]["kind"] | null = null;
  let providerId: string | null = null;
  const filterPatterns: string[] = [];
  let presetName: string | null = null;
  let synth: string | null = null;
  let out = "./models.json";
  let force = false;
  let stdoutFlag = false;
  let explicitInteractive = false;

  const setSelector = (kind: InitModelsOpts["selector"]["kind"]) => {
    if (selectorKind && selectorKind !== kind) {
      throw new Error(
        `cannot combine --${selectorKind} with --${kind}; pick one selection mode.`,
      );
    }
    selectorKind = kind;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--all":
        setSelector("all");
        break;
      case "--interactive":
        setSelector("interactive");
        explicitInteractive = true;
        break;
      case "--provider": {
        const v = argv[++i];
        if (!v) throw new Error("--provider requires a value");
        setSelector("provider");
        providerId = v;
        break;
      }
      case "--filter": {
        const v = argv[++i];
        if (!v) throw new Error("--filter requires at least one pattern");
        setSelector("filter");
        filterPatterns.push(v);
        // Accept multiple --filter flags or space-separated patterns until the next flag.
        while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
          filterPatterns.push(argv[++i]);
        }
        break;
      }
      case "--preset": {
        const v = argv[++i];
        if (!v) throw new Error("--preset requires a name");
        setSelector("preset");
        presetName = v;
        break;
      }
      case "--synth": {
        const v = argv[++i];
        if (!v) throw new Error("--synth requires a model id");
        synth = v;
        break;
      }
      case "--out": {
        const v = argv[++i];
        if (!v) throw new Error("--out requires a path");
        out = v;
        break;
      }
      case "--force":
        force = true;
        break;
      case "--stdout":
        stdoutFlag = true;
        break;
      default:
        throw new Error(`unknown init-models flag: ${a}`);
    }
  }

  const finalKind = (selectorKind ?? "interactive") as InitModelsOpts["selector"]["kind"];

  let selector: InitModelsOpts["selector"];
  switch (finalKind) {
    case "all":
      selector = { kind: "all" };
      break;
    case "interactive":
      selector = { kind: "interactive" };
      break;
    case "provider":
      selector = { kind: "provider", id: providerId! };
      break;
    case "filter":
      selector = { kind: "filter", patterns: filterPatterns };
      break;
    case "preset":
      selector = { kind: "preset", name: presetName! };
      break;
  }

  return { selector, synth, out, force, stdout: stdoutFlag, explicitInteractive };
}
