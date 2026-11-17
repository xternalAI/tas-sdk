import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Masker } from "./masking.ts";

/**
 * Tracing. Spans are recorded in one vendor-neutral shape, masked in-process, then sent to each
 * configured platform as OpenTelemetry (OTLP over HTTP, JSON-encoded), with that platform's own
 * attribute names. All three platforms ingest this directly, so no OpenTelemetry SDK is needed.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type SpanKind = "span" | "generation" | "tool";

/** One finished span, already masked, as handed to exporters. */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  /** Milliseconds since the epoch. */
  startTime: number;
  endTime: number;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  /** Set on the root span and inherited by every span below it. */
  userId?: string;
  sessionId?: string;
  tags?: string[];
  model?: string;
  modelParams?: Record<string, unknown>;
  usage?: TokenUsage;
  /** Which prompt produced this span. `hash` identifies it on any platform; `version` only on `platform`. */
  prompt?: { name: string; hash: string; platform?: string; version?: string };
  error?: string;
}

export interface CaptureOptions {
  /** Default true. False drops inputs from this span and everything under it. */
  input?: boolean;
  /** Default true. False drops outputs from this span and everything under it. */
  output?: boolean;
}

export interface TraceOptions {
  input?: unknown;
  metadata?: Record<string, unknown>;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  capture?: CaptureOptions;
}

export interface SpanInit extends TraceOptions {
  kind?: SpanKind;
  model?: string;
  modelParams?: Record<string, unknown>;
  prompt?: SpanRecord["prompt"];
}

export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  /** Set or replace fields on the span before it ends. Metadata is merged. */
  update(patch: { input?: unknown; output?: unknown; metadata?: Record<string, unknown>; usage?: TokenUsage; model?: string }): void;
}

/** How one platform wants spans delivered. Provided by an adapter's `tracing`. */
export interface TraceExporter {
  url: string;
  headers: Record<string, string>;
  /** Translate a span into this platform's OpenTelemetry attribute names. */
  attributes(span: SpanRecord): Record<string, unknown>;
  fetch?: typeof fetch;
}

/** Text for an attribute: strings as they are, everything else as JSON. */
export const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** Attributes every platform gets: OpenTelemetry's GenAI names plus our own platform-independent prompt identity. */
export function commonAttributes(span: SpanRecord): Record<string, unknown> {
  return {
    "tas.span.kind": span.kind,
    ...(span.kind === "generation" ? { "gen_ai.operation.name": "chat" } : span.kind === "tool" ? { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": span.name } : {}),
    ...(span.model ? { "gen_ai.request.model": span.model } : {}),
    ...(span.usage ? { "gen_ai.usage.input_tokens": span.usage.inputTokens, "gen_ai.usage.output_tokens": span.usage.outputTokens } : {}),
    ...(span.prompt ? { "tas.prompt.name": span.prompt.name, "tas.prompt.hash": span.prompt.hash } : {}),
    ...(span.prompt?.version ? { "tas.prompt.version": span.prompt.version } : {}),
    ...(span.userId ? { "user.id": span.userId } : {}),
    ...(span.sessionId ? { "session.id": span.sessionId } : {}),
  };
}

function otlpValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return { arrayValue: { values: value.map((v) => ({ stringValue: v })) } };
  return { stringValue: JSON.stringify(value) };
}

/** Encode spans as an OTLP/HTTP JSON request body. */
export function toOtlp(spans: SpanRecord[], attributes: (span: SpanRecord) => Record<string, unknown>): unknown {
  const nanos = (ms: number) => String(BigInt(Math.round(ms * 1000)) * 1000n);
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "tas" } }] },
        scopeSpans: [
          {
            scope: { name: "@traceandscale/sdk" },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: span.kind === "generation" ? 3 : 1, // CLIENT for model calls, INTERNAL otherwise
              startTimeUnixNano: nanos(span.startTime),
              endTimeUnixNano: nanos(span.endTime),
              attributes: Object.entries(attributes(span))
                .filter(([, v]) => v !== undefined && v !== null)
                .map(([key, v]) => ({ key, value: otlpValue(v) })),
              status: span.error ? { code: 2, message: span.error } : {},
            })),
          },
        ],
      },
    ],
  };
}

