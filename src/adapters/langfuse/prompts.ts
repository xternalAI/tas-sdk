/**
 * Prompts on Langfuse, in two halves:
 *
 * - the codec: `encode` turns a prompt definition into the body Langfuse stores, `decode` reads a
 *   stored version back. Everything about how a prompt is represented in Langfuse is here.
 * - the registry: `promptRegistry` implements get, list, push, delete and labels over the public API.
 */
import {
  ENVELOPE_KEY,
  type Envelope,
  fingerprint,
  type PromptCapabilities,
  type PromptRegistry,
  type PushOptions,
  packEnvelope,
  type RemotePrompt,
  tagsWithArchiveMarker,
  tagsWithoutArchiveMarker,
  unpackEnvelope,
} from "../../adapter.ts";
import { hasAttachments, hashPrompt, PROMPT_NAME, type PromptDefinition, type PromptMessage, parsePrompt } from "../../prompt/model.ts";
import { textOnly } from "../../prompt/parts.ts";
import { fromOpenAITools, fromResponseFormat, type Http, type OpenAITool, toOpenAITools, toResponseFormat } from "../shared.ts";
import { allPages, type LangfuseContext } from "./context.ts";
import { LangfuseError } from "./error.ts";

/** A chat prompt's messages as Langfuse stores them. */
type StoredMessages = ({ role: string; content: unknown; type?: string } | { type: "placeholder"; name: string })[];

/** A Langfuse prompt version as the public API returns it. */
interface Row {
  name: string;
  version: number;
  type: "text" | "chat";
  prompt: string | StoredMessages;
  config?: Record<string, unknown> | null;
  labels?: string[];
  tags?: string[];
  /** Present when the prompt includes other prompts by reference; `prompt` is then the expanded text. */
  resolutionGraph?: unknown;
}

/** What is sent to create a version. */
type Body = Pick<Row, "name" | "type" | "prompt"> & { config: Record<string, unknown>; tags: string[] };

/** Maintained by Langfuse itself on the newest version; not a label a user can move. */
const LATEST = "latest";
/**
 * Langfuse has one free-form `config` object per version and nothing else, so it holds the model
 * settings (flat, OpenAI-style, which is what the Langfuse playground reads) and the envelope.
 * Config keys found on a prompt that names no model have no canonical home; they are carried in
 * metadata under this key and written back verbatim.
 */
const ORPHAN_CONFIG = "langfuse.config";

// ---------------------------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------------------------

/** The body that stores `def` as a Langfuse prompt version. */
export function encode(def: PromptDefinition): Body {
  const prompt = encodeBody(def);
  return {
    name: def.name,
    type: def.type,
    prompt,
    config: encodeConfig(def, prompt),
    tags: tagsWithArchiveMarker(def),
  };
}

/** The native text or message list. */
function encodeBody(def: PromptDefinition): Body["prompt"] {
  // Langfuse messages hold text only. A prompt with attachments is stored as its text, with a marker
  // where each attachment goes, and the real messages travel in the envelope.
  return def.type === "text"
    ? def.text
    : def.messages.map((m) =>
        "placeholder" in m ? { type: "placeholder" as const, name: m.placeholder } : { role: m.role, content: textOnly(m.content) },
      );
}

/**
 * The `config` object: model settings, tools and output schema in OpenAI layout, plus the envelope.
 * `prompt` is the native body it travels with; its fingerprint goes in the envelope.
 */
function encodeConfig(def: PromptDefinition, prompt: Body["prompt"]): Record<string, unknown> {
  const { [ORPHAN_CONFIG]: orphan, ...metadata } = def.metadata ?? {};
  const envelopeSource = { ...def, ...(Object.keys(metadata).length ? { metadata } : { metadata: undefined }) };
  const emulated: (keyof PromptDefinition)[] = ["description", "metadata", "archived", "tags"];
  if (hasAttachments(def)) emulated.push("messages" as keyof PromptDefinition);
  return {
    ...(orphan as Record<string, unknown> | undefined),
    ...def.model?.params,
    ...(def.model ? { model: def.model.id } : {}),
    ...(def.tools ? { tools: toOpenAITools(def.tools) } : {}),
    ...(def.output ? { response_format: toResponseFormat(def.output) } : {}),
    // Description and metadata have no native field on a Langfuse prompt.
    [ENVELOPE_KEY]: { ...packEnvelope(envelopeSource as PromptDefinition, emulated), native: fingerprint(prompt) },
  };
}

