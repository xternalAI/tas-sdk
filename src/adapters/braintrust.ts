import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ENVELOPE_KEY,
  packEnvelope,
  tagsWithArchiveMarker,
  tagsWithoutArchiveMarker,
  unpackEnvelope,
  type PlatformAdapter,
  type PromptRegistry,
  type RemotePrompt,
} from "../adapter.ts";
import { hashPrompt, parsePrompt, type PromptDefinition, type PromptMessage } from "../prompt/model.ts";

export interface BraintrustOptions {
  /** Passed explicitly, never read from the environment: one process may hold many tenants' keys. */
  apiKey: string;
  /** One of these is required. The adapter never creates projects. */
  projectId?: string;
  projectName?: string;
  /** Default https://api.braintrust.dev (EU: https://api-eu.braintrust.dev). */
  baseURL?: string;
  fetch?: typeof fetch;
}

export class BraintrustError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

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

type NativeMessage = { role: "system" | "user" | "assistant"; content: string };
type Body = Pick<Row, "name" | "slug" | "prompt_data"> & {
  description: string;
  tags: string[];
  metadata: Record<string, unknown>;
};

const NAME = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

/** Braintrust slugs are flat; the canonical name is kept verbatim in the row's `name`. */
const toSlug = (name: string) => name.replaceAll("/", "--");

/** Detects edits made in the Braintrust UI after our push, which make the envelope's emulated fields stale. */
function fingerprint(prompt: unknown): string {
  const p = prompt as { type?: string; messages?: { role: string; content: unknown }[]; content?: string };
  const basis = p?.type === "chat" ? (p.messages ?? []).map((m) => [m.role, m.content]) : (p?.content ?? null);
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}

function encode(def: PromptDefinition): { body: Body; needsEnvelope: boolean } {
  const emulated: (keyof PromptDefinition)[] = [];
  const openaiTools = def.tools?.map((t) => ({
    type: "function",
    function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters },
  }));

  let prompt: NonNullable<Row["prompt_data"]>["prompt"];
  if (def.type === "text") {
    prompt = { type: "completion", content: def.text };
    if (def.tools) emulated.push("tools"); // completion prompts have nowhere to put tools
  } else {
    const native = def.messages.filter((m): m is NativeMessage => "content" in m);
    // No placeholder message type exists; the full list travels in the envelope.
    if (native.length !== def.messages.length) emulated.push("messages" as keyof PromptDefinition);
    prompt = { type: "chat", messages: native, ...(openaiTools ? { tools: JSON.stringify(openaiTools) } : {}) };
  }

  const params: Record<string, unknown> = { ...def.model?.params };
  if (def.output) {
    params.response_format = {
      type: "json_schema",
      json_schema: {
        name: def.output.name ?? "output",
        schema: def.output.schema,
        ...(def.output.strict === undefined ? {} : { strict: def.output.strict }),
      },
    };
  }
  const options = {
    ...(def.model ? { model: def.model.id } : {}),
    ...(Object.keys(params).length ? { params } : {}),
  };

  // Braintrust drops parameters the chosen model does not support (e.g. `temperature` on reasoning
  // models), so the intended set also travels in the envelope. See `decode` for how the two are reconciled.
  if (def.model?.params) emulated.push("model");
  if (def.archived) emulated.push("archived");
  const needsEnvelope = emulated.some((key) => key !== "model");
  const envelope = { ...packEnvelope(def, emulated), native: fingerprint(prompt) };
  return {
    needsEnvelope,
    body: {
      name: def.name,
      slug: toSlug(def.name),
      description: def.description ?? "",
      tags: tagsWithArchiveMarker(def),
      prompt_data: { prompt, options, template_format: "mustache" },
      metadata: { ...def.metadata, [ENVELOPE_KEY]: envelope },
    },
  };
}

