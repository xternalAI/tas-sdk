import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExperimentReporter } from "../eval.ts";
import {
  ENVELOPE_KEY,
  packEnvelope,
  tagsWithArchiveMarker,
  unpackEnvelope,
  type PlatformAdapter,
  type PromptRegistry,
  type RemotePrompt,
} from "../adapter.ts";
import { hashPrompt, parsePrompt, type PromptDefinition, type PromptMessage, type PromptModel, type PromptTool } from "../prompt/model.ts";
import { extractVariables } from "../prompt/template.ts";
import { asText, commonAttributes, type TraceExporter } from "../trace.ts";

export interface LangSmithOptions {
  /** Passed explicitly, never read from the environment: one process may hold many tenants' keys. */
  apiKey: string;
  /** Default https://api.smith.langchain.com (EU: https://eu.api.smith.langchain.com). */
  baseURL?: string;
  /** Needed only when the key can reach more than one workspace. */
  workspaceId?: string;
  /** Tracing project that receives spans. Default "default". */
  project?: string;
  /**
   * Decide which LangSmith provider a model id belongs to, when the built-in rules guess wrong
   * for your gateway's naming. Return undefined to fall back to them.
   */
  resolveModel?: (modelId: string) => { provider: LangSmithProvider; model: string } | undefined;
  fetch?: typeof fetch;
}

export class LangSmithError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * LangSmith stores a prompt as a serialized LangChain object ("manifest") in a commit of a repo.
 * Only the shapes below are written; `decode` also reads what the LangSmith UI produces.
 */
type Lc = { lc: 1; type: "constructor"; id: string[]; kwargs: Record<string, any> };
interface Commit {
  commit_hash: string;
  manifest: Lc;
}
interface Repo {
  repo_handle: string;
  repo_type?: string;
  description?: string | null;
  tags?: string[] | null;
  commit_tags?: string[] | null;
}

const lc = (id: string[], kwargs: Record<string, any>): Lc => ({ lc: 1, type: "constructor", id, kwargs });
const cls = (node: Lc | undefined) => node?.id?.at(-1);

const MESSAGE_CLASS = { system: "SystemMessagePromptTemplate", user: "HumanMessagePromptTemplate", assistant: "AIMessagePromptTemplate" } as const;
const ROLE_OF: Record<string, "system" | "user" | "assistant"> = {
  SystemMessagePromptTemplate: "system",
  HumanMessagePromptTemplate: "user",
  AIMessagePromptTemplate: "assistant",
  SystemMessage: "system",
  HumanMessage: "user",
  AIMessage: "assistant",
};
/** LangSmith adds the manifest's class name to a repo's tags on its own. */
const AUTO_TAGS = new Set(["ChatPromptTemplate", "PromptTemplate", "StructuredPrompt", "RunnableSequence"]);
/** Handles allow only [a-z0-9_-] and must start with a letter, so "/" becomes "--". */
const HANDLE = /^[a-z][a-z0-9_-]*$/;

/**
 * How LangSmith's playground stores each provider's model: the LangChain class it instantiates and
 * the constructor argument holding the API key (always a reference to a workspace secret, never a
 * value). Taken from manifests the LangSmith UI itself wrote.
 */
export const LANGSMITH_PROVIDERS = {
  openai: { id: ["langchain", "chat_models", "openai", "ChatOpenAI"], keyArg: "openai_api_key", secret: "OPENAI_API_KEY" },
  anthropic: { id: ["langchain", "chat_models", "anthropic", "ChatAnthropic"], keyArg: "anthropic_api_key", secret: "ANTHROPIC_API_KEY" },
  google: { id: ["langchain_google_genai", "chat_models", "ChatGoogleGenerativeAI"], keyArg: "google_api_key", secret: "GOOGLE_API_KEY" },
  groq: { id: ["langchain_groq", "chat_models", "ChatGroq"], keyArg: "groq_api_key", secret: "GROQ_API_KEY" },
  fireworks: { id: ["langchain", "chat_models", "fireworks", "ChatFireworks"], keyArg: "fireworks_api_key", secret: "FIREWORKS_API_KEY" },
  mistral: { id: ["langchain", "chat_models", "mistralai", "ChatMistralAI"], keyArg: "api_key", secret: "MISTRAL_API_KEY" },
  deepseek: { id: ["langchain_deepseek", "chat_models", "ChatDeepSeek"], keyArg: "api_key", secret: "DEEPSEEK_API_KEY" },
} as const;
export type LangSmithProvider = keyof typeof LANGSMITH_PROVIDERS;

