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

// The `description` on each field is what editors show on hover and in autocomplete for prompt
// files, so these double as the user-facing reference for the format.
const Message = Type.Union([
  Type.Object(
    {
      role: Type.Enum(["system", "user", "assistant"], { description: "Who the message is from." }),
      content: Type.String({ description: "Message text. Use {{name}} or {{nested.path}} for variables." }),
    },
    { ...strict, title: "Message" },
  ),
  Type.Object(
    { placeholder: Type.String({ minLength: 1, description: "Name of a slot filled at call time with a list of messages, such as chat history or few-shot examples." }) },
    { ...strict, title: "Placeholder" },
  ),
]);

const Tool = Type.Object(
  {
    name: Type.String({ minLength: 1, description: "Name the model uses to call the tool." }),
    description: Type.Optional(Type.String({ description: "Tells the model when and how to use the tool." })),
    parameters: Type.Record(Type.String(), Type.Unknown(), { description: "JSON Schema for the tool's arguments." }),
  },
  strict,
);

const Model = Type.Object(
  {
    id: Type.String({ minLength: 1, description: 'Model id as your gateway expects it, e.g. "gpt-5" or "anthropic/claude-sonnet-5-5". Map ids per gateway with `gateway.models`.' }),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Sampling and limit settings, using OpenAI names: temperature, max_tokens, top_p, ..." })),
  },
  { ...strict, description: "Which model runs this prompt, and with what settings." },
);

/** Everything a prompt can carry besides its body. Shared by the in-memory definition and the file format. */
const attributes = {
  description: Type.Optional(Type.String({ description: "What this prompt is for." })),
  archived: Type.Optional(
    // Only `true` is allowed, so "not archived" has exactly one spelling: the key is absent.
    Type.Literal(true, { description: "Retire the prompt without deleting it: the SDK refuses to serve it. Remove this line to restore it." }),
  ),
  model: Type.Optional(Model),
  tools: Type.Optional(Type.Array(Tool, { description: "Tools the model may call. Supply the functions when you run the prompt." })),
  output: Type.Optional(
    Type.Object(
      {
        name: Type.Optional(Type.String({ description: "Name for the output format." })),
        schema: Type.Record(Type.String(), Type.Unknown(), { description: "JSON Schema the reply must match." }),
        strict: Type.Optional(Type.Boolean({ description: "Ask the provider to enforce the schema exactly, where supported." })),
      },
      { ...strict, description: "Structured output: the reply is parsed as JSON and validated against this schema." },
    ),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Labels for organising prompts." })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Anything else you want stored with the prompt. Never read by the SDK." })),
};
const messages = Type.Array(Message, { minItems: 1, description: "The conversation template, in order." });
const text = Type.String({ description: "The prompt text, sent as a single user message. Use {{name}} for variables." });
// Path-like, lowercase: "support/triage". In a file this comes from the file's path instead.
const name = Type.String({ pattern: PROMPT_NAME.source });

const ChatPrompt = Type.Object({ type: Type.Literal("chat"), name, messages, ...attributes }, strict);
const TextPrompt = Type.Object({ type: Type.Literal("text"), name, text, ...attributes }, strict);

/** JSON Schema of a prompt definition. */
export const promptSchema = Type.Union([ChatPrompt, TextPrompt]);

/**
 * JSON Schema of a `*.prompt.yaml` file: the definition without `name` and `type`, which come from
 * the file's path and from whether it has `messages` or `text`. Written next to the prompts by
 * `tas prompts schema` so editors can validate and autocomplete them.
 */
export const promptFileSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Trace and Scale prompt file",
  oneOf: [
    { ...Type.Object({ messages, ...attributes }, strict), title: "Chat prompt" },
    { ...Type.Object({ text, ...attributes }, strict), title: "Text prompt" },
  ],
};

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
