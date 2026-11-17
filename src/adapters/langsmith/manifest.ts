/**
 * The codec between a canonical prompt and the LangChain manifest LangSmith stores in a commit:
 * `encode` writes one, `decode` reads one (ours, or one made in the LangSmith UI). Also the mapping
 * between prompt names and repo handles. No network calls happen here.
 */
import { isDeepStrictEqual } from "node:util";
import { ENVELOPE_KEY, fingerprint, packEnvelope, unpackEnvelope, type Envelope } from "../../adapter.ts";
import { parsePrompt, type ContentPart, type MessageContent, type PromptDefinition, type PromptMessage } from "../../prompt/model.ts";
import { extractVariables } from "../../prompt/template.ts";
import { LangSmithError } from "./error.ts";
import { cls, lc, type Lc } from "./lc.ts";
import { decodeModel, decodeTools, encodeModel, type Resolver } from "./models.ts";

/** A repo as the LangSmith API returns it. Description and tags are repo-wide, not per commit. */
export interface Repo {
  repo_handle: string;
  repo_type?: string;
  description?: string | null;
  tags?: string[] | null;
  commit_tags?: string[] | null;
}

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

/** The repo handle for a prompt name. Throws for a name LangSmith cannot hold. */
export function toHandle(name: string): string {
  const handle = name.replaceAll("/", "--");
  if (name.includes("--") || !HANDLE.test(handle)) {
    throw new LangSmithError(
      `langsmith: prompt name "${name}" cannot be stored. LangSmith names must start with a letter, and "--" is reserved here for "/".`,
    );
  }
  return handle;
}
/** The prompt name for a repo handle: the reverse of `toHandle`. */
export const toName = (handle: string) => handle.replaceAll("--", "/");

/** LangChain's `input_variables` name whole values, so `user.name` is listed as `user`. */
const topLevel = (variables: string[]) => [...new Set(variables.map((v) => v.split(".")[0]!))];

/** A mustache text template, with the variables it uses. */
function template(text: string): Lc {
  const vars = topLevel(extractVariables({ type: "text", name: "x", text }));
  return lc(["langchain", "prompts", "prompt", "PromptTemplate"], { input_variables: vars, template: text, template_format: "mustache" });
}

/** An image part as LangChain's image template. The URL may itself hold variables. */
function imageTemplate(part: Extract<ContentPart, { type: "image" }>): Lc {
  const variables = topLevel(extractVariables({ type: "text", name: "x", text: part.url }));
  return lc(["langchain_core", "prompts", "image", "ImagePromptTemplate"], {
    input_variables: variables,
    template: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) },
    template_format: "mustache",
  });
}

/** One template for plain text; a list of text and image templates for a message with parts. Files are left out. */
function contentTemplate(content: MessageContent): Lc | Lc[] {
  if (typeof content === "string") return template(content);
  return content.flatMap((part): Lc[] => {
    if (part.type === "text") return [template(part.text)];
    if (part.type === "file") return [];
    return [imageTemplate(part)];
  });
}

/** LangSmith's default format is f-string: `{var}` is a variable and `{{` / `}}` are literal braces. */
function fromFString(text: string): string {
  return text.replace(/\{\{|\}\}|\{([^{}]+)\}/g, (match, variable?: string) => (variable ? `{{${variable.trim()}}}` : match[0]!));
}

/** LangSmith keeps the output name and strict flag inside the schema itself, as `title` and `strict`. */
const toSchema = (output: NonNullable<PromptDefinition["output"]>) => ({
  ...output.schema,
  ...(output.name ? { title: output.name } : {}),
  ...(output.strict === undefined ? {} : { strict: output.strict }),
});

/** One chat message as its LangChain template: a placeholder for a list of messages, or a role with its content. */
function messageTemplate(message: PromptMessage): Lc {
  return "placeholder" in message
    ? lc(["langchain_core", "prompts", "chat", "MessagesPlaceholder"], { variable_name: message.placeholder })
    : lc(["langchain", "prompts", "chat", MESSAGE_CLASS[message.role]], { prompt: contentTemplate(message.content) });
}

const hasFileParts = (def: PromptDefinition) =>
  def.type === "chat" && def.messages.some((m) => "content" in m && Array.isArray(m.content) && m.content.some((part) => part.type === "file"));

/** The prompt half of a manifest: the templates, with the envelope in `metadata`. */
function encodePrompt(def: PromptDefinition): Lc {
  // The envelope keeps the exact canonical values. Model, tools and output are also written natively
  // (below, and in `encodeModel`) wherever LangSmith has a place for them; `decode` reconciles the two.
  // Description and tags are repo-wide in LangSmith, so the per-version copy lives here as well.
  // LangChain has a template for text and for images, but none for files. A prompt with a file part
  // keeps its real messages in the envelope; natively it shows everything except the files.
  const hasFiles = hasFileParts(def);
  const nativeMessages = def.type === "chat" ? def.messages.map(messageTemplate) : [];
  const emulated: (keyof PromptDefinition)[] = ["description", "tags", "metadata", "model", "tools", "output", "archived"];
  const envelope = {
    ...packEnvelope(def, [...emulated, ...(hasFiles ? ["messages" as keyof PromptDefinition] : [])]),
    ...(hasFiles ? { native: fingerprint(nativeMessages) } : {}),
  };
  const metadata = { [ENVELOPE_KEY]: envelope };

  if (def.type === "text") return lc(template(def.text).id, { ...template(def.text).kwargs, metadata });
  const kwargs = {
    input_variables: topLevel(extractVariables(def)),
    messages: nativeMessages,
    template_format: "mustache",
    metadata,
  };
  return def.output
    ? lc(["langchain_core", "prompts", "structured", "StructuredPrompt"], { ...kwargs, schema_: toSchema(def.output) })
    : lc(["langchain", "prompts", "chat", "ChatPromptTemplate"], kwargs);
}