function decode(row: Pick<Row, "name" | "slug" | "description" | "tags" | "metadata" | "prompt_data">): PromptDefinition {
  const name = NAME.test(row.name) ? row.name : row.slug;
  const fail = (why: string) => new BraintrustError(`braintrust prompt "${row.slug}" is not portable: ${why}`);
  if (!NAME.test(name)) throw fail(`neither name "${row.name}" nor slug is a valid prompt name`);

  const prompt = row.prompt_data?.prompt as
    | { type?: string; messages?: { role: string; content: unknown }[]; tools?: string | null; content?: string }
    | undefined;
  const envelope = unpackEnvelope(row.metadata) as (ReturnType<typeof unpackEnvelope> & { native?: string }) | undefined;
  const emulated = envelope && envelope.native === fingerprint(prompt) ? envelope.fields : {};

  const { [ENVELOPE_KEY]: _, ...userMetadata } = row.metadata ?? {};
  const { response_format, ...params } = row.prompt_data?.options?.params ?? {};
  const rf = response_format as { type?: string; json_schema?: { name?: string; schema?: unknown; strict?: boolean } } | undefined;
  const structured = rf?.type === "json_schema" ? rf.json_schema : undefined;
  if (rf && !structured) params.response_format = response_format;
  const model = row.prompt_data?.options?.model;
  // If the stored parameters are just the intended ones minus some keys, Braintrust dropped them and the
  // intended set stands. Any changed or added value means someone edited the prompt there, and that wins.
  const intended = envelope?.fields.model;
  const modelParams =
    intended?.params && intended.id === model && Object.entries(params).every(([k, v]) => isDeepStrictEqual(intended.params![k], v))
      ? intended.params
      : params;

  let tools: PromptDefinition["tools"];
  if (prompt?.type === "chat" && prompt.tools) {
    const parsed = JSON.parse(prompt.tools) as { function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
    tools = parsed.map(({ function: f }) => ({
      name: f.name,
      ...(f.description ? { description: f.description } : {}),
      parameters: f.parameters ?? {},
    }));
  }
  tools = tools?.length ? tools : emulated.tools;

  const archived = envelope?.fields.archived;
  const tags = tagsWithoutArchiveMarker(row.tags, archived);
  const common = {
    name,
    ...(row.description ? { description: row.description } : {}),
    ...(archived ? { archived } : {}),
    ...(model ? { model: { id: model, ...(Object.keys(modelParams).length ? { params: modelParams } : {}) } } : {}),
    ...(tools ? { tools } : {}),
    ...(structured
      ? {
          output: {
            ...(structured.name && structured.name !== "output" ? { name: structured.name } : {}),
            schema: structured.schema ?? {},
            ...(structured.strict === undefined ? {} : { strict: structured.strict }),
          },
        }
      : {}),
    ...(tags.length ? { tags } : {}),
    ...(Object.keys(userMetadata).length ? { metadata: userMetadata } : {}),
  };

  // With format "none" Braintrust sends braces literally; here they would become variables.
  if (row.prompt_data?.template_format === "none" && JSON.stringify(prompt).includes("{{")) {
    throw fail('its template format is "none" but the text contains "{{", which would be read as a variable');
  }
  if (prompt?.type === "completion") return parsePrompt({ type: "text", text: prompt.content ?? "", ...common });
  if (prompt?.type !== "chat") throw fail(`unsupported prompt type "${prompt?.type}"`);
  const messages: PromptMessage[] =
    (emulated as { messages?: PromptMessage[] }).messages ??
    (prompt.messages ?? []).map((m) => {
      if (typeof m.content !== "string") throw fail("message content is not plain text");
      if (m.role !== "system" && m.role !== "user" && m.role !== "assistant") throw fail(`role "${m.role}"`);
      return { role: m.role, content: m.content };
    });
  return parsePrompt({ type: "chat", messages, ...common });
}

export function braintrust(options: BraintrustOptions): PlatformAdapter {
  const baseURL = (options.baseURL ?? "https://api.braintrust.dev").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;

  async function request<T>(method: string, path: string, init: { query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(baseURL + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const response = await doFetch(url, {
      method,
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new BraintrustError(`braintrust ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`, response.status);
    }
    const body = await response.text(); // deletes answer with an empty body on some platforms
    return (body ? JSON.parse(body) : undefined) as T;
  }

  let project: Promise<string> | undefined;
  const projectId = () =>
    (project ??= (async () => {
      if (options.projectId) return options.projectId;
      if (!options.projectName) throw new BraintrustError("braintrust: set projectId or projectName");
      const found = await request<{ objects: { id: string }[] }>("GET", "/v1/project", {
        query: { project_name: options.projectName },
      });
      const id = found.objects[0]?.id;
      if (!id) {
        throw new BraintrustError(
          `braintrust: project "${options.projectName}" not found. Create it in Braintrust first; this adapter never creates projects.`,
        );
      }
      return id;
    })());

  const fetchRow = async (name: string, selector: { version?: string; environment?: string }): Promise<Row | undefined> => {
    let found: { objects: Row[] };
    try {
      found = await request<{ objects: Row[] }>("GET", "/v1/prompt", {
        query: { project_id: await projectId(), slug: toSlug(name), ...selector },
      });
    } catch (error) {
      // An existing prompt with nothing assigned to the requested environment is a 404, not an empty list.
      if (selector.environment && error instanceof BraintrustError && error.status === 404) return undefined;
      throw error;
    }
    const row = found.objects[0];
    // "a/b" and "a--b" share a slug; the stored name tells them apart.
    return row && (!NAME.test(row.name) || row.name === name) ? row : undefined;
  };

  /** Environment assignments live outside the prompt row (and outside the published OpenAPI spec). */
  const assignments = async (promptId: string) =>
    (
      await request<{ objects: { object_version: string; environment_slug: string }[] }>(
        "GET",
        `/environment-object/prompt/${promptId}`,
      )
    ).objects;

  const toRemote = async (row: Row): Promise<RemotePrompt> => ({
    definition: decode(row),
    version: row._xact_id,
    labels: (await assignments(row.id)).filter((a) => a.object_version === row._xact_id).map((a) => a.environment_slug),
  });

  const prompts: PromptRegistry = {
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
      nestedNames: "emulated",
      archived: "emulated",
    },

    async get(ref) {
      const row = await fetchRow(
        ref.name,
        ref.version ? { version: ref.version } : ref.label ? { environment: ref.label } : {},
      );
      return row ? toRemote(row) : null;
    },

    async list() {
      const out: { name: string; labels: string[] }[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await request<{ objects: Row[] }>("GET", "/v1/prompt", {
          query: { project_id: await projectId(), limit: "100", starting_after: after },
        });
        const named = page.objects
          .map((row) => ({ row, name: NAME.test(row.name) ? row.name : row.slug }))
          .filter(({ name }) => NAME.test(name));
        const labels = await Promise.all(named.map(({ row }) => assignments(row.id)));
        named.forEach(({ name }, i) => out.push({ name, labels: labels[i]!.map((a) => a.environment_slug) }));
        after = page.objects.at(-1)?.id;
        if (page.objects.length < 100 || !after) return out;
      }
    },

    async push(definition, pushOptions) {
      const def = parsePrompt(definition);
      const { body, needsEnvelope } = encode(def);
      const labels = pushOptions?.labels ?? [];

      // Compare what the platform would give back, so encoding normalisations never cause phantom versions.
      const current = await fetchRow(def.name, {});
      if (current && hashPrompt(decode(current)) === hashPrompt(decode(body))) {
        if (labels.length) await prompts.setLabels(def.name, current._xact_id, labels);
        return toRemote(current);
      }

      // Re-posting an existing slug appends a version.
      const row = await request<Row>("POST", "/v1/prompt", {
        body: { project_id: await projectId(), ...body, ...(labels.length ? { environment_slugs: labels } : {}) },
      });
      if (needsEnvelope && !unpackEnvelope(row.metadata)) {
        throw new BraintrustError(
          `braintrust: version ${row._xact_id} of "${def.name}" was created, but Braintrust did not keep the metadata ` +
            `this prompt needs (placeholders, or tools on a text prompt). It will not round-trip.`,
        );
      }
      return { definition: decode(row), version: row._xact_id, labels };
    },

    async delete(name) {
      const row = await fetchRow(name, {});
      if (row) await request("DELETE", `/v1/prompt/${row.id}`);
    },

    async setLabels(name, version, labels) {
      const row = await fetchRow(name, { version });
      if (!row) throw new BraintrustError(`braintrust: no version ${version} of "${name}"`);
      for (const label of labels) {
        await request("PUT", `/environment-object/prompt/${row.id}/${encodeURIComponent(label)}`, {
          body: { object_version: version },
        });
      }
    },
  };

  return { id: "braintrust", prompts };
}
