/**
 * The generic OpenTelemetry target and the OpenTelemetry bridge. The bridge is tested against the
 * real `@opentelemetry/api` and SDK (installed for tests only), since its whole point is to agree
 * with them. Also pins the bridge decisions in docs/decisions.md.
 */
import * as api from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createClient,
  genericAttributes,
  memory,
  type OpenTelemetryApi,
  otlp,
  type PlatformAdapter,
  pii,
  type SpanRecord,
} from "../src/index.ts";

const exported = new InMemorySpanExporter();
beforeAll(() => {
  api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  api.trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exported)] }));
});
beforeEach(() => exported.reset());

/** A platform that records the spans this SDK exports to it directly. */
function collector() {
  const spans: SpanRecord[] = [];
  const adapter: PlatformAdapter = {
    id: "c",
    tracing: {
      url: "https://c.test",
      headers: {},
      attributes: (s) => (spans.push(s), {}),
      fetch: (async () => new Response("{}")) as typeof fetch,
    },
  };
  return { adapter, spans };
}
const gateway = (...replies: string[]) => ({
  baseURL: "https://gw.test/v1",
  fetch: (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: replies.shift() } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    )) as typeof fetch,
});
const otelSpan = (name: string) => exported.getFinishedSpans().find((s) => s.name === name)!;

describe("OpenTelemetry bridge", () => {
  it("each span is also an OpenTelemetry span with the same ids, exported by the application's pipeline", async () => {
    const c = collector();
    const client = createClient({ platform: c.adapter, openTelemetry: api });
    await client.trace("work", { input: { q: 1 }, userId: "u1", tags: ["beta"], metadata: { region: "eu" } }, () =>
      client.trace("step", () => "done"),
    );
    await client.flush();

    const [work, step] = [otelSpan("work"), otelSpan("step")];
    expect(work.attributes).toMatchObject({
      "tas.span.kind": "span",
      "input.value": '{"q":1}',
      "output.value": "done",
      "user.id": "u1",
      "tas.metadata.region": "eu",
      "tas.tags": ["beta"],
    });
    expect(step.spanContext().traceId).toBe(work.spanContext().traceId);
    expect(step.parentSpanContext?.spanId).toBe(work.spanContext().spanId);
    // What we send to the platform ourselves names the very same spans.
    const ours = Object.fromEntries(c.spans.map((s) => [s.name, s]));
    expect([ours.work!.traceId, ours.work!.spanId]).toEqual([work.spanContext().traceId, work.spanContext().spanId]);
    expect(ours.step).toMatchObject({ spanId: step.spanContext().spanId, parentSpanId: work.spanContext().spanId });
  });

  it("nests under the application's active span, and the application's spans nest under ours", async () => {
    const c = collector();
    const client = createClient({ platform: c.adapter, openTelemetry: api });
    const app = api.trace.getTracer("app");
    await app.startActiveSpan("http request", async (request) => {
      await client.trace("handle", () => app.startActiveSpan("db query", (query) => query.end()));
      request.end();
    });
    await client.flush();

    const [request, handle, query] = [otelSpan("http request"), otelSpan("handle"), otelSpan("db query")];
    expect(handle.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    expect(query.parentSpanContext?.spanId).toBe(handle.spanContext().spanId);
    expect(new Set([request, handle, query].map((s) => s.spanContext().traceId)).size).toBe(1);
    expect(c.spans[0]).toMatchObject({
      name: "handle",
      traceId: request.spanContext().traceId,
      parentSpanId: request.spanContext().spanId,
    });
  });

  it("model calls and failures arrive with model, usage and error status, masked like everything else", async () => {
    const client = createClient({
      platform: memory(),
      tracing: false, // only the application's pipeline exports
      openTelemetry: api,
      masking: { patterns: [pii.email] },
      gateway: gateway("Write to jo@example.com"),
      prompts: [
        { type: "chat", name: "ask", model: { id: "gpt-5", params: { temperature: 0 } }, messages: [{ role: "user", content: "{{q}}" }] },
      ],
    });
    await client.run("ask", { variables: { q: "mail for sam@example.com?" } });
    await client.trace("failing", () => Promise.reject(new Error("could not reach jo@example.com"))).catch(() => undefined);

    const generation = otelSpan("gpt-5");
    expect(generation.attributes).toMatchObject({
      "tas.span.kind": "generation",
      "gen_ai.request.model": "gpt-5",
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 2,
      "gen_ai.request.temperature": 0,
      "tas.prompt.name": "ask",
    });
    expect(generation.parentSpanContext?.spanId).toBe(otelSpan("ask").spanContext().spanId);
    expect(JSON.stringify(exported.getFinishedSpans().map((s) => s.attributes))).not.toContain("example.com");
    expect(otelSpan("failing").status).toEqual({ code: api.SpanStatusCode.ERROR, message: "could not reach [REDACTED]" });
  });

  it("without an OpenTelemetry SDK registered it falls back to its own ids and still works", async () => {
    const zero = {
      spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16) }),
      setAttribute: () => undefined,
      setStatus: () => undefined,
      end: () => undefined,
    };
    const noSdk: OpenTelemetryApi = {
      trace: { getTracer: () => ({ startSpan: () => zero }), setSpan: (context) => context, getSpan: () => undefined },
      context: { active: () => ({}), with: (_context, fn) => fn() },
    };
    const c = collector();
    const client = createClient({ platform: c.adapter, openTelemetry: noSdk });
    expect(await client.trace("outer", () => client.trace("inner", () => 7))).toBe(7);
    await client.flush();
    const [inner, outer] = c.spans;
    expect(outer!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(outer!.traceId).not.toBe("0".repeat(32));
    expect(inner).toMatchObject({ traceId: outer!.traceId, parentSpanId: outer!.spanId });
  });
});

