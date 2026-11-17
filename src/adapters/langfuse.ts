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
import { hashPrompt, parsePrompt, PROMPT_NAME, type PromptDefinition, type PromptMessage } from "../prompt/model.ts";

export interface LangfuseOptions {
  /** Passed explicitly, never read from the environment: one process may hold many tenants' keys. */
  publicKey: string;
  secretKey: string;
  /** Default https://cloud.langfuse.com (US: https://us.cloud.langfuse.com, or your self-hosted URL). */
  baseURL?: string;
  fetch?: typeof fetch;
}

export class LangfuseError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** A Langfuse prompt version as the public API returns it. */
interface Row {
  name: string;
  version: number;
  type: "text" | "chat";
  prompt: string | ({ role: string; content: unknown; type?: string } | { type: "placeholder"; name: string })[];
  config?: Record<string, unknown> | null;
  labels?: string[];
  tags?: string[];
  /** Present when the prompt includes other prompts by reference; `prompt` is then the expanded text. */
  resolutionGraph?: unknown;
}

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

function encode(def: PromptDefinition): Body {
  const { [ORPHAN_CONFIG]: orphan, ...metadata } = def.metadata ?? {};
  const envelopeSource = { ...def, ...(Object.keys(metadata).length ? { metadata } : { metadata: undefined }) };
  const config: Record<string, unknown> = {
    ...(orphan as Record<string, unknown> | undefined),
    ...def.model?.params,
    ...(def.model ? { model: def.model.id } : {}),
    ...(def.tools
      ? {
          tools: def.tools.map((t) => ({
            type: "function",
            function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters },
          })),
        }
      : {}),
    ...(def.output
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: def.output.name ?? "output",
              schema: def.output.schema,
              ...(def.output.strict === undefined ? {} : { strict: def.output.strict }),
            },
          },
        }
      : {}),
    // Description and metadata have no native field on a Langfuse prompt.
    [ENVELOPE_KEY]: packEnvelope(envelopeSource as PromptDefinition, ["description", "metadata", "archived"]),
  };
  return {
    name: def.name,
    type: def.type,
    prompt:
      def.type === "text"
        ? def.text
        : def.messages.map((m) => ("placeholder" in m ? { type: "placeholder" as const, name: m.placeholder } : m)),
    config,
    tags: tagsWithArchiveMarker(def),
  };
}

function decode(row: Pick<Row, "name" | "type" | "prompt" | "config" | "tags">): PromptDefinition {
  const fail = (why: string) => new LangfuseError(`langfuse prompt "${row.name}" is not portable: ${why}`);
  if (!PROMPT_NAME.test(row.name)) throw fail("its name is not lowercase path segments");

  const { [ENVELOPE_KEY]: _, model, tools: rawTools, response_format, ...rest } = row.config ?? {};
  const envelope = unpackEnvelope(row.config);
  const rf = response_format as { type?: string; json_schema?: { name?: string; schema?: unknown; strict?: boolean } } | undefined;
  const structured = rf?.type === "json_schema" ? rf.json_schema : undefined;
  if (rf && !structured) rest.response_format = response_format;

  const tools = (rawTools as { function: { name: string; description?: string; parameters?: Record<string, unknown> } }[] | undefined)?.map(
    ({ function: f }) => ({ name: f.name, ...(f.description ? { description: f.description } : {}), parameters: f.parameters ?? {} }),
  );
  const hasRest = Object.keys(rest).length > 0;
  const metadata = {
    ...envelope?.fields.metadata,
    ...(typeof model !== "string" && hasRest ? { [ORPHAN_CONFIG]: rest } : {}),
  };

  const tags = tagsWithoutArchiveMarker(row.tags, envelope?.fields.archived);
  const common = {
    name: row.name,
    ...(envelope?.fields.description ? { description: envelope.fields.description } : {}),
    ...(envelope?.fields.archived ? { archived: true as const } : {}),
    ...(typeof model === "string" ? { model: { id: model, ...(hasRest ? { params: rest } : {}) } } : {}),
    ...(tools?.length ? { tools } : {}),
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
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };

  if (row.type === "text") {
    if (typeof row.prompt !== "string") throw fail("text prompt body is not a string");
    return parsePrompt({ type: "text", text: row.prompt, ...common });
  }
  if (!Array.isArray(row.prompt)) throw fail("chat prompt body is not a message list");
  const messages = row.prompt.map((m): PromptMessage => {
    if (m.type === "placeholder") return { placeholder: (m as { name: string }).name };
    const { role, content } = m as { role: string; content: unknown };
    if (typeof content !== "string") throw fail("message content is not plain text");
    if (role !== "system" && role !== "user" && role !== "assistant") throw fail(`role "${role}"`);
    return { role, content };
  });
  return parsePrompt({ type: "chat", messages, ...common });
}

