/**
 * Braintrust prompts, in two halves:
 *
 * - The codec: `encode` turns a `PromptDefinition` into the body Braintrust stores, `decode` reads a
 *   stored row back, and `nativeFingerprint` tells whether the row was edited in the Braintrust UI
 *   since we wrote it. Pure functions, no requests.
 * - The `PromptRegistry`: get, list, push, delete and labels (Braintrust environments) over HTTP.
 */
import { isDeepStrictEqual } from "node:util";
import {
  ENVELOPE_KEY,
  fingerprint,
  type PromptRegistry,
  packEnvelope,
  type RemotePrompt,
  tagsWithArchiveMarker,
  tagsWithoutArchiveMarker,
  unpackEnvelope,
} from "../../adapter.ts";
import { hashPrompt, type PromptDefinition, type PromptMessage, parsePrompt } from "../../prompt/model.ts";
import { fromOpenAIContent, toOpenAIContent } from "../../prompt/parts.ts";
import { fromOpenAITools, fromResponseFormat, type OpenAITool, PlatformError, toOpenAITools, toResponseFormat } from "../shared.ts";
import type { BraintrustContext, ErrorFactory } from "./context.ts";

/** The parts of a Braintrust prompt row this adapter reads and writes. */
interface Row {
  id: string;
  _xact_id: string;
  name: string;
  slug: string;
  description?: string | null;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
  prompt_data?: {
    prompt?:
      | { type: "chat"; messages: { role: string; content: unknown }[]; tools?: string | null }
      | { type: "completion"; content: string }
      | { type: string };
    options?: { model?: string; params?: Record<string, unknown> } | null;
    template_format?: string | null;
  } | null;
}

/** What we send to create a prompt version. */
type Body = Pick<Row, "name" | "slug" | "prompt_data"> & {
  description: string;
  tags: string[];
  metadata: Record<string, unknown>;
};

/** What `decode` needs: a row from the API, or a body we are about to send. */
type Stored = Pick<Row, "name" | "slug" | "description" | "tags" | "metadata" | "prompt_data">;

/** `prompt_data.prompt` with every variant's fields optional, for reading rows we did not write. */
type StoredPrompt = { type?: string; messages?: { role: string; content: unknown }[]; tools?: string | null; content?: string };

