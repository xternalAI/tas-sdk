import type { GatewayConfig } from "./config.ts";
import { GatewayError, requestCompletion, type ChatMessage, type ToolCall } from "./gateway.ts";
import type { PromptDefinition, ResolvedPrompt } from "./prompt/model.ts";
import { renderPrompt, type RenderInput } from "./prompt/template.ts";
import { toJsonSchema, validateSchema, type InferSchema, type SchemaInput } from "./schema.ts";
import type { SpanHandle, SpanInit, TokenUsage, TraceOptions, Tracer } from "./trace.ts";

/**
 * Invocation: turn a resolved prompt into model calls, using the model, settings, tools and
 * output schema stored with the prompt. This file is the orchestration (tool loop, structured
 * output, streaming, chat, tracing); the HTTP request itself is `gateway.ts`.
 */

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
  /** User, session, tags and metadata for the trace, and whether to record inputs and outputs. */
  trace?: TraceOptions;
}

export interface RunOptions<S extends SchemaInput | undefined = SchemaInput | undefined> extends CallOptions<S>, RenderInput {
  /** Appended after the rendered prompt, for example earlier turns of a conversation. */
  messages?: ChatMessage[];
}

export type Usage = TokenUsage;

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
type OutputOf<S> = S extends SchemaInput ? InferSchema<S> : unknown;

export type StreamEvent =
  /** A piece of the reply's text. */
  | { type: "text"; delta: string }
  /** The model asked for a tool. */
  | { type: "tool-call"; call: ToolCall }
  /** A tool finished (or its arguments were rejected); `content` is what the model is told. */
  | { type: "tool-result"; toolCallId: string; name: string; content: string };

/**
 * A run in progress. Iterate it for events, or iterate `text` for just the words, and await
 * `result` for the same value `run()` returns. Use one iterator per stream.
 */
export interface RunStream<Output = unknown> extends AsyncIterable<StreamEvent> {
  readonly text: AsyncIterable<string>;
  readonly result: Promise<RunResult<Output>>;
}

// ---------------------------------------------------------------------------------------------
// Pieces of one run
// ---------------------------------------------------------------------------------------------

type Emit = (event: StreamEvent) => void;
type SpanRunner = <T>(name: string, init: SpanInit, fn: (span: SpanHandle) => T | Promise<T>) => Promise<T>;
const untraced: SpanRunner = async (_name, _init, fn) => fn({ traceId: "", spanId: "", update() {} });
const spanRunner = (tracer: Tracer | undefined): SpanRunner => (tracer ? (name, init, fn) => tracer.span(name, init, fn) : untraced);

/** What every step of a run needs. `emit` is present only when the caller is streaming. */
interface Context {
  gateway: GatewayConfig | undefined;
  span: SpanRunner;
  emit?: Emit | undefined;
}

const promptRef = (prompt: ResolvedPrompt) => ({
  name: prompt.definition.name,
  hash: prompt.hash,
  ...(prompt.remote ? { platform: prompt.remote.platform, version: prompt.remote.version } : {}),
});
const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? null));

interface ResolvedTools {
  /** Tool definitions in the wire format, or undefined when there are none. */
  wire: unknown[] | undefined;
  handlers: Map<string, ToolHandler>;
  /** Schemas to check arguments against, for tools defined in code. */
  validators: Map<string, SchemaInput>;
}

/** The prompt's tool declarations, overlaid with functions and definitions given in code. */
function resolveTools(def: PromptDefinition, given: RunTools | undefined): ResolvedTools {
  const specs = new Map<string, { description?: string | undefined; parameters: Record<string, unknown> }>();
  const handlers = new Map<string, ToolHandler>();
  const validators = new Map<string, SchemaInput>();
  for (const tool of def.tools ?? []) specs.set(tool.name, { description: tool.description, parameters: tool.parameters });

  for (const [name, tool] of Object.entries(given ?? {})) {
    if (typeof tool === "function") {
      if (!specs.has(name)) throw new GatewayError(`tool "${name}" has a function but no definition: declare it in the prompt or pass { parameters, execute }`);
      handlers.set(name, tool);
      continue;
    }
    const parameters = toJsonSchema(tool.parameters);
    if (!parameters) throw new GatewayError(`tool "${name}": its schema library cannot produce JSON Schema, which the model needs`);
    specs.set(name, { description: tool.description, parameters });
    validators.set(name, tool.parameters);
    if (tool.execute) handlers.set(name, tool.execute);
  }

  const wire = [...specs].map(([name, spec]) => ({
    type: "function",
    function: { name, ...(spec.description ? { description: spec.description } : {}), parameters: spec.parameters },
  }));
  return { wire: wire.length ? wire : undefined, handlers, validators };
}

interface ResolvedOutput {
  /** What the reply is validated against. */
  schema: SchemaInput;
  /** The `response_format` that asks the model for it. */
  responseFormat: Record<string, unknown>;
}