describe("generic OpenTelemetry target", () => {
  const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => (
    sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) }),
    new Response("{}")
  )) as typeof fetch;
  const attributesOf = (name: string) => {
    const span = sent.flatMap((r) => r.body.resourceSpans[0].scopeSpans[0].spans).find((s: any) => s.name === name);
    return Object.fromEntries(span.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
  };
  beforeEach(() => {
    sent.length = 0;
  });

  it("sends spans to any OTLP endpoint with vendor-neutral attributes", async () => {
    const target = otlp({ url: "http://localhost:4318/v1/traces", headers: { "x-team": "cx" }, fetch: fetchImpl });
    expect(target).toMatchObject({ id: "otlp" });
    expect([target.prompts, target.datasets, target.experiments]).toEqual([undefined, undefined, undefined]);
    const client = createClient({ platform: memory(), tracing: [target] });
    await client.trace("work", { input: { q: 1 }, sessionId: "s1", metadata: { region: "eu" }, tags: ["a", "b"] }, () => "out");
    await client.flush();
    expect(sent[0]).toMatchObject({
      url: "http://localhost:4318/v1/traces",
      headers: { "x-team": "cx", "content-type": "application/json" },
    });
    expect(attributesOf("work")).toEqual({
      "tas.span.kind": "span",
      "session.id": "s1",
      "input.value": '{"q":1}',
      "output.value": "out",
      "tas.metadata.region": "eu",
      "tas.tags": { values: [{ stringValue: "a" }, { stringValue: "b" }] },
    });
  });

  it("lets you rename or add attributes for a backend with its own conventions", async () => {
    const target = otlp({
      url: "http://c.test/v1/traces",
      fetch: fetchImpl,
      attributes: (span, defaults) => ({ ...defaults, "service.operation": span.name }),
    });
    const client = createClient({ platform: target });
    await client.trace("work", () => undefined);
    await client.flush();
    expect(attributesOf("work")).toEqual({ "tas.span.kind": "span", "service.operation": "work" });
    expect(sent[0]!.headers).toEqual({ "content-type": "application/json" });
  });

  it("genericAttributes covers a model call", () => {
    const span: SpanRecord = {
      traceId: "t",
      spanId: "s",
      name: "gpt-5",
      kind: "generation",
      startTime: 0,
      endTime: 1,
      model: "gpt-5",
      modelParams: { temperature: 0 },
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      input: [{ role: "user", content: "hi" }],
      output: "yo",
      prompt: { name: "p", hash: "h", version: "7" },
    };
    expect(genericAttributes(span)).toEqual({
      "tas.span.kind": "generation",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-5",
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 2,
      "tas.prompt.name": "p",
      "tas.prompt.hash": "h",
      "tas.prompt.version": "7",
      "input.value": '[{"role":"user","content":"hi"}]',
      "output.value": "yo",
      "gen_ai.request.temperature": 0,
    });
  });
});
