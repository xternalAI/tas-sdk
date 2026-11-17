import type { GatewayConfig } from "./config.ts";
import type { ResolvedPrompt } from "./prompt/model.ts";
import { renderPrompt, type RenderInput } from "./prompt/template.ts";
import { toJsonSchema, validateSchema, type InferSchema, type SchemaInput } from "./schema.ts";

/**
 * Invocation: turn a resolved prompt into a call on any OpenAI-compatible gateway, using the
 * model, settings, tools and output schema stored with the prompt. The wire format is the
 * chat-completions one because every gateway we target speaks it (LiteLLM, Braintrust,
 * Langfuse, LangSmith, or a provider directly).
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export class GatewayError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** The model's reply was not valid JSON, or did not match the output schema. */
export class OutputValidationError extends Error {
  readonly issues: string[];
  readonly text: string;
  constructor(issues: string[], text: string) {
    super(`model output does not match the schema: ${issues.join("; ")}`);
    this.issues = issues;
    this.text = text;
  }
}

/** The model was still calling tools when `maxSteps` ran out. */
export class ToolLoopError extends Error {
  readonly messages: ChatMessage[];
  constructor(maxSteps: number, messages: ChatMessage[]) {
    super(`still calling tools after ${maxSteps} steps; raise maxSteps or check the tools`);
    this.messages = messages;
  }
}

export type ToolHandler = (args: any, call: { toolCallId: string; name: string }) => unknown;
/** A tool defined in code. One with the same name as a tool stored in the prompt replaces it. */
export interface ToolSpec {
  description?: string;
  parameters: SchemaInput;
  execute?: ToolHandler;
}
/**
 * Per tool name: a function to run a tool the prompt already declares, or a full definition.
 * A tool the model calls that has no function here ends the run, with the call returned to you.
 */
export type RunTools = Record<string, ToolHandler | ToolSpec>;

export interface CallOptions<S extends SchemaInput | undefined = SchemaInput | undefined> {
  /** Use this model instead of the prompt's. */
  model?: string;
  /** Merged over the prompt's settings. */
  params?: Record<string, unknown>;
  /** Validate the reply against this schema, and ask the model for it. Replaces the prompt's own output schema. */
  output?: S;
  tools?: RunTools;
  /** Most model calls in one run when tools are in play. Default 8. */
  maxSteps?: number;
  signal?: AbortSignal;
}