/** The prompt definition a stored version stands for. Throws `LangfuseError` if it is not portable. */
export function decode(row: Pick<Row, "name" | "type" | "prompt" | "config" | "tags" | "labels">): PromptDefinition {
  const fail = (why: string) => new LangfuseError(`langfuse prompt "${row.name}" is not portable: ${why}`);
  if (!PROMPT_NAME.test(row.name)) throw fail("its name is not lowercase path segments");

  const envelope = unpackEnvelope(row.config);
  const { model, tools, output, rest } = decodeConfig(row.config);
  const hasRest = Object.keys(rest).length > 0;
  const metadata = {
    ...envelope?.fields.metadata,
    ...(typeof model !== "string" && hasRest ? { [ORPHAN_CONFIG]: rest } : {}),
  };
  const tags = decodeTags(row, envelope);
  const common = {
    name: row.name,
    ...(envelope?.fields.description ? { description: envelope.fields.description } : {}),
    ...(envelope?.fields.archived ? { archived: true as const } : {}),
    ...(typeof model === "string" ? { model: { id: model, ...(hasRest ? { params: rest } : {}) } } : {}),
    ...(tools ? { tools } : {}),
    ...(output ? { output } : {}),
    ...(tags.length ? { tags } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };

  if (row.type === "text") {
    if (typeof row.prompt !== "string") throw fail("text prompt body is not a string");
    return parsePrompt({ type: "text", text: row.prompt, ...common });
  }
  if (!Array.isArray(row.prompt)) throw fail("chat prompt body is not a message list");
  return parsePrompt({ type: "chat", messages: decodeMessages(row.prompt, envelope, fail), ...common });
}

/**
 * Take a stored `config` apart: the model id, the tools, the output schema, and `rest`, which is
 * every other key (the model's parameters). A `response_format` that is not a JSON schema is not
 * an output contract and stays in `rest`.
 */
function decodeConfig(config: Row["config"]) {
  const { [ENVELOPE_KEY]: _, model, tools, response_format, ...rest } = config ?? {};
  const { output, other } = fromResponseFormat(response_format);
  if (other) rest.response_format = other;
  // `config` is free-form, so someone may have put something else under "tools". It is not a tool
  // list, but it is theirs: keep it with the other settings rather than drop it.
  if (tools !== undefined && !Array.isArray(tools)) rest.tools = tools;
  return { model, tools: Array.isArray(tools) ? fromOpenAITools(tools as OpenAITool[]) : undefined, output, rest };
}

/** The tags of one version. */
function decodeTags(row: Pick<Row, "tags" | "labels">, envelope: Envelope | undefined): string[] {
  // Langfuse keeps one tag list per prompt, shared by every version. The newest version reads that list,
  // so a tag edited in the Langfuse UI is seen; older versions read the copy saved with them.
  const isNewest = !row.labels || row.labels.includes(LATEST);
  return isNewest || !envelope ? tagsWithoutArchiveMarker(row.tags, envelope?.fields.archived) : (envelope.fields.tags ?? []);
}

/** The messages of a chat prompt: the stored text ones, or the envelope's copy when that still matches them. */
function decodeMessages(stored: StoredMessages, envelope: Envelope | undefined, fail: (why: string) => LangfuseError): PromptMessage[] {
  const native = stored.map((m): PromptMessage => {
    if (m.type === "placeholder") return { placeholder: (m as { name: string }).name };
    const { role, content } = m as { role: string; content: unknown };
    if (typeof content !== "string") throw fail("message content is not plain text");
    if (role !== "system" && role !== "user" && role !== "assistant") throw fail(`role "${role}"`);
    return { role, content };
  });
  // Messages with attachments come from the envelope, unless the text was edited in Langfuse since.
  // Langfuse adds a `type` to each stored message, so compare what we wrote, not what it returns.
  const written = native.map((m) => ("placeholder" in m ? { type: "placeholder", name: m.placeholder } : m));
  const kept = (envelope?.fields as { messages?: PromptMessage[] } | undefined)?.messages;
  return kept && envelope?.native === fingerprint(written) ? kept : native;
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

const CAPABILITIES: PromptCapabilities = {
  labels: "native",
  textPrompts: "native",
  placeholders: "native",
  modelConfig: "native",
  tools: "native",
  outputSchema: "native",
  tags: "native", // shared by all versions of a prompt, unlike everything else
  metadata: "emulated",
  description: "emulated",
  nestedNames: "native",
  archived: "emulated",
};

export function promptRegistry({ http }: LangfuseContext): PromptRegistry {
  return {
    capabilities: CAPABILITIES,
    async get(ref) {
      const row = await fetchRow(http, ref);
      return row ? toRemote(row) : null;
    },
    list: () => listPrompts(http),
    push: (definition, options) => pushPrompt(http, definition, options),
    async delete(name) {
      await http.find("DELETE", promptPath(name)); // removes every version; 404 means it was already gone
    },
    setLabels: (name, version, labels) => setLabels(http, name, version, labels),
  };
}

const promptPath = (name: string) => `/v2/prompts/${encodeURIComponent(name)}`;

/** Labels without `latest`, which Langfuse manages itself. */
const userLabels = (labels: string[] | undefined) => (labels ?? []).filter((l) => l !== LATEST);

const toRemote = (row: Row): RemotePrompt => ({
  definition: decode(row),
  version: String(row.version),
  labels: userLabels(row.labels),
});

/** One version of a prompt: `version` if given, else the one `label` points at, else the newest. Undefined if there is none. */
function fetchRow(http: Http, ref: { name: string; version?: string; label?: string }): Promise<Row | undefined> {
  return http.find<Row>("GET", promptPath(ref.name), {
    // With no selector Langfuse serves "production"; the contract here is "newest version".
    query: ref.version ? { version: ref.version } : { label: ref.label ?? LATEST },
  });
}

/** Every prompt with a portable name, with the labels in use on it. */
async function listPrompts(http: Http): Promise<{ name: string; labels: string[] }[]> {
  const all = await allPages<{ name: string; labels?: string[] }>(http, "/v2/prompts");
  return all.filter((p) => PROMPT_NAME.test(p.name)).map((p) => ({ name: p.name, labels: userLabels(p.labels) }));
}

/** Create a new version, unless the newest one already holds the same content: then only the labels are moved. */
async function pushPrompt(http: Http, definition: PromptDefinition, options: PushOptions | undefined): Promise<RemotePrompt> {
  const def = parsePrompt(definition);
  const body = encode(def);
  const labels = userLabels(options?.labels);

  // Compare what the platform would give back, so encoding normalisations never cause phantom versions.
  const current = await fetchRow(http, { name: def.name });
  if (current && hashPrompt(decode(current)) === hashPrompt(decode(body))) {
    if (labels.length) await setLabels(http, def.name, String(current.version), labels);
    return { ...toRemote(current), labels: [...new Set([...userLabels(current.labels), ...labels])] };
  }
  if (current) assertReplaceable(current, def, options?.force);
  return toRemote(await http.expect<Row>("POST", "/v2/prompts", { body: { ...body, labels } }));
}

/** Refuse a push that Langfuse would reject, or that would silently lose something held there. */
function assertReplaceable(current: Row, def: PromptDefinition, force: boolean | undefined): void {
  // Langfuse returns such a prompt with its references already expanded, so what we hold is a copy.
  if (current.resolutionGraph && !force) {
    throw new LangfuseError(
      `langfuse: "${def.name}" includes other prompts by reference in Langfuse. Pushing would replace those references ` +
        `with a copy of their current text. Edit it in Langfuse, or push with force to accept that.`,
    );
  }
  if (current.type !== def.type) {
    throw new LangfuseError(
      `langfuse: "${def.name}" is a ${current.type} prompt there and cannot become a ${def.type} prompt; Langfuse fixes the type at creation.`,
    );
  }
}

/** Point `labels` at `version`, keeping the labels that version already has. */
async function setLabels(http: Http, name: string, version: string, labels: string[]): Promise<void> {
  const row = await fetchRow(http, { name, version });
  if (!row) throw new LangfuseError(`langfuse: no version ${version} of "${name}"`);
  // Sent as the full set, so the result is the same whether Langfuse adds to or replaces a version's labels.
  const newLabels = [...new Set([...userLabels(row.labels), ...userLabels(labels)])];
  const updated = await http.find("PATCH", `${promptPath(name)}/versions/${version}`, { body: { newLabels } });
  if (!updated) throw new LangfuseError(`langfuse: no version ${version} of "${name}"`);
}