/** Prefixes people put on model ids ("anthropic/claude-...") mapped to a provider. */
const PREFIX: Record<string, LangSmithProvider> = {
  openai: "openai", anthropic: "anthropic", google: "google", gemini: "google", google_genai: "google",
  groq: "groq", fireworks: "fireworks", fireworks_ai: "fireworks", mistral: "mistral", mistralai: "mistral", deepseek: "deepseek",
};
/** Bare model names recognised by family. Anything else is treated as OpenAI-compatible. */
const FAMILY: [RegExp, LangSmithProvider][] = [
  [/^(gpt-|o\d|chatgpt-)/, "openai"],
  [/^claude/, "anthropic"],
  [/^gemini/, "google"],
  [/^(mistral|codestral|ministral|pixtral)/, "mistral"],
  [/^deepseek/, "deepseek"],
];
/**
 * Settings that every provider class above accepts under the same name, so they are written as real
 * model arguments. Everything else in `model.params` stays in the envelope: still returned to your
 * code, just not shown as a control in the LangSmith playground.
 */
const NATIVE_PARAMS = ["temperature", "max_tokens", "top_p", "top_k", "frequency_penalty", "presence_penalty", "reasoning_effort"];

type Resolver = LangSmithOptions["resolveModel"];

function resolveModel(id: string, custom: Resolver): { provider: LangSmithProvider; model: string } {
  const chosen = custom?.(id);
  if (chosen) return chosen;
  const slash = id.indexOf("/");
  const prefixed = slash > 0 ? PREFIX[id.slice(0, slash)] : undefined;
  if (prefixed) return { provider: prefixed, model: id.slice(slash + 1) };
  return { provider: FAMILY.find(([pattern]) => pattern.test(id))?.[1] ?? "openai", model: id };
}

/** The canonical id for a model found in LangSmith that this SDK did not write. */
function canonicalModelId(provider: LangSmithProvider, model: string, custom: Resolver): string {
  const bare = resolveModel(model, custom);
  return bare.provider === provider && bare.model === model ? model : `${provider}/${model}`;
}

function toHandle(name: string): string {
  const handle = name.replaceAll("/", "--");
  if (name.includes("--") || !HANDLE.test(handle)) {
    throw new LangSmithError(
      `langsmith: prompt name "${name}" cannot be stored. LangSmith names must start with a letter, and "--" is reserved here for "/".`,
    );
  }
  return handle;
}
const toName = (handle: string) => handle.replaceAll("--", "/");
const topLevel = (variables: string[]) => [...new Set(variables.map((v) => v.split(".")[0]!))];

function template(text: string): Lc {
  const vars = topLevel(extractVariables({ type: "text", name: "x", text }));
  return lc(["langchain", "prompts", "prompt", "PromptTemplate"], { input_variables: vars, template: text, template_format: "mustache" });
}

/** LangSmith's default format is f-string: `{var}` is a variable and `{{` / `}}` are literal braces. */
function fromFString(text: string): string {
  return text.replace(/\{\{|\}\}|\{([^{}]+)\}/g, (match, variable?: string) => (variable ? `{{${variable.trim()}}}` : match[0]!));
}

const toOpenAITools = (tools: PromptTool[]) =>
  tools.map((t) => ({ type: "function", function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters } }));

/** LangSmith keeps the output name and strict flag inside the schema itself, as `title` and `strict`. */
const toSchema = (output: NonNullable<PromptDefinition["output"]>) => ({
  ...output.schema,
  ...(output.name ? { title: output.name } : {}),
  ...(output.strict === undefined ? {} : { strict: output.strict }),
});

function encodeModel(model: PromptModel, tools: PromptTool[] | undefined, custom: Resolver): Lc {
  const { provider, model: name } = resolveModel(model.id, custom);
  const spec = LANGSMITH_PROVIDERS[provider];
  const native = Object.fromEntries(Object.entries(model.params ?? {}).filter(([k, v]) => NATIVE_PARAMS.includes(k) && v !== null));
  const bound = lc([...spec.id], { model: name, ...native, [spec.keyArg]: { lc: 1, type: "secret", id: [spec.secret] } });
  // The same wrapper the playground writes: the model, plus arguments bound to every call (tools).
  return lc(["langchain", "schema", "runnable", "RunnableBinding"], { bound, kwargs: tools ? { tools: toOpenAITools(tools) } : {} });
}