export function langfuse(options: LangfuseOptions): PlatformAdapter {
  const baseURL = (options.baseURL ?? "https://cloud.langfuse.com").replace(/\/$/, "") + "/api/public";
  const doFetch = options.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64")}`;

  /** Returns undefined on 404 so callers can tell "not there" from "broken". */
  async function request<T>(method: string, path: string, init: { query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T | undefined> {
    const url = new URL(baseURL + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const response = await doFetch(url, {
      method,
      headers: { authorization, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LangfuseError(`langfuse ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`, response.status);
    }
    const body = await response.text(); // deletes answer with an empty body on some platforms
    return (body ? JSON.parse(body) : undefined) as T;
  }

  const promptPath = (name: string) => `/v2/prompts/${encodeURIComponent(name)}`;
  const userLabels = (labels: string[] | undefined) => (labels ?? []).filter((l) => l !== LATEST);
  const toRemote = (row: Row): RemotePrompt => ({
    definition: decode(row),
    version: String(row.version),
    labels: userLabels(row.labels),
  });

  const fetchRow = (ref: { name: string; version?: string; label?: string }) =>
    request<Row>("GET", promptPath(ref.name), {
      // With no selector Langfuse serves "production"; the contract here is "newest version".
      query: ref.version ? { version: ref.version } : { label: ref.label ?? LATEST },
    });

  const prompts: PromptRegistry = {
    capabilities: {
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
    },

    async get(ref) {
      const row = await fetchRow(ref);
      return row ? toRemote(row) : null;
    },

    async list() {
      const out: { name: string; labels: string[] }[] = [];
      for (let page = 1; ; page++) {
        const result = await request<{ data: { name: string; labels?: string[] }[]; meta: { totalPages: number } }>("GET", "/v2/prompts", {
          query: { page: String(page), limit: "100" },
        });
        for (const p of result?.data ?? []) if (PROMPT_NAME.test(p.name)) out.push({ name: p.name, labels: userLabels(p.labels) });
        if (!result || page >= result.meta.totalPages) return out;
      }
    },

    async push(definition, pushOptions) {
      const def = parsePrompt(definition);
      const body = encode(def);
      const labels = userLabels(pushOptions?.labels);

      // Compare what the platform would give back, so encoding normalisations never cause phantom versions.
      const current = await fetchRow({ name: def.name });
      if (current && hashPrompt(decode(current)) === hashPrompt(decode(body))) {
        if (labels.length) await prompts.setLabels(def.name, String(current.version), labels);
        return { ...toRemote(current), labels: [...new Set([...userLabels(current.labels), ...labels])] };
      }
      // Langfuse returns such a prompt with its references already expanded, so what we hold is a copy.
      if (current?.resolutionGraph && !pushOptions?.force) {
        throw new LangfuseError(
          `langfuse: "${def.name}" includes other prompts by reference in Langfuse. Pushing would replace those references ` +
            `with a copy of their current text. Edit it in Langfuse, or push with force to accept that.`,
        );
      }
      if (current && current.type !== def.type) {
        throw new LangfuseError(
          `langfuse: "${def.name}" is a ${current.type} prompt there and cannot become a ${def.type} prompt; Langfuse fixes the type at creation.`,
        );
      }
      const row = await request<Row>("POST", "/v2/prompts", { body: { ...body, labels } });
      if (!row) throw new LangfuseError("langfuse POST /v2/prompts returned 404");
      return toRemote(row);
    },

    async delete(name) {
      await request("DELETE", promptPath(name)); // removes every version; 404 means it was already gone
    },

    async setLabels(name, version, labels) {
      const row = await fetchRow({ name, version });
      if (!row) throw new LangfuseError(`langfuse: no version ${version} of "${name}"`);
      // Sent as the full set, so the result is the same whether Langfuse adds to or replaces a version's labels.
      const newLabels = [...new Set([...userLabels(row.labels), ...userLabels(labels)])];
      const updated = await request("PATCH", `${promptPath(name)}/versions/${version}`, { body: { newLabels } });
      if (!updated) throw new LangfuseError(`langfuse: no version ${version} of "${name}"`);
    },
  };

  return { id: "langfuse", prompts };
}