export interface RunOptions<S extends SchemaInput | undefined = SchemaInput | undefined> extends CallOptions<S>, RenderInput {
  /** Appended after the rendered prompt, for example earlier turns of a conversation. */
  messages?: ChatMessage[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RunResult<Output = unknown> {
  /** The final reply as text. */
  text: string;
  /** The reply parsed and validated, when the prompt or the call has an output schema; otherwise undefined. */
  output: Output;
  /** Every message of the run: the rendered prompt, then replies and tool results in order. */
  messages: ChatMessage[];
  /** Calls the model made to tools that have no function here. Non-empty means the run stopped for you to act. */
  toolCalls: ToolCall[];
  /** Model calls made. */
  steps: number;
  usage: Usage;
  finishReason: string | undefined;
  /** The model id sent to the gateway, after aliasing. */
  model: string;
  prompt: ResolvedPrompt;
}

interface Completion {
  choices: { message: ChatMessage; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function callGateway(gateway: GatewayConfig, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Completion> {
  const url = gateway.baseURL.replace(/\/$/, "") + "/chat/completions";
  const response = await (gateway.fetch ?? fetch)(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(gateway.apiKey ? { authorization: `Bearer ${gateway.apiKey}` } : {}),
      ...gateway.headers,
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GatewayError(`gateway returned ${response.status}: ${text.slice(0, 500)}`, response.status);
  }
  const completion = (await response.json()) as Completion;
  if (!completion.choices?.[0]?.message) throw new GatewayError("gateway reply has no choices[0].message");
  return completion;
}

const stringify = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? null));

/** Run `messages` against the gateway with the prompt's configuration, looping over tool calls. */
export async function complete<S extends SchemaInput | undefined>(
  gateway: GatewayConfig | undefined,
  prompt: ResolvedPrompt,
  messages: ChatMessage[],
  options: CallOptions<S> = {},
): Promise<RunResult<S extends SchemaInput ? InferSchema<S> : unknown>> {
  const def = prompt.definition;
  if (!gateway) throw new GatewayError("no gateway configured: set `gateway` in the client config");
  const modelId = options.model ?? def.model?.id;
  if (!modelId) throw new GatewayError(`prompt "${def.name}" names no model: add one to the prompt or pass { model }`);
  const model = gateway.models?.[modelId] ?? modelId;

  // Tools: the prompt's declarations, overlaid with any defined in code.
  const specs = new Map<string, { description?: string; parameters: Record<string, unknown>; validate?: SchemaInput }>();
  const handlers = new Map<string, ToolHandler>();
  for (const tool of def.tools ?? []) specs.set(tool.name, { ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters });
  for (const [name, given] of Object.entries(options.tools ?? {})) {
    if (typeof given === "function") {
      if (!specs.has(name)) throw new GatewayError(`tool "${name}" has a function but no definition: declare it in the prompt or pass { parameters, execute }`);
      handlers.set(name, given);
      continue;
    }
    const parameters = toJsonSchema(given.parameters);
    if (!parameters) throw new GatewayError(`tool "${name}": its schema library cannot produce JSON Schema, which the model needs`);
    specs.set(name, { ...(given.description ? { description: given.description } : {}), parameters, validate: given.parameters });
    if (given.execute) handlers.set(name, given.execute);
  }

  // Output: a schema passed to the call replaces the prompt's.
  const outputSchema: SchemaInput | undefined = options.output ?? def.output?.schema;
  let responseFormat: Record<string, unknown> | undefined;
  if (outputSchema) {
    // A validator that cannot describe itself still works if the prompt carries a schema to show the model.
    const schema = toJsonSchema(outputSchema) ?? def.output?.schema;
    if (!schema) throw new GatewayError("output: this schema library cannot produce JSON Schema, and the prompt has no output schema to send instead");
    const strict = options.output ? undefined : def.output?.strict;
    responseFormat = {
      type: "json_schema",
      json_schema: { name: (options.output ? undefined : def.output?.name) ?? "output", schema, ...(strict === undefined ? {} : { strict }) },
    };
  }

  const transcript = [...messages];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const maxSteps = options.maxSteps ?? 8;
  const body = {
    model,
    ...def.model?.params,
    ...options.params,
    ...(specs.size ? { tools: [...specs].map(([name, s]) => ({ type: "function", function: { name, ...(s.description ? { description: s.description } : {}), parameters: s.parameters } })) } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };

  for (let steps = 1; ; steps++) {
    const completion = await callGateway(gateway, { ...body, messages: transcript }, options.signal);
    const choice = completion.choices[0]!;
    const message: ChatMessage = { ...choice.message, role: "assistant", content: choice.message.content ?? null };
    transcript.push(message);
    usage.inputTokens += completion.usage?.prompt_tokens ?? 0;
    usage.outputTokens += completion.usage?.completion_tokens ?? 0;
    usage.totalTokens += completion.usage?.total_tokens ?? (completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0);

    const calls = message.tool_calls ?? [];
    const done = (output: unknown, toolCalls: ToolCall[]) => ({
      text: message.content ?? "",
      output: output as never,
      messages: transcript,
      toolCalls,
      steps,
      usage,
      finishReason: choice.finish_reason,
      model,
      prompt,
    });

    if (calls.length) {
      // Any call we cannot run ourselves hands control back, with nothing half-executed.
      if (!calls.every((c) => handlers.has(c.function.name))) return done(undefined, calls);
      if (steps >= maxSteps) throw new ToolLoopError(maxSteps, transcript);
      for (const call of calls) {
        const name = call.function.name;
        let content: string;
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments || "{}");
          const check = specs.get(name)?.validate;
          const valid = check ? await validateSchema(check, args) : ({ ok: true, value: args } as const);
          // Bad arguments are the model's mistake: tell it, so it can correct itself.
          content = valid.ok ? "" : `Error: invalid arguments: ${valid.issues.join("; ")}`;
          if (valid.ok) args = valid.value;
        } catch {
          content = "Error: arguments were not valid JSON";
        }
        // A function that throws is the application's failure, not the model's: it propagates.
        if (!content) content = stringify(await handlers.get(name)!(args, { toolCallId: call.id, name }));
        transcript.push({ role: "tool", tool_call_id: call.id, content });
      }
      continue;
    }

    if (!outputSchema) return done(undefined, []);
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.content ?? "");
    } catch {
      throw new OutputValidationError(["reply is not valid JSON"], message.content ?? "");
    }
    const valid = await validateSchema(outputSchema, parsed);
    if (!valid.ok) throw new OutputValidationError(valid.issues, message.content ?? "");
    return done(valid.value, []);
  }
}

/** Render a prompt and run it. */
export function run<S extends SchemaInput | undefined>(gateway: GatewayConfig | undefined, prompt: ResolvedPrompt, options: RunOptions<S> = {}) {
  const messages: ChatMessage[] = [...renderPrompt(prompt.definition, options), ...(options.messages ?? [])];
  return complete(gateway, prompt, messages, options);
}

export interface ChatSession {
  /** The conversation so far, including the rendered prompt once the first message has been sent. */
  readonly messages: readonly ChatMessage[];
  /** Add a user message and get the reply. Per-call options override the session's. */
  send<S extends SchemaInput | undefined = undefined>(content: string, options?: CallOptions<S>): Promise<RunResult<S extends SchemaInput ? InferSchema<S> : unknown>>;
}

/** A multi-turn conversation: the prompt is rendered once, then each `send` continues from the last reply. */
export function chat(gateway: GatewayConfig | undefined, load: () => Promise<ResolvedPrompt>, options: RunOptions = {}): ChatSession {
  let history: ChatMessage[] | undefined;
  let prompt: ResolvedPrompt | undefined;
  return {
    get messages() {
      return history ?? [];
    },
    async send(content, perCall) {
      prompt ??= await load();
      const base = history ?? [...renderPrompt(prompt.definition, options), ...(options.messages ?? [])];
      const result = await complete(gateway, prompt, [...base, { role: "user", content }], { ...options, ...perCall });
      history = result.messages; // only a successful turn becomes part of the conversation
      return result as never;
    },
  };
}