function encode(def: PromptDefinition, custom?: Resolver): Lc {
  // The envelope keeps the exact canonical values. Model, tools and output are also written natively
  // below wherever LangSmith has a place for them; `decode` reconciles the two. Description and tags
  // are repo-wide in LangSmith, so the per-version copy lives here as well.
  const envelope = packEnvelope(def, ["description", "tags", "metadata", "model", "tools", "output", "archived"]);
  const metadata = { [ENVELOPE_KEY]: envelope };

  let prompt: Lc;
  if (def.type === "text") {
    prompt = lc(template(def.text).id, { ...template(def.text).kwargs, metadata });
  } else {
    const kwargs = {
      input_variables: topLevel(extractVariables(def)),
      messages: def.messages.map((m) =>
        "placeholder" in m
          ? lc(["langchain_core", "prompts", "chat", "MessagesPlaceholder"], { variable_name: m.placeholder })
          : lc(["langchain", "prompts", "chat", MESSAGE_CLASS[m.role]], { prompt: template(m.content) }),
      ),
      template_format: "mustache",
      metadata,
    };
    prompt = def.output
      ? lc(["langchain_core", "prompts", "structured", "StructuredPrompt"], { ...kwargs, schema_: toSchema(def.output) })
      : lc(["langchain", "prompts", "chat", "ChatPromptTemplate"], kwargs);
  }
  if (!def.model) return prompt; // tools need a model to be bound to; without one they stay envelope-only
  return lc(["langchain", "schema", "runnable", "RunnableSequence"], { first: prompt, last: encodeModel(def.model, def.tools, custom) });
}

