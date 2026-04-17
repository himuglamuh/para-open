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

export async function loadConfig(path: string): Promise<ResolvedConfig> {
  const abs = resolve(path);
  let raw: RawConfig;
  try {
    const text = await readFile(abs, "utf8");
    raw = JSON.parse(text) as RawConfig;
  } catch (err) {
    throw new Error(`Failed to read models config at ${abs}: ${(err as Error).message}`);
  }
  if (!raw || !Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error(`Models config at ${abs} must contain a non-empty "models" array.`);
  }

  const seenLabels = new Set<string>();
  const models: ModelEntry[] = raw.models.map((m, i) => {
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
    synthesizer: raw.synthesizer ?? DEFAULT_SYNTH,
    models,
  };
}
