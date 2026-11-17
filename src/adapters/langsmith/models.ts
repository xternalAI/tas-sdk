/**
 * Models on LangSmith: the table of providers its playground knows, how a model id is assigned to
 * one of them, and the encoding of a model with its settings and tools as LangChain objects.
 */
import type { PromptModel, PromptTool } from "../../prompt/model.ts";
import { fromOpenAITools, toOpenAITools } from "../shared.ts";
import type { LangSmithOptions } from "./index.ts";
import { cls, lc, type Lc } from "./lc.ts";

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

/** The caller's own model-id rule (`LangSmithOptions.resolveModel`), consulted before the built-in ones. */
export type Resolver = LangSmithOptions["resolveModel"];

/** Which provider a model id belongs to: the custom rule, then a known prefix, then the model family, else OpenAI. */
export function resolveModel(id: string, custom: Resolver): { provider: LangSmithProvider; model: string } {
  const chosen = custom?.(id);
  if (chosen) return chosen;
  const slash = id.indexOf("/");
  const prefixed = slash > 0 ? PREFIX[id.slice(0, slash)] : undefined;
  if (prefixed) return { provider: prefixed, model: id.slice(slash + 1) };
  return { provider: FAMILY.find(([pattern]) => pattern.test(id))?.[1] ?? "openai", model: id };
}

/** The canonical id for a model found in LangSmith that this SDK did not write. */
export function canonicalModelId(provider: LangSmithProvider, model: string, custom: Resolver): string {
  const bare = resolveModel(model, custom);
  return bare.provider === provider && bare.model === model ? model : `${provider}/${model}`;
}

/** The model half of a manifest: the provider's class with its native settings, wrapped with the tools bound to it. */
export function encodeModel(model: PromptModel, tools: PromptTool[] | undefined, custom: Resolver): Lc {
  const { provider, model: name } = resolveModel(model.id, custom);
  const spec = LANGSMITH_PROVIDERS[provider];
  const native = Object.fromEntries(Object.entries(model.params ?? {}).filter(([k, v]) => NATIVE_PARAMS.includes(k) && v !== null));
  const bound = lc([...spec.id], { model: name, ...native, [spec.keyArg]: { lc: 1, type: "secret", id: [spec.secret] } });
  // The same wrapper the playground writes: the model, plus arguments bound to every call (tools).
  return lc(["langchain", "schema", "runnable", "RunnableBinding"], { bound, kwargs: tools ? { tools: toOpenAITools(tools) } : {} });
}

/** The provider whose LangChain class a serialized model is an instance of, if it is one from the table. */
function providerOf(bound: Lc): LangSmithProvider | undefined {
  return (Object.keys(LANGSMITH_PROVIDERS) as LangSmithProvider[]).find((p) => LANGSMITH_PROVIDERS[p].id.at(-1) === cls(bound));
}

/**
 * Read the model half of a manifest (`last` of the sequence: a binding around the model, or the bare
 * model). `written` is the model the envelope remembers, if this SDK wrote the prompt.
 *
 * What LangSmith stores wins for the settings it can hold, so an edit made in the playground
 * is picked up. The envelope supplies the exact id (when it still names the same model) and the
 * settings LangSmith has no control for.
 */
export function decodeModel(last: Lc, written: PromptModel | undefined, custom: Resolver): PromptModel | undefined {
  const bound: Lc = last?.kwargs?.bound ?? last;
  const provider = providerOf(bound);
  const stored = bound?.kwargs?.model ?? bound?.kwargs?.model_name ?? bound?.kwargs?.deployment_name;
  if (typeof stored !== "string") return written;
  const intended = written && resolveModel(written.id, custom);
  const sameModel = intended && intended.model === stored && (!provider || intended.provider === provider);
  const id = sameModel ? written!.id : provider ? canonicalModelId(provider, stored, custom) : stored;
  const native = Object.fromEntries(Object.entries(bound.kwargs).filter(([k, v]) => NATIVE_PARAMS.includes(k) && v !== null && v !== ""));
  const extra = Object.fromEntries(Object.entries(written?.params ?? {}).filter(([k, v]) => !NATIVE_PARAMS.includes(k) || v === null));
  const params = { ...extra, ...native };
  return { id, ...(Object.keys(params).length ? { params } : {}) };
}

/** Tools bound in LangSmith are the truth for a prompt with a model; an empty binding means none. */
export function decodeTools(last: Lc): PromptTool[] | undefined {
  return fromOpenAITools(last?.kwargs?.kwargs?.tools);
}
