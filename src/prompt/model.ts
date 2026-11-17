import { createHash } from "node:crypto";
import Type from "typebox";
import { Value } from "typebox/value";

/**
 * The canonical, vendor-neutral prompt. Application code only ever sees this
 * shape; adapters translate it to and from whatever each platform stores.
 *
 * The schemas below are plain JSON Schema objects, so `promptSchema` doubles as
 * the language-neutral spec of the prompt format for SDKs in other languages.
 */

/** Tag mirrored onto an archived prompt on every platform, so it can be filtered in the vendor UI. */
export const ARCHIVED_TAG = "archived";

export const PROMPT_NAME = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

const strict = { additionalProperties: false } as const;
const JsonObject = Type.Record(Type.String(), Type.Unknown());

const Message = Type.Union([
  Type.Object({ role: Type.Enum(["system", "user", "assistant"]), content: Type.String() }, strict),
  // A slot filled at call time with a list of messages (chat history, few-shots).
  Type.Object({ placeholder: Type.String({ minLength: 1 }) }, strict),
]);

const Tool = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    parameters: JsonObject, // JSON Schema for the arguments
  },
  strict,
);

const Model = Type.Object(
  {
    // Model id as the configured gateway expects it, e.g. "gpt-5" or "anthropic/claude-sonnet-5-5".
    id: Type.String({ minLength: 1 }),
    // Sampling and limit parameters, OpenAI-compatible names (temperature, max_tokens, top_p, ...).
    params: Type.Optional(JsonObject),
  },
  strict,
);

const common = {
  // Path-like, lowercase: "support/triage". Adapters map "/" to whatever the platform allows.
  name: Type.String({ pattern: PROMPT_NAME.source }),
  description: Type.Optional(Type.String()),
  // Soft delete: the prompt and its history stay everywhere, but the SDK refuses to serve it.
  // Only `true` is allowed, so "not archived" has exactly one spelling: the key is absent.
  archived: Type.Optional(Type.Literal(true)),
  model: Type.Optional(Model),
  tools: Type.Optional(Type.Array(Tool)),
  // Structured output contract.
  output: Type.Optional(
    Type.Object({ name: Type.Optional(Type.String()), schema: JsonObject, strict: Type.Optional(Type.Boolean()) }, strict),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
  // Free-form user metadata. Never used by the SDK itself.
  metadata: Type.Optional(JsonObject),
};

const ChatPrompt = Type.Object({ type: Type.Literal("chat"), messages: Type.Array(Message, { minItems: 1 }), ...common }, strict);
const TextPrompt = Type.Object({ type: Type.Literal("text"), text: Type.String(), ...common }, strict);

/** JSON Schema of a prompt definition. */
export const promptSchema = Type.Union([ChatPrompt, TextPrompt]);

export type PromptMessage = Type.Static<typeof Message>;
export type PromptTool = Type.Static<typeof Tool>;
export type PromptModel = Type.Static<typeof Model>;
export type PromptDefinition = Type.Static<typeof promptSchema>;

export class PromptValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid prompt: ${issues.join("; ")}`);
    this.issues = issues;
  }
}

/**
 * Validates untrusted input (a YAML file, a platform response). Unknown keys
 * are errors, so a typo like `mesages` is caught instead of silently ignored.
 */
export function parsePrompt(input: unknown): PromptDefinition {
  const type = (input as { type?: unknown } | null)?.type;
  if (type !== "chat" && type !== "text") throw new PromptValidationError(['type: must be "chat" or "text"']);
  // Checking the matching branch directly gives precise errors; a failed union only says "no branch matched".
  const schema = type === "chat" ? ChatPrompt : TextPrompt;
  if (Value.Check(schema, input)) {
    // Adapters show archived prompts in the vendor UI by adding this tag, so it cannot also be a user tag.
    if (input.archived && input.tags?.includes(ARCHIVED_TAG)) {
      throw new PromptValidationError([`tags: "${ARCHIVED_TAG}" is added automatically to an archived prompt, remove it`]);
    }
    return input;
  }

  const byPath = new Map<string, string>();
  for (const error of Value.Errors(schema, input)) {
    if (error.keyword === "boolean" || error.keyword === "const") continue; // restated by a clearer sibling error
    // Inside a union, each branch complains about the other branch's keys; the field-level errors say it better.
    if (error.schemaPath.includes("/anyOf/") && (error.keyword === "additionalProperties" || error.keyword === "required")) continue;
    const unknown = (error.params as { additionalProperties?: string[] }).additionalProperties;
    const where = error.instancePath.slice(1).replaceAll("/", ".") || "prompt";
    const what = error.keyword === "pattern" && where === "name"
      ? 'must be lowercase path segments, e.g. "support/triage"'
      : unknown ? `unknown key ${unknown.map((k) => `"${k}"`).join(", ")}` : error.message;
    byPath.set(where, what); // the last error at a path is the outermost, most readable one
  }
  throw new PromptValidationError([...byPath].map(([where, what]) => `${where}: ${what}`));
}

/** How a caller points at a prompt. `version` and `label` are mutually exclusive. */
export interface PromptRef {
  name: string;
  /** Platform-opaque version id (Langfuse number, LangSmith commit hash, Braintrust xact id...). */
  version?: string;
  /** Movable pointer such as "production". Defaults to the client's `defaultLabel`. */
  label?: string;
}

/** A prompt as resolved from somewhere, with enough identity to trace and diff it. */
export interface ResolvedPrompt {
  definition: PromptDefinition;
  /** sha256 of the canonical definition: the one identity that survives a platform switch. */
  hash: string;
  source: "local" | "remote";
  /** Present when it came from a platform. */
  remote?: { platform: string; version: string; labels: string[] };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Stable JSON: key order and undefined fields never change the hash. */
export function canonicalJson(definition: PromptDefinition): string {
  return JSON.stringify(sortKeys(definition));
}

export function hashPrompt(definition: PromptDefinition): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}
