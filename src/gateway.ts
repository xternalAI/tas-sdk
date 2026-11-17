import type { GatewayConfig } from "./config.ts";
import { fetchWithRetry } from "./http.ts";

/**
 * The wire level of invocation: one chat-completions request to an OpenAI-compatible endpoint,
 * with retries, returned either whole or as it streams. Nothing here knows about prompts, tools
 * loops or tracing; that is `run.ts`.
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

export interface Completion {
  message: ChatMessage;
  finishReason: string | undefined;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export class GatewayError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  /** Ask for a streamed reply and receive each piece of text as it arrives. */
  onText?: ((delta: string) => void) | undefined;
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface WireChunk {
  choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
  usage?: WireUsage | null;
}

function toUsage(usage: WireUsage | null | undefined): Completion["usage"] {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: usage?.total_tokens ?? inputTokens + outputTokens };
}

/** Parse a `text/event-stream` body into its JSON events, tolerating events split across network chunks. */
async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<WireChunk> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line.startsWith("data:")) continue; // blank separators, comments, event names
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield JSON.parse(data) as WireChunk;
    }
  }
}

/** Assemble a streamed reply into the same shape a non-streamed one has. */
async function readStream(body: ReadableStream<Uint8Array>, onText: (delta: string) => void): Promise<Completion> {
  let content = "";
  let finishReason: string | undefined;
  let usage: WireUsage | null | undefined;
  const calls: ToolCall[] = [];
  for await (const chunk of serverSentEvents(body)) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.delta?.content) {
      content += choice.delta.content;
      onText(choice.delta.content);
    }
    // A tool call arrives in pieces: its id and name first, then its arguments a few characters at a time.
    for (const piece of choice.delta?.tool_calls ?? []) {
      const call = (calls[piece.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.function.name += piece.function.name;
      if (piece.function?.arguments) call.function.arguments += piece.function.arguments;
    }
  }
  const toolCalls = calls.filter(Boolean);
  return {
    message: { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    finishReason,
    usage: toUsage(usage),
  };
}

/** Send one chat-completions request and return the reply. */
export async function requestCompletion(gateway: GatewayConfig, body: Record<string, unknown>, options: RequestOptions = {}): Promise<Completion> {
  const streaming = options.onText !== undefined;
  const response = await fetchWithRetry(
    gateway.fetch ?? fetch,
    gateway.baseURL.replace(/\/$/, "") + "/chat/completions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(gateway.apiKey ? { authorization: `Bearer ${gateway.apiKey}` } : {}),
        ...gateway.headers,
      },
      // `include_usage` makes the endpoint report token counts in the final streamed event.
      body: JSON.stringify(streaming ? { ...body, stream: true, stream_options: { include_usage: true } } : body),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    { retries: gateway.retries ?? 2, ...(gateway.retryDelayMs === undefined ? {} : { baseDelayMs: gateway.retryDelayMs }), ...(options.signal ? { signal: options.signal } : {}) },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GatewayError(`gateway returned ${response.status}: ${text.slice(0, 500)}`, response.status);
  }

  // An endpoint that ignores `stream: true` answers with plain JSON; treat that as one big piece.
  if (streaming && response.body && (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return readStream(response.body, options.onText!);
  }
  const reply = (await response.json()) as { choices?: { message?: ChatMessage; finish_reason?: string }[]; usage?: WireUsage };
  const choice = reply.choices?.[0];
  if (!choice?.message) throw new GatewayError("gateway reply has no choices[0].message");
  if (streaming && choice.message.content) options.onText!(choice.message.content);
  return {
    message: { ...choice.message, role: "assistant", content: choice.message.content ?? null },
    finishReason: choice.finish_reason,
    usage: toUsage(reply.usage),
  };
}
