import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import { parsePrompt, promptFileSchema, type PromptDefinition } from "./model.ts";

/**
 * One prompt per file: `<promptsDir>/support/triage.prompt.yaml` is the prompt
 * "support/triage". The name comes from the path and is never repeated inside
 * the file; `type` is inferred from whether the file has `messages` or `text`.
 */
export const PROMPT_EXTENSION = ".prompt.yaml";
/** Written at the root of the prompts directory; prompt files point their editor at it. */
export const SCHEMA_FILE = "prompt.schema.json";

/** Fixed key order so files diff cleanly whoever wrote them. */
const KEY_ORDER = ["description", "archived", "model", "messages", "text", "tools", "output", "tags", "metadata"] as const;

export function parsePromptFile(source: string, name: string): PromptDefinition {
  const raw = parse(source) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`prompt "${name}": file must be a YAML mapping`);
  }
  if ("name" in raw || "type" in raw) {
    throw new Error(`prompt "${name}": "name" and "type" are derived from the file, remove them`);
  }
  const type = "messages" in raw ? "chat" : "text";
  return parsePrompt({ ...raw, name, type });
}

export function stringifyPrompt(definition: PromptDefinition): string {
  const source = definition as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (source[key] !== undefined) ordered[key] = source[key];
  return stringify(ordered, { lineWidth: 0 });
}

export function promptPath(dir: string, name: string): string {
  return join(dir, ...name.split("/")) + PROMPT_EXTENSION;
}

/** Every prompt under `dir`, sorted by name. A missing directory is an empty set. */
export async function loadPrompts(dir: string): Promise<PromptDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = entries.filter((f) => f.endsWith(PROMPT_EXTENSION)).sort();
  return Promise.all(
    files.map(async (file) => {
      const name = file.slice(0, -PROMPT_EXTENSION.length).split(sep).join("/");
      return parsePromptFile(await readFile(join(dir, file), "utf8"), name);
    }),
  );
}

/** Write (or refresh) the JSON Schema that gives editors validation and autocomplete for prompt files. */
export async function writePromptSchema(dir: string): Promise<string> {
  const path = join(dir, SCHEMA_FILE);
  const content = JSON.stringify(promptFileSchema, null, 2) + "\n";
  await mkdir(dir, { recursive: true });
  if ((await readFile(path, "utf8").catch(() => "")) !== content) await writeFile(path, content);
  return path;
}

/**
 * Write a prompt to its file. The first line is a comment the YAML language server reads to find
 * the schema, so the file validates and autocompletes in editors with no setup.
 */
export async function writePrompt(dir: string, definition: PromptDefinition): Promise<string> {
  const path = promptPath(dir, definition.name);
  await mkdir(dirname(path), { recursive: true });
  const schema = relative(dirname(path), await writePromptSchema(dir)).split(sep).join("/");
  await writeFile(path, `# yaml-language-server: $schema=${schema}\n${stringifyPrompt(definition)}`);
  return path;
}