/** One environment assignment of a prompt: which version the environment points at. */
interface Assignment {
  object_version: string;
  environment_slug: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

/** Braintrust slugs accept "/" (verified live), so a prompt's slug is its name. */
const toSlug = (name: string) => name;

// ---------------------------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------------------------

/** What the Braintrust UI can change about the body of a prompt: its messages, or its completion text. */
export function nativeFingerprint(prompt: unknown): string {
  const p = prompt as { type?: string; messages?: { role: string; content: unknown }[]; content?: string };
  return fingerprint(p?.type === "chat" ? (p.messages ?? []).map((m) => [m.role, m.content]) : (p?.content ?? null));
}

/**
 * A definition as the body Braintrust stores. Whatever Braintrust cannot hold natively travels in
 * the envelope inside `metadata`; `needsEnvelope` says whether the prompt cannot round-trip without it.
 */
export function encode(def: PromptDefinition): { body: Body; needsEnvelope: boolean } {
  const emulated: (keyof PromptDefinition)[] = [];
  const openaiTools = def.tools ? toOpenAITools(def.tools) : undefined;

  let prompt: NonNullable<Row["prompt_data"]>["prompt"];
  if (def.type === "text") {
    prompt = { type: "completion", content: def.text };
    if (def.tools) emulated.push("tools"); // completion prompts have nowhere to put tools
  } else {
    // Braintrust stores messages in the OpenAI format, attachments included.
    const native = def.messages.flatMap((m) => ("content" in m ? [{ role: m.role, content: toOpenAIContent(m.content) }] : []));
    // No placeholder message type exists; the full list travels in the envelope.
    if (native.length !== def.messages.length) emulated.push("messages" as keyof PromptDefinition);
    prompt = { type: "chat", messages: native, ...(openaiTools ? { tools: JSON.stringify(openaiTools) } : {}) };
  }

  // Braintrust drops parameters the chosen model does not support (e.g. `temperature` on reasoning
  // models), so the intended set also travels in the envelope. See `decode` for how the two are reconciled.
  if (def.model?.params) emulated.push("model");
  if (def.archived) emulated.push("archived");
  const needsEnvelope = emulated.some((key) => key !== "model");
  const envelope = { ...packEnvelope(def, emulated), native: nativeFingerprint(prompt) };
  return {
    needsEnvelope,
    body: {
      name: def.name,
      slug: toSlug(def.name),
      description: def.description ?? "",
      tags: tagsWithArchiveMarker(def),
      prompt_data: { prompt, options: encodeOptions(def), template_format: "mustache" },
      metadata: { ...def.metadata, [ENVELOPE_KEY]: envelope },
    },
  };
}

/** The model id and parameters. The output schema has no field of its own; it is the `response_format` parameter. */
function encodeOptions(def: PromptDefinition): { model?: string; params?: Record<string, unknown> } {
  const params: Record<string, unknown> = { ...def.model?.params };
  if (def.output) params.response_format = toResponseFormat(def.output);
  return {
    ...(def.model ? { model: def.model.id } : {}),
    ...(Object.keys(params).length ? { params } : {}),
  };
}

/**
 * A stored prompt as a definition. Throws (via `error`) when the prompt uses something outside the
 * portable subset, such as a slug that is not a valid name or a message role we do not have.
 */
export function decode(row: Stored, error: ErrorFactory): PromptDefinition {
  // The slug is the identity. A prompt made in the Braintrust UI can have any display name.
  const name = row.slug;
  const fail = (why: string) => error(`braintrust prompt "${row.slug}" is not portable: ${why}`);
  if (!NAME.test(name)) throw fail(`its slug is not lowercase path segments`);

  const prompt = row.prompt_data?.prompt as StoredPrompt | undefined;
  const envelope = unpackEnvelope(row.metadata) as (ReturnType<typeof unpackEnvelope> & { native?: string }) | undefined;
  // Emulated fields are trusted only while the native body is as we wrote it; after a UI edit, the edit wins.
  const emulated = envelope && envelope.native === nativeFingerprint(prompt) ? envelope.fields : {};

  const { [ENVELOPE_KEY]: _, ...userMetadata } = row.metadata ?? {};
  const { response_format, ...params } = row.prompt_data?.options?.params ?? {};
  const { output, other } = fromResponseFormat(response_format);
  // A response format that is not a JSON schema (such as `json_object`) stays an ordinary model parameter.
  if (other) params.response_format = other;
  const model = row.prompt_data?.options?.model;
  const modelParams = reconcileParams(params, model, envelope?.fields.model);

  const nativeTools = prompt?.type === "chat" && prompt.tools ? fromOpenAITools(JSON.parse(prompt.tools) as OpenAITool[]) : undefined;
  const tools = nativeTools ?? emulated.tools;

  const archived = envelope?.fields.archived;
  const tags = tagsWithoutArchiveMarker(row.tags, archived);
  const common = {
    name,
    ...(row.description ? { description: row.description } : {}),
    ...(archived ? { archived } : {}),
    ...(model ? { model: { id: model, ...(Object.keys(modelParams).length ? { params: modelParams } : {}) } } : {}),
    ...(tools ? { tools } : {}),
    ...(output ? { output } : {}),
    ...(tags.length ? { tags } : {}),
    ...(Object.keys(userMetadata).length ? { metadata: userMetadata } : {}),
  };

  // With format "none" Braintrust sends braces literally; here they would become variables.
  if (row.prompt_data?.template_format === "none" && JSON.stringify(prompt).includes("{{")) {
    throw fail('its template format is "none" but the text contains "{{", which would be read as a variable');
  }
  if (prompt?.type === "completion") return parsePrompt({ type: "text", text: prompt.content ?? "", ...common });
  if (prompt?.type !== "chat") throw fail(`unsupported prompt type "${prompt?.type}"`);
  const messages = (emulated as { messages?: PromptMessage[] }).messages ?? decodeMessages(prompt.messages ?? [], fail);
  return parsePrompt({ type: "chat", messages, ...common });
}

/**
 * Choose between the parameters Braintrust stored and the ones we intended (kept in the envelope).
 * If the stored parameters are just the intended ones minus some keys, Braintrust dropped them and the
 * intended set stands. Any changed or added value means someone edited the prompt there, and that wins.
 */
function reconcileParams(
  stored: Record<string, unknown>,
  model: string | undefined,
  intended: PromptDefinition["model"],
): Record<string, unknown> {
  const untouched =
    intended?.params && intended.id === model && Object.entries(stored).every(([k, v]) => isDeepStrictEqual(intended.params![k], v));
  return untouched ? intended.params! : stored;
}

/** Native (OpenAI-format) chat messages as ours. `fail` builds the "not portable" error for a role or content we cannot hold. */
function decodeMessages(native: { role: string; content: unknown }[], fail: (why: string) => Error): PromptMessage[] {
  return native.map((m) => {
    if (m.role !== "system" && m.role !== "user" && m.role !== "assistant") throw fail(`role "${m.role}"`);
    try {
      return { role: m.role, content: fromOpenAIContent(m.content) };
    } catch (error) {
      throw fail((error as Error).message);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/** The `PromptRegistry` for this adapter's project. */
export function createPromptRegistry(context: BraintrustContext): PromptRegistry {
  return {
    capabilities: {
      labels: "native", // Braintrust environments; they must already exist in the org
      textPrompts: "native",
      placeholders: "emulated",
      modelConfig: "native",
      tools: "native",
      outputSchema: "native",
      tags: "native",
      metadata: "native",
      description: "native",
      nestedNames: "native",
      archived: "emulated",
    },
    async get(ref) {
      const row = await fetchRow(context, ref.name, ref.version ? { version: ref.version } : ref.label ? { environment: ref.label } : {});
      return row ? toRemote(context, row) : null;
    },
    list: () => listPrompts(context),
    push: (definition, options) => pushPrompt(context, definition, options?.labels ?? []),
    async delete(name) {
      const row = await fetchRow(context, name, {});
      if (row) await context.http.request("DELETE", `/v1/prompt/${row.id}`);
    },
    setLabels: (name, version, labels) => setLabels(context, name, version, labels),
  };
}

/** One version of a prompt: the given version, the one an environment points at, or the latest. Undefined if there is none. */
async function fetchRow(
  { http, projectId }: BraintrustContext,
  name: string,
  selector: { version?: string; environment?: string },
): Promise<Row | undefined> {
  let found: { objects: Row[] };
  try {
    found = await http.expect<{ objects: Row[] }>("GET", "/v1/prompt", {
      query: { project_id: await projectId(), slug: toSlug(name), ...selector },
    });
  } catch (error) {
    // An existing prompt with nothing assigned to the requested environment is a 404, not an empty list.
    if (selector.environment && error instanceof PlatformError && error.status === 404) return undefined;
    throw error;
  }
  return found.objects[0];
}

/** Environment assignments live outside the prompt row (and outside the published OpenAPI spec). */
async function assignments({ http }: BraintrustContext, promptId: string): Promise<Assignment[]> {
  return (await http.expect<{ objects: Assignment[] }>("GET", `/environment-object/prompt/${promptId}`)).objects;
}

/** A row as a `RemotePrompt`: decoded, with the environments that point at this exact version as its labels. */
async function toRemote(context: BraintrustContext, row: Row): Promise<RemotePrompt> {
  return {
    definition: decode(row, context.error),
    version: row._xact_id,
    labels: (await assignments(context, row.id)).filter((a) => a.object_version === row._xact_id).map((a) => a.environment_slug),
  };
}

/** Every prompt in the project whose slug is a portable name, with all environments assigned to any of its versions. */
async function listPrompts(context: BraintrustContext): Promise<{ name: string; labels: string[] }[]> {
  const out: { name: string; labels: string[] }[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await context.http.expect<{ objects: Row[] }>("GET", "/v1/prompt", {
      query: { project_id: await context.projectId(), limit: "100", starting_after: after },
    });
    const named = page.objects.map((row) => ({ row, name: row.slug })).filter(({ name }) => NAME.test(name));
    const labels = await Promise.all(named.map(({ row }) => assignments(context, row.id)));
    for (const [i, { name }] of named.entries()) out.push({ name, labels: labels[i]!.map((a) => a.environment_slug) });
    after = page.objects.at(-1)?.id;
    if (page.objects.length < 100 || !after) return out;
  }
}

/** Create a new version, or return the current one (moving `labels` to it) when the content is unchanged. */
async function pushPrompt(context: BraintrustContext, definition: PromptDefinition, labels: string[]): Promise<RemotePrompt> {
  const { http, error } = context;
  const def = parsePrompt(definition);
  const { body, needsEnvelope } = encode(def);

  // Compare what the platform would give back, so encoding normalisations never cause phantom versions.
  const current = await fetchRow(context, def.name, {});
  if (current && hashPrompt(decode(current, error)) === hashPrompt(decode(body, error))) {
    if (labels.length) await setLabels(context, def.name, current._xact_id, labels);
    return toRemote(context, current);
  }

  // Re-posting an existing slug appends a version.
  const row = await http.expect<Row>("POST", "/v1/prompt", {
    body: { project_id: await context.projectId(), ...body, ...(labels.length ? { environment_slugs: labels } : {}) },
  });
  if (needsEnvelope && !unpackEnvelope(row.metadata)) {
    throw error(
      `braintrust: version ${row._xact_id} of "${def.name}" was created, but Braintrust did not keep the metadata ` +
        `this prompt needs (placeholders, or tools on a text prompt). It will not round-trip.`,
    );
  }
  return { definition: decode(row, error), version: row._xact_id, labels };
}

/** Point each label (a Braintrust environment, which must already exist) at `version`. */
async function setLabels(context: BraintrustContext, name: string, version: string, labels: string[]): Promise<void> {
  const row = await fetchRow(context, name, { version });
  if (!row) throw context.error(`braintrust: no version ${version} of "${name}"`);
  for (const label of labels) {
    await context.http.request("PUT", `/environment-object/prompt/${row.id}/${encodeURIComponent(label)}`, {
      body: { object_version: version },
    });
  }
}