function decode(handle: string, manifest: Lc, repo?: Repo, custom?: Resolver): PromptDefinition {
  const name = toName(handle);
  const fail = (why: string) => new LangSmithError(`langsmith prompt "${handle}" is not portable: ${why}`);

  // With a model the manifest is a sequence: prompt first, model last.
  const sequence = cls(manifest) === "RunnableSequence";
  const prompt: Lc = sequence ? manifest.kwargs.first : manifest;
  const envelope = unpackEnvelope(prompt?.kwargs?.metadata);
  const fields = envelope?.fields ?? {};

  const text = (node: Lc): string => {
    const raw = node?.kwargs?.template;
    if (typeof raw !== "string") throw fail("a message is not plain text");
    const format = node.kwargs.template_format ?? prompt.kwargs.template_format;
    return format === "mustache" ? raw : fromFString(raw);
  };

  // Model: what LangSmith stores wins for the settings it can hold, so an edit made in the playground
  // is picked up. The envelope supplies the exact id (when it still names the same model) and the
  // settings LangSmith has no control for.
  let model = fields.model;
  let tools = fields.tools;
  if (sequence) {
    const last: Lc = manifest.kwargs.last;
    const bound: Lc = last?.kwargs?.bound ?? last;
    const provider = (Object.keys(LANGSMITH_PROVIDERS) as LangSmithProvider[]).find((p) => LANGSMITH_PROVIDERS[p].id.at(-1) === cls(bound));
    const stored = bound?.kwargs?.model ?? bound?.kwargs?.model_name ?? bound?.kwargs?.deployment_name;
    if (typeof stored === "string") {
      const intended = fields.model && resolveModel(fields.model.id, custom);
      const sameModel = intended && intended.model === stored && (!provider || intended.provider === provider);
      const id = sameModel ? fields.model!.id : provider ? canonicalModelId(provider, stored, custom) : stored;
      const native = Object.fromEntries(Object.entries(bound.kwargs).filter(([k, v]) => NATIVE_PARAMS.includes(k) && v !== null && v !== ""));
      const extra = Object.fromEntries(Object.entries(fields.model?.params ?? {}).filter(([k, v]) => !NATIVE_PARAMS.includes(k) || v === null));
      const params = { ...extra, ...native };
      model = { id, ...(Object.keys(params).length ? { params } : {}) };
    }
    const boundTools = last?.kwargs?.kwargs?.tools as { function: { name: string; description?: string; parameters?: Record<string, unknown> } }[] | undefined;
    const nativeTools = boundTools?.map(({ function: f }) => ({ name: f.name, ...(f.description ? { description: f.description } : {}), parameters: f.parameters ?? {} }));
    // Tools bound in LangSmith are the truth for a prompt with a model; an empty binding means none.
    tools = nativeTools?.length ? nativeTools : undefined;
  }

  // Output schema: exact from the envelope while LangSmith still holds the schema we wrote.
  let output = fields.output;
  if (cls(prompt) === "StructuredPrompt") {
    const stored = (prompt.kwargs.schema_ ?? prompt.kwargs.schema) as Record<string, unknown> | undefined;
    if (stored && !(fields.output && isDeepStrictEqual(toSchema(fields.output), stored))) {
      const { title, strict, ...schema } = stored;
      output = { ...(typeof title === "string" ? { name: title } : {}), schema, ...(typeof strict === "boolean" ? { strict } : {}) };
    }
  } else if (prompt && cls(prompt) === "ChatPromptTemplate" && fields.output && envelope) {
    output = undefined; // it was a structured prompt when we wrote it; someone removed the schema in LangSmith
  }

  const description = envelope ? fields.description : (repo?.description ?? undefined);
  const tags = envelope ? fields.tags : (repo?.tags ?? []).filter((t) => !AUTO_TAGS.has(t));

  const common = {
    name,
    ...(description ? { description } : {}),
    ...(fields.archived ? { archived: true as const } : {}),
    ...(model ? { model } : {}),
    ...(tools ? { tools } : {}),
    ...(output ? { output } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(fields.metadata ? { metadata: fields.metadata } : {}),
  };

  if (cls(prompt) === "PromptTemplate") return parsePrompt({ type: "text", text: text(prompt), ...common });
  if (cls(prompt) !== "ChatPromptTemplate" && cls(prompt) !== "StructuredPrompt") throw fail(`unsupported object "${cls(prompt)}"`);
  const messages = (prompt.kwargs.messages as Lc[]).map((m): PromptMessage => {
    if (cls(m) === "MessagesPlaceholder") return { placeholder: m.kwargs.variable_name };
    const role = ROLE_OF[cls(m) ?? ""];
    if (!role) throw fail(`message type "${cls(m)}"`);
    if (typeof m.kwargs.content === "string") return { role, content: m.kwargs.content }; // a fixed message, no template
    if (!m.kwargs.prompt || Array.isArray(m.kwargs.prompt)) throw fail("a message has non-text content");
    return { role, content: text(m.kwargs.prompt) };
  });
  return parsePrompt({ type: "chat", messages, ...common });
}

export function langsmith(options: LangSmithOptions): PlatformAdapter {
  const baseURL = (options.baseURL ?? "https://api.smith.langchain.com").replace(/\/$/, "") + "/api/v1";
  const doFetch = options.fetch ?? fetch;
  const headers = {
    "x-api-key": options.apiKey,
    "content-type": "application/json",
    ...(options.workspaceId ? { "x-tenant-id": options.workspaceId } : {}),
  };

  /** Returns undefined on 404 so callers can tell "not there" from "broken". */
  async function request<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    const response = await doFetch(new URL(baseURL + path), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LangSmithError(`langsmith ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`, response.status);
    }
    const raw = await response.text(); // deletes answer with an empty body on some platforms
    return (raw ? JSON.parse(raw) : undefined) as T;
  }

  // "-" is the owner placeholder for "the workspace this key belongs to".
  const fetchCommit = (handle: string, commitish: string) =>
    request<Commit>("GET", `/commits/-/${handle}/${encodeURIComponent(commitish)}?include_model=true`);
  const fetchTags = async (handle: string) =>
    (await request<{ tag_name: string; commit_hash: string }[]>("GET", `/repos/-/${handle}/tags`)) ?? [];

  async function toRemote(handle: string, commit: Commit): Promise<RemotePrompt> {
    // Prompts never written by this SDK keep their description and tags on the repo only.
    const hasEnvelope = JSON.stringify(commit.manifest).includes(`"${ENVELOPE_KEY}"`);
    const [tags, repo] = await Promise.all([
      fetchTags(handle),
      hasEnvelope ? undefined : request<{ repo: Repo }>("GET", `/repos/-/${handle}`),
    ]);
    return {
      definition: decode(handle, commit.manifest, repo?.repo, options.resolveModel),
      version: commit.commit_hash,
      labels: tags.filter((t) => t.commit_hash === commit.commit_hash).map((t) => t.tag_name),
    };
  }

  /** Tag endpoints want the commit's UUID, which only the commit list exposes. */
  async function commitId(handle: string, hash: string): Promise<string> {
    for (let offset = 0; ; offset += 100) {
      const page = await request<{ commits: { id: string; commit_hash: string }[] }>("GET", `/commits/-/${handle}?limit=100&offset=${offset}`);
      const found = page?.commits.find((c) => c.commit_hash === hash);
      if (found) return found.id;
      if (!page || page.commits.length < 100) throw new LangSmithError(`langsmith: no version ${hash} of "${toName(handle)}"`);
    }
  }

  async function pointTags(handle: string, id: string, labels: string[]): Promise<void> {
    if (!labels.length) return;
    const existing = new Set((await fetchTags(handle)).map((t) => t.tag_name));
    for (const label of labels) {
      if (existing.has(label)) await request("PATCH", `/repos/-/${handle}/tags/${encodeURIComponent(label)}`, { commit_id: id });
      else await request("POST", `/repos/-/${handle}/tags`, { tag_name: label, commit_id: id });
    }
  }

  const prompts: PromptRegistry = {
    capabilities: {
      labels: "native", // commit tags
      textPrompts: "native",
      placeholders: "native",
      modelConfig: "native", // provider class + common settings; other settings ride in the envelope
      tools: "native", // when the prompt has a model to bind them to
      outputSchema: "native", // chat prompts only
      tags: "emulated",
      metadata: "emulated",
      description: "emulated",
      nestedNames: "emulated",
      archived: "emulated",
    },

    async get(ref) {
      const handle = toHandle(ref.name);
      const commit = await fetchCommit(handle, ref.version ?? ref.label ?? "latest");
      return commit ? toRemote(handle, commit) : null;
    },

    async list() {
      const out: { name: string; labels: string[] }[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await request<{ repos: Repo[]; total: number }>("GET", `/repos?is_public=false&limit=100&offset=${offset}`);
        for (const repo of page?.repos ?? []) {
          if (repo.repo_type && repo.repo_type !== "prompt") continue;
          out.push({ name: toName(repo.repo_handle), labels: repo.commit_tags ?? [] });
        }
        if (!page || offset + page.repos.length >= page.total || !page.repos.length) return out;
      }
    },

    async push(definition, pushOptions) {
      const def = parsePrompt(definition);
      const handle = toHandle(def.name);
      const manifest = encode(def, options.resolveModel);
      const labels = pushOptions?.labels ?? [];

      const latest = await fetchCommit(handle, "latest");
      if (latest && hashPrompt((await toRemote(handle, latest)).definition) === hashPrompt(decode(handle, manifest, undefined, options.resolveModel))) {
        await pointTags(handle, labels.length ? await commitId(handle, latest.commit_hash) : "", labels);
        return toRemote(handle, latest);
      }

      const repoFields = { description: def.description ?? "", tags: tagsWithArchiveMarker(def) };
      if (!latest) {
        try {
          await request("POST", "/repos", { repo_handle: handle, is_public: false, ...repoFields });
        } catch (error) {
          if (!(error instanceof LangSmithError) || error.status !== 409) throw error; // exists, but has no commits yet
        }
      }
      // A repo with history rejects a commit that does not name its parent.
      const created = await request<{ commit: { id: string; commit_hash: string } }>("POST", `/commits/-/${handle}`, {
        manifest,
        ...(latest ? { parent_commit: latest.commit_hash } : {}),
      });
      if (!created) throw new LangSmithError(`langsmith: could not commit to "${handle}"`);
      // Mirror onto the repo so the prompt list in LangSmith reads sensibly; the envelope stays the source.
      if (latest) await request("PATCH", `/repos/-/${handle}`, repoFields);
      await pointTags(handle, created.commit.id, labels);
      return { definition: def, version: created.commit.commit_hash, labels };
    },

    async delete(name) {
      await request("DELETE", `/repos/-/${toHandle(name)}`); // removes the repo and every commit
    },

    async setLabels(name, version, labels) {
      const handle = toHandle(name);
      await pointTags(handle, await commitId(handle, version), labels);
    },
  };

  const tracing: TraceExporter = {
    url: `${baseURL.replace(/\/api\/v1$/, "")}/otel/v1/traces`,
    headers: {
      "x-api-key": options.apiKey,
      "Langsmith-Project": options.project ?? "default",
      ...(options.workspaceId ? { "x-tenant-id": options.workspaceId } : {}),
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    attributes: (span) => ({
      ...commonAttributes(span),
      "langsmith.span.kind": span.kind === "generation" ? "llm" : span.kind === "tool" ? "tool" : "chain",
      // LangSmith shows a model call as a conversation only when its input is an object holding the messages.
      ...(span.input !== undefined
        ? { "input.value": asText(span.kind === "generation" && Array.isArray(span.input) ? { messages: span.input } : span.input) }
        : {}),
      ...(span.output !== undefined ? { "output.value": asText(span.output) } : {}),
      ...Object.fromEntries(Object.entries(span.metadata ?? {}).map(([k, v]) => [`langsmith.metadata.${k}`, asText(v)])),
      ...Object.fromEntries(Object.entries(span.modelParams ?? {}).map(([k, v]) => [`gen_ai.request.${k}`, v])),
      // LangSmith has no user or session field; these metadata keys are what its threads view reads.
      ...(span.userId ? { "langsmith.metadata.user_id": span.userId } : {}),
      ...(span.sessionId ? { "langsmith.metadata.thread_id": span.sessionId } : {}),
      ...(span.tags?.length ? { "langsmith.span.tags": span.tags.join(",") } : {}),
      ...(span.parentSpanId ? {} : { "langsmith.trace.name": span.name }),
      // The same metadata LangChain's own hub client attaches when it pulls a prompt.
      ...(span.prompt?.platform === "langsmith" && span.prompt.version
        ? {
            "langsmith.metadata.lc_hub_owner": "-",
            "langsmith.metadata.lc_hub_repo": span.prompt.name.replaceAll("/", "--"),
            "langsmith.metadata.lc_hub_commit_hash": span.prompt.version,
          }
        : {}),
    }),
  };

  const experiments: ExperimentReporter = {
    async report(result) {
      // LangSmith requires inputs and outputs to be objects, and examples are identified by UUID.
      const asObject = (value: unknown, key: string) =>
        typeof value === "object" && value !== null && !Array.isArray(value) ? value : { [key]: value ?? null };
      const exampleId = (rowId: string) =>
        createHash("sha256").update(`${result.dataset.name}\n${rowId}`).digest("hex").slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
      const iso = (ms: number) => new Date(ms).toISOString();
      // LangSmith requires experiment start < row start < row end < experiment end, all strictly, which a
      // fast task does not produce: times recorded in the same millisecond are nudged apart.
      const rowEnd = (row: { startTime: number; endTime: number }) => Math.max(row.endTime, row.startTime + 1);
      const experimentStart = Math.min(result.startTime, ...result.rows.map((row) => row.startTime - 1));
      const experimentEnd = Math.max(result.endTime, ...result.rows.map((row) => rowEnd(row) + 1));
      // One call creates the dataset if needed, its examples, the experiment and the scores.
      await request("POST", "/datasets/upload-experiment", {
        experiment_name: result.runName,
        dataset_name: result.dataset.name,
        ...(result.dataset.description ? { dataset_description: result.dataset.description } : {}),
        experiment_start_time: iso(experimentStart),
        experiment_end_time: iso(experimentEnd),
        experiment_metadata: { ...result.metadata, evaluation: result.name },
        results: result.rows.map((row) => ({
          row_id: exampleId(row.id),
          inputs: asObject(row.input, "input"),
          expected_outputs: asObject(row.expected, "output"),
          actual_outputs: row.error ? { error: row.error } : asObject(row.output, "output"),
          evaluation_scores: Object.entries(row.scores).map(([key, s]) => ({ key, score: s.score, ...(s.comment ? { comment: s.comment } : {}) })),
          start_time: iso(row.startTime),
          end_time: iso(rowEnd(row)),
          run_name: result.name,
          run_metadata: { ...row.metadata, item: row.id },
        })),
      });
      return {};
    },
  };

  return { id: "langsmith", prompts, tracing, experiments };
}