export interface TracerOptions {
  exporters: TraceExporter[];
  mask: Masker;
  /** Called when a platform cannot be reached or rejects spans. Export problems never reach application code. */
  onError?: (error: Error) => void;
  /** Spans are sent when this many are waiting, or after `flushIntervalMs`. Defaults: 50 and 2000. */
  maxBatch?: number;
  flushIntervalMs?: number;
}

interface Active {
  tracer: Tracer;
  record: SpanRecord;
  capture: Required<CaptureOptions>;
}
const active = new AsyncLocalStorage<Active>();

export class Tracer {
  private readonly options: TracerOptions;
  private buffer: SpanRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = new Set<Promise<void>>();

  constructor(options: TracerOptions) {
    this.options = options;
  }

  get enabled(): boolean {
    return this.options.exporters.length > 0;
  }

  /**
   * Run `fn` inside a span. The span nests under whichever span of this tracer is already running
   * in the current async context; otherwise it starts a new trace.
   */
  async span<T>(name: string, init: SpanInit, fn: (span: SpanHandle) => T | Promise<T>): Promise<T> {
    const store = active.getStore();
    const parent = store?.tracer === this ? store : undefined;
    const capture = {
      input: (parent?.capture.input ?? true) && init.capture?.input !== false,
      output: (parent?.capture.output ?? true) && init.capture?.output !== false,
    };
    const userId = init.userId ?? parent?.record.userId;
    const sessionId = init.sessionId ?? parent?.record.sessionId;
    const tags = init.tags ?? parent?.record.tags;
    const record: SpanRecord = {
      traceId: parent?.record.traceId ?? randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      ...(parent ? { parentSpanId: parent.record.spanId } : {}),
      name,
      kind: init.kind ?? "span",
      startTime: Date.now(),
      endTime: 0,
      ...(init.input !== undefined ? { input: init.input } : {}),
      ...(init.metadata ? { metadata: { ...init.metadata } } : {}),
      ...(userId ? { userId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(tags ? { tags } : {}),
      ...(init.model ? { model: init.model } : {}),
      ...(init.modelParams ? { modelParams: init.modelParams } : {}),
      ...(init.prompt ? { prompt: init.prompt } : {}),
    };
    const handle: SpanHandle = {
      traceId: record.traceId,
      spanId: record.spanId,
      update(patch) {
        const { metadata, ...rest } = patch;
        Object.assign(record, rest);
        if (metadata) record.metadata = { ...record.metadata, ...metadata };
      },
    };

    try {
      const result = await active.run({ tracer: this, record, capture }, () => fn(handle));
      // What the block returned is its output, unless the block said otherwise.
      if (record.output === undefined && result !== undefined) record.output = result;
      return result;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      record.endTime = Date.now();
      this.finish(record, capture);
    }
  }

  private finish(record: SpanRecord, capture: Required<CaptureOptions>): void {
    if (!this.enabled) return;
    const mask = this.options.mask;
    if (!capture.input) delete record.input;
    if (!capture.output) delete record.output;
    // Masked here, once, before any exporter can see the span.
    if (record.input !== undefined) record.input = mask(record.input);
    if (record.output !== undefined) record.output = mask(record.output);
    if (record.metadata) record.metadata = mask(record.metadata);
    if (record.error) record.error = mask(record.error);
    this.buffer.push(record);
    if (this.buffer.length >= (this.options.maxBatch ?? 50)) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.options.flushIntervalMs ?? 2000);
      this.timer.unref?.(); // never keep a process alive just to send spans
    }
  }

  /** Send everything recorded so far and wait for it. Call before a short-lived process exits. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const spans = this.buffer;
    this.buffer = [];
    if (spans.length) {
      for (const exporter of this.options.exporters) {
        const sending = this.send(exporter, spans).finally(() => this.pending.delete(sending));
        this.pending.add(sending);
      }
    }
    await Promise.all(this.pending);
  }

  private async send(exporter: TraceExporter, spans: SpanRecord[]): Promise<void> {
    try {
      const response = await (exporter.fetch ?? fetch)(exporter.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...exporter.headers },
        body: JSON.stringify(toOtlp(spans, exporter.attributes)),
      });
      if (!response.ok) throw new Error(`${new URL(exporter.url).host} rejected ${spans.length} span(s): ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
    } catch (error) {
      const report = this.options.onError ?? ((e: Error) => console.warn(`tas: trace export failed: ${e.message}`));
      report(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