/** The output contract for a run: a schema passed to the call replaces the prompt's. */
function resolveOutput(def: PromptDefinition, given: SchemaInput | undefined): ResolvedOutput | undefined {
  const schema = given ?? def.output?.schema;
  if (!schema) return undefined;
  // A validator that cannot describe itself still works if the prompt carries a schema to show the model.
  const forModel = toJsonSchema(schema) ?? def.output?.schema;
  if (!forModel) throw new GatewayError("output: this schema library cannot produce JSON Schema, and the prompt has no output schema to send instead");
  // The prompt's name and strict flag describe the prompt's schema, so they apply only when that is the one in use.
  const fromPrompt = given ? undefined : def.output;
  return {
    schema,
    responseFormat: {
      type: "json_schema",
      json_schema: { name: fromPrompt?.name ?? "output", schema: forModel, ...(fromPrompt?.strict === undefined ? {} : { strict: fromPrompt.strict }) },
    },
  };
}

/** Parse and validate a structured reply. */
async function parseOutput(schema: SchemaInput, text: string): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OutputValidationError(["reply is not valid JSON"], text);
  }
  const valid = await validateSchema(schema, parsed);
  if (!valid.ok) throw new OutputValidationError(valid.issues, text);
  return valid.value;
}

/**
 * Run one tool call and return what the model should be told.
 * Bad arguments are the model's mistake, so it gets an error message it can act on.
 * A function that throws is the application's failure, so that propagates to the caller.
 */
async function executeToolCall(call: ToolCall, tools: ResolvedTools, span: SpanRunner): Promise<string> {
  const name = call.function.name;
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return "Error: arguments were not valid JSON";
  }
  const validator = tools.validators.get(name);
  if (validator) {
    const valid = await validateSchema(validator, args);
    if (!valid.ok) return `Error: invalid arguments: ${valid.issues.join("; ")}`;
    args = valid.value;
  }
  return asText(await span(name, { kind: "tool", input: args }, () => tools.handlers.get(name)!(args, { toolCallId: call.id, name })));
}

// ---------------------------------------------------------------------------------------------
// The run loop
// ---------------------------------------------------------------------------------------------

/** Run `messages` against the gateway with the prompt's configuration, looping over tool calls. */
async function execute<S extends SchemaInput | undefined>(ctx: Context, prompt: ResolvedPrompt, messages: ChatMessage[], options: CallOptions<S>): Promise<RunResult<OutputOf<S>>> {
  const def = prompt.definition;
  const { gateway } = ctx;
  if (!gateway) throw new GatewayError("no gateway configured: set `gateway` in the client config");
  const modelId = options.model ?? def.model?.id;
  if (!modelId) throw new GatewayError(`prompt "${def.name}" names no model: add one to the prompt or pass { model }`);
  const model = gateway.models?.[modelId] ?? modelId;

  const tools = resolveTools(def, options.tools);
  const output = resolveOutput(def, options.output);
  const modelParams = { ...def.model?.params, ...options.params };
  const body = { model, ...modelParams, ...(tools.wire ? { tools: tools.wire } : {}), ...(output ? { response_format: output.responseFormat } : {}) };

  const transcript = [...messages];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const maxSteps = options.maxSteps ?? 8;
  const onText = ctx.emit && ((delta: string) => ctx.emit!({ type: "text", delta }));

  for (let steps = 1; ; steps++) {
    // One span per model call, carrying exactly what was sent and what came back.
    const reply = await ctx.span(model, { kind: "generation", input: [...transcript], model, modelParams, prompt: promptRef(prompt) }, async (generation) => {
      const completion = await requestCompletion(gateway, { ...body, messages: transcript }, { signal: options.signal, onText });
      generation.update({ output: completion.message, usage: completion.usage });
      return completion;
    });
    transcript.push(reply.message);
    usage.inputTokens += reply.usage.inputTokens;
    usage.outputTokens += reply.usage.outputTokens;
    usage.totalTokens += reply.usage.totalTokens;

    const text = reply.message.content ?? "";
    const finish = (value: unknown, toolCalls: ToolCall[]): RunResult<OutputOf<S>> => ({
      text,
      output: value as OutputOf<S>,
      messages: transcript,
      toolCalls,
      steps,
      usage,
      finishReason: reply.finishReason,
      model,
      prompt,
    });

    const calls = reply.message.tool_calls ?? [];
    if (!calls.length) return finish(output ? await parseOutput(output.schema, text) : undefined, []);

    for (const call of calls) ctx.emit?.({ type: "tool-call", call });
    // Any call we cannot run ourselves hands control back, with nothing half-executed.
    if (!calls.every((call) => tools.handlers.has(call.function.name))) return finish(undefined, calls);
    if (steps >= maxSteps) throw new ToolLoopError(maxSteps, transcript);
    for (const call of calls) {
      const content = await executeToolCall(call, tools, ctx.span);
      transcript.push({ role: "tool", tool_call_id: call.id, content });
      ctx.emit?.({ type: "tool-result", toolCallId: call.id, name: call.function.name, content });
    }
  }
}