/** The manifest to commit for a prompt: the prompt alone, or a sequence of prompt and model when it names one. */
export function encode(def: PromptDefinition, custom?: Resolver): Lc {
  const prompt = encodePrompt(def);
  if (!def.model) return prompt; // tools need a model to be bound to; without one they stay envelope-only
  return lc(["langchain", "schema", "runnable", "RunnableSequence"], { first: prompt, last: encodeModel(def.model, def.tools, custom) });
}

/** Builds the error for a manifest that has no canonical form. */
type Fail = (why: string) => LangSmithError;

/** Text in our mustache syntax. A node's own format wins over the prompt's; anything but mustache is read as f-string. */
function toMustache(value: string, node: Lc, prompt: Lc): string {
  return (node.kwargs.template_format ?? prompt.kwargs.template_format) === "mustache" ? value : fromFString(value);
}

/** The text of a text template. */
function templateText(node: Lc, prompt: Lc, fail: Fail): string {
  const raw = node?.kwargs?.template;
  if (typeof raw !== "string") throw fail("a message is not plain text");
  return toMustache(raw, node, prompt);
}

/** One part of a message with parts: a text or an image template. */
function decodePart(node: Lc, prompt: Lc, fail: Fail): ContentPart {
  if (cls(node) === "PromptTemplate") return { type: "text", text: templateText(node, prompt, fail) };
  const image = node?.kwargs?.template as { url?: string; detail?: "low" | "high" | "auto" } | undefined;
  if (cls(node) !== "ImagePromptTemplate" || typeof image?.url !== "string") {
    throw fail(`a message has a part of type "${cls(node) ?? (node as { type?: string })?.type}"`);
  }
  return { type: "image", url: toMustache(image.url, node, prompt), ...(image.detail ? { detail: image.detail } : {}) };
}

/** One entry of a chat prompt's message list. */
function decodeMessage(node: Lc, prompt: Lc, fail: Fail): PromptMessage {
  if (cls(node) === "MessagesPlaceholder") return { placeholder: node.kwargs.variable_name };
  const role = ROLE_OF[cls(node) ?? ""];
  if (!role) throw fail(`message type "${cls(node)}"`);
  if (typeof node.kwargs.content === "string") return { role, content: node.kwargs.content }; // a fixed message, no template
  const content: Lc | Lc[] | undefined = node.kwargs.prompt;
  if (!content) throw fail("a message has no content");
  return { role, content: Array.isArray(content) ? content.map((part) => decodePart(part, prompt, fail)) : templateText(content, prompt, fail) };
}

/** Output schema: exact from the envelope while LangSmith still holds the schema we wrote. */
function decodeOutput(prompt: Lc, envelope: Envelope | undefined): PromptDefinition["output"] {
  const written = envelope?.fields.output;
  if (cls(prompt) === "StructuredPrompt") {
    const stored = (prompt.kwargs.schema_ ?? prompt.kwargs.schema) as Record<string, unknown> | undefined;
    if (stored && !(written && isDeepStrictEqual(toSchema(written), stored))) {
      const { title, strict, ...schema } = stored;
      return { ...(typeof title === "string" ? { name: title } : {}), schema, ...(typeof strict === "boolean" ? { strict } : {}) };
    }
  } else if (prompt && cls(prompt) === "ChatPromptTemplate" && written) {
    return undefined; // it was a structured prompt when we wrote it; someone removed the schema in LangSmith
  }
  return written;
}

/**
 * The canonical prompt for a manifest. `repo` supplies description and tags for a prompt this SDK
 * did not write (it has no envelope). Throws when the manifest holds something that is not portable.
 */
export function decode(handle: string, manifest: Lc, repo?: Repo, custom?: Resolver): PromptDefinition {
  const name = toName(handle);
  const fail: Fail = (why) => new LangSmithError(`langsmith prompt "${handle}" is not portable: ${why}`);

  // With a model the manifest is a sequence: prompt first, model last.
  const sequence = cls(manifest) === "RunnableSequence";
  const prompt: Lc = sequence ? manifest.kwargs.first : manifest;
  const envelope = unpackEnvelope(prompt?.kwargs?.metadata);
  const fields = envelope?.fields ?? {};

  const model = sequence ? decodeModel(manifest.kwargs.last, fields.model, custom) : fields.model;
  const tools = sequence ? decodeTools(manifest.kwargs.last) : fields.tools;
  const output = decodeOutput(prompt, envelope);
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

  if (cls(prompt) === "PromptTemplate") return parsePrompt({ type: "text", text: templateText(prompt, prompt, fail), ...common });
  if (cls(prompt) !== "ChatPromptTemplate" && cls(prompt) !== "StructuredPrompt") throw fail(`unsupported object "${cls(prompt)}"`);
  const native = (prompt.kwargs.messages as Lc[]).map((m) => decodeMessage(m, prompt, fail));
  // Messages with file parts come from the envelope, unless the native side was edited in LangSmith since.
  const kept = (fields as { messages?: PromptMessage[] }).messages;
  const messages = kept && envelope?.native === fingerprint(prompt.kwargs.messages) ? kept : native;
  return parsePrompt({ type: "chat", messages, ...common });
}
