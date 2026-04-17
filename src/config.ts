import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { slugify } from "./util.js";

export interface ModelEntry {
  id: string;
  label: string;
}

export interface ResolvedConfig {
  synthesizer: string;
  models: ModelEntry[];
}

interface RawConfig {
  synthesizer?: string;
  models: Array<{ id: string; label?: string } | string>;
}

const DEFAULT_SYNTH = "github-copilot/claude-opus-4.7";

/**
 * Validate and normalize a parsed models-config object. Pure (no I/O); used
 * by both loadConfig (after JSON.parse) and init-models (to verify generated
 * configs before writing them to disk).
 *
 * `source` is a human-readable label included in error messages so callers
 * can identify the origin (file path, "<generated>", etc.).
 */
export function validateModelsConfig(raw: unknown, source = "<config>"): ResolvedConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Models config at ${source} must be a JSON object.`);
  }
  const r = raw as RawConfig;
  if (!Array.isArray(r.models) || r.models.length === 0) {
    throw new Error(`Models config at ${source} must contain a non-empty "models" array.`);
  }

  const seenLabels = new Set<string>();
  const models: ModelEntry[] = r.models.map((m, i) => {
    const id = typeof m === "string" ? m : m.id;
    if (!id || typeof id !== "string") {
      throw new Error(`models[${i}] is missing a string "id".`);
    }
    let label = typeof m === "string" ? slugify(id) : m.label ?? slugify(id);
    if (!label) label = `model-${i}`;
    let unique = label;
    let n = 2;
    while (seenLabels.has(unique)) unique = `${label}-${n++}`;
    seenLabels.add(unique);
    return { id, label: unique };
  });

  return {
    synthesizer: r.synthesizer ?? DEFAULT_SYNTH,
    models,
  };
}

export async function loadConfig(path: string): Promise<ResolvedConfig> {
  const abs = resolve(path);
  let raw: unknown;
  try {
    const text = await readFile(abs, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to read models config at ${abs}: ${(err as Error).message}`);
  }
  return validateModelsConfig(raw, abs);
}