/** Render a prompt and run it inside a span named after it; model calls and tool executions nest under that. */
function runPrompt<S extends SchemaInput | undefined>(ctx: Context, prompt: ResolvedPrompt, options: RunOptions<S>): Promise<RunResult<OutputOf<S>>> {
  return ctx.span(prompt.definition.name, { ...options.trace, input: options.variables ?? {}, prompt: promptRef(prompt) }, async (root) => {
    const messages: ChatMessage[] = [...renderPrompt(prompt.definition, options), ...(options.messages ?? [])];
    const result = await execute(ctx, prompt, messages, options);
    root.update({ output: result.output ?? result.text });
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------------------------

/**
 * Turn a run that reports progress through `emit` into something to iterate. Events are queued,
 * so a consumer that only awaits `result` never holds the run back.
 */
function toStream<Output>(start: (emit: Emit) => Promise<RunResult<Output>>): RunStream<Output> {
  const queue: StreamEvent[] = [];
  let finished = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };

  const result = start((event) => {
    queue.push(event);
    notify();
  });
  result.then(
    () => ((finished = true), notify()),
    (error: unknown) => ((failure = error), (finished = true), notify()),
  );

  async function* events(): AsyncGenerator<StreamEvent> {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (finished) {
        if (failure !== undefined) throw failure; // an iterating consumer learns of the failure too
        return;
      }
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  async function* text(): AsyncGenerator<string> {
    for await (const event of events()) if (event.type === "text") yield event.delta;
  }
  return { [Symbol.asyncIterator]: events, text: { [Symbol.asyncIterator]: text }, result };
}

// ---------------------------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------------------------

/** Render a prompt and run it. */
export function run<S extends SchemaInput | undefined>(gateway: GatewayConfig | undefined, prompt: ResolvedPrompt, options: RunOptions<S> = {}, tracer?: Tracer): Promise<RunResult<OutputOf<S>>> {
  return runPrompt({ gateway, span: spanRunner(tracer) }, prompt, options);
}

/** Render a prompt and run it, reporting text and tool activity as it happens. `load` may fetch the prompt lazily. */
export function stream<S extends SchemaInput | undefined>(gateway: GatewayConfig | undefined, load: () => Promise<ResolvedPrompt>, options: RunOptions<S> = {}, tracer?: Tracer): RunStream<OutputOf<S>> {
  return toStream(async (emit) => runPrompt({ gateway, span: spanRunner(tracer), emit }, await load(), options));
}

/** Run messages you assembled yourself against a prompt's configuration, without rendering it. */
export function complete<S extends SchemaInput | undefined>(gateway: GatewayConfig | undefined, prompt: ResolvedPrompt, messages: ChatMessage[], options: CallOptions<S> = {}, tracer?: Tracer): Promise<RunResult<OutputOf<S>>> {
  return execute({ gateway, span: spanRunner(tracer) }, prompt, messages, options);
}

export interface ChatSession {
  /** The conversation so far, including the rendered prompt once the first message has been sent. */
  readonly messages: readonly ChatMessage[];
  /** Add a user message and get the reply. Per-call options override the session's. */
  send<S extends SchemaInput | undefined = undefined>(content: string, options?: CallOptions<S>): Promise<RunResult<OutputOf<S>>>;
  /** As `send`, but streamed. */
  stream<S extends SchemaInput | undefined = undefined>(content: string, options?: CallOptions<S>): RunStream<OutputOf<S>>;
}

/** A multi-turn conversation: the prompt is rendered once, then each turn continues from the last reply. */
export function chat(gateway: GatewayConfig | undefined, load: () => Promise<ResolvedPrompt>, options: RunOptions = {}, tracer?: Tracer): ChatSession {
  const span = spanRunner(tracer);
  let history: ChatMessage[] | undefined;
  let prompt: ResolvedPrompt | undefined;

  async function turn<S extends SchemaInput | undefined>(content: string, perCall: CallOptions<S> | undefined, emit?: Emit): Promise<RunResult<OutputOf<S>>> {
    const loaded = (prompt ??= await load());
    // Each turn is its own trace; give the session a `trace.sessionId` to group them on the platform.
    return span(loaded.definition.name, { ...options.trace, ...perCall?.trace, input: content, prompt: promptRef(loaded) }, async (root) => {
      const base = history ?? [...renderPrompt(loaded.definition, options), ...(options.messages ?? [])];
      const result = await execute({ gateway, span, emit }, loaded, [...base, { role: "user", content }], { ...options, ...perCall } as CallOptions<S>);
      history = result.messages; // only a successful turn becomes part of the conversation
      root.update({ output: result.output ?? result.text });
      return result;
    });
  }

  return {
    get messages() {
      return history ?? [];
    },
    send: (content, perCall) => turn(content, perCall),
    stream: (content, perCall) => toStream((emit) => turn(content, perCall, emit)),
  };
}
