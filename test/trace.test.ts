/**
 * Tracing and masking. Also pins the tracing decisions in docs/decisions.md: masking happens once
 * before any exporter, export failures never reach application code, user/session/tags are not
 * masked, capture settings are inherited, and each client's traces stay its own.
 */
import { describe, expect, it } from "vitest";
import {
  braintrust,
  createClient,
  langfuse,
  langsmith,
  memory,
  type PlatformAdapter,
  type PromptDefinition,
  pii,
  type SpanRecord,
  type TasConfig,
  Tracer,
  toOtlp,
} from "../src/index.ts";

/** A platform that records the spans it is sent, decoded back from the OTLP request. */
function collector(id = "collector", status = 200) {
  const spans: SpanRecord[] = [];
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const adapter: PlatformAdapter = {
    id,
    tracing: {
      url: `https://${id}.test/v1/traces`,
      headers: { "x-collector": id },
      attributes: (span) => ({ record: JSON.stringify(span) }),
      fetch: (async (url: URL | RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(String(init!.body));
        requests.push({ url: String(url), headers: init!.headers as Record<string, string>, body });
        if (status === 200)
          for (const s of body.resourceSpans[0].scopeSpans[0].spans) spans.push(JSON.parse(s.attributes[0].value.stringValue));
        return new Response("{}", { status });
      }) as typeof fetch,
    },
  };
  return { adapter, spans, requests };
}

function gateway(...contents: (string | { tool: string; args: string })[]) {
  const fetchImpl = (async () => {
    const next = contents.shift()!;
    const message =
      typeof next === "string"
        ? { role: "assistant", content: next }
        : {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: next.tool, arguments: next.args } }],
          };
    return new Response(
      JSON.stringify({
        choices: [{ message, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
    );
  }) as typeof fetch;
  return { baseURL: "https://gw.test/v1", fetch: fetchImpl, models: { "gpt-5": "openai/gpt-5" } };
}

const ask: PromptDefinition = {
  type: "chat",
  name: "support/ask",
  model: { id: "gpt-5", params: { temperature: 0 } },
  messages: [{ role: "user", content: "{{question}} (from {{email}})" }],
  tools: [{ name: "lookup", parameters: { type: "object" } }],
};
const byName = (spans: SpanRecord[], name: string) => spans.find((s) => s.name === name)!;

describe("tracing", () => {
  it("nests spans, records what a block returns, and records errors without swallowing them", async () => {
    const c = collector();
    const client = createClient({ platform: c.adapter });
    const result = await client.trace("request", { input: { path: "/x" }, metadata: { region: "eu" } }, async (root) => {
      root.update({ metadata: { attempt: 1 } });
      await client.trace("step", () => 42);
      await expect(client.trace("failing", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      return "done";
    });
    await client.flush();

    expect(result).toBe("done");
    const [root, step, failing] = [byName(c.spans, "request"), byName(c.spans, "step"), byName(c.spans, "failing")];
    expect(root).toMatchObject({ kind: "span", input: { path: "/x" }, output: "done", metadata: { region: "eu", attempt: 1 } });
    expect(root.parentSpanId).toBeUndefined();
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(step).toMatchObject({ traceId: root.traceId, parentSpanId: root.spanId, output: 42 });
    expect(failing).toMatchObject({ traceId: root.traceId, error: "boom" });
    expect(root.endTime).toBeGreaterThanOrEqual(root.startTime);
  });

  it("traces a run automatically: the run, each model call and each tool execution", async () => {
    const c = collector();
    const client = createClient({
      platform: c.adapter,
      prompts: [ask],
      gateway: gateway({ tool: "lookup", args: '{"id":1}' }, "It shipped."),
    });
    await client.trace("handle-ticket", { userId: "u1", sessionId: "s1", tags: ["beta"] }, () =>
      client.run("support/ask", {
        variables: { question: "Where is it?", email: "a@b.co" },
        tools: { lookup: () => ({ status: "shipped" }) },
      }),
    );
    await client.flush();

    const root = byName(c.spans, "handle-ticket");
    const run = byName(c.spans, "support/ask");
    const generations = c.spans.filter((s) => s.kind === "generation");
    const tool = byName(c.spans, "lookup");
    expect(c.spans).toHaveLength(5);
    expect(run).toMatchObject({ parentSpanId: root.spanId, input: { question: "Where is it?", email: "a@b.co" }, output: "It shipped." });
    expect(generations).toHaveLength(2);
    expect(generations[0]).toMatchObject({
      name: "openai/gpt-5",
      parentSpanId: run.spanId,
      model: "openai/gpt-5",
      modelParams: { temperature: 0 },
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      input: [{ role: "user", content: "Where is it? (from a@b.co)" }],
    });
    expect(generations[1]!.output).toMatchObject({ content: "It shipped." });
    expect(tool).toMatchObject({ kind: "tool", parentSpanId: run.spanId, input: { id: 1 }, output: { status: "shipped" } });
    // User, session and tags flow from the root to everything under it.
    for (const span of c.spans) expect(span).toMatchObject({ traceId: root.traceId, userId: "u1", sessionId: "s1", tags: ["beta"] });
  });

  it("identifies the prompt by hash everywhere, and by platform version only when a platform served it", async () => {
    const local = collector();
    await createClient({ platform: local.adapter, prompts: [ask], gateway: gateway("a") })
      .run("support/ask", { variables: { question: "q", email: "e" } })
      .then(() => undefined);
    const platform = memory();
    const pushed = await platform.prompts!.push(ask, { labels: ["production"] });
    const remote = collector();
    const fromPlatform = createClient({ platform, canonical: "platform", tracing: [remote.adapter], gateway: gateway("b") });
    await fromPlatform.run("support/ask", { variables: { question: "q", email: "e" } });
    await fromPlatform.flush();

    const viaPlatform = remote.spans.find((s) => s.kind === "generation")!.prompt!;
    expect(viaPlatform).toEqual({ name: "support/ask", hash: viaPlatform.hash, platform: "memory", version: pushed.version });
    expect(viaPlatform.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("each chat turn is its own trace, grouped by the session id you give it", async () => {
    const c = collector();
    const client = createClient({
      platform: c.adapter,
      prompts: [{ ...ask, messages: [{ role: "system", content: "Help." }] }],
      gateway: gateway("one", "two"),
    });
    const session = client.chat("support/ask", { trace: { sessionId: "conv-9" } });
    await session.send("hi");
    await session.send("again");
    await client.flush();
    const turns = c.spans.filter((s) => s.name === "support/ask");
    expect(turns.map((t) => [t.input, t.output, t.sessionId])).toEqual([
      ["hi", "one", "conv-9"],
      ["again", "two", "conv-9"],
    ]);
    expect(turns[0]!.traceId).not.toBe(turns[1]!.traceId);
  });
});

describe("decisions: masking and capture", () => {
  const masking = { keys: ["email", /token/i], patterns: [pii.email] };
  const config = (extra: Partial<TasConfig>): TasConfig => ({ platform: memory(), prompts: [ask], masking, ...extra });

  it("masks inputs, outputs, metadata and error text once, before any platform sees them, identically for all", async () => {
    const a = collector("a"),
      b = collector("b");
    const client = createClient(config({ tracing: [a.adapter, b.adapter], gateway: gateway("Write to jo@example.com") }));
    await client
      .trace(
        "request",
        { input: { email: "jo@example.com", note: "cc sam@example.com" }, metadata: { apiToken: "t-1", plan: "pro" } },
        async () => {
          await client.run("support/ask", { variables: { question: "hi", email: "jo@example.com" } });
          throw new Error("could not notify jo@example.com");
        },
      )
      .catch(() => undefined);
    await client.flush();

    const root = byName(a.spans, "request");
    expect(root.input).toEqual({ email: "[REDACTED]", note: "cc [REDACTED]" });
    expect(root.metadata).toEqual({ apiToken: "[REDACTED]", plan: "pro" });
    expect(root.error).toBe("could not notify [REDACTED]");
    expect(byName(a.spans, "support/ask").input).toEqual({ question: "hi", email: "[REDACTED]" });
    const generation = a.spans.find((s) => s.kind === "generation")!;
    expect(generation.input).toEqual([{ role: "user", content: "hi (from [REDACTED])" }]);
    expect(generation.output).toMatchObject({ content: "Write to [REDACTED]" });
    expect(JSON.stringify(a.requests)).not.toContain("example.com");
    expect(b.spans).toEqual(a.spans);
  });

  it("masking changes only what is exported: the application and the model still get the real values", async () => {
    const c = collector();
    let sent = "";
    const gw = {
      baseURL: "https://gw.test/v1",
      fetch: (async (_u: unknown, init?: RequestInit) => (
        (sent = String(init!.body)),
        new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "mail jo@example.com" } }] }))
      )) as typeof fetch,
    };
    const result = await createClient(config({ tracing: [c.adapter], gateway: gw })).run("support/ask", {
      variables: { question: "hi", email: "jo@example.com" },
    });
    expect(sent).toContain("jo@example.com");
    expect(result.text).toBe("mail jo@example.com");
  });

  it("does not mask user id, session id, tags, span names or model names", async () => {
    const c = collector();
    const client = createClient(config({ tracing: [c.adapter] }));
    await client.trace(
      "mail jo@example.com",
      { userId: "jo@example.com", sessionId: "s-jo@example.com", tags: ["jo@example.com"] },
      () => undefined,
    );
    await client.flush();
    expect(c.spans[0]).toMatchObject({
      name: "mail jo@example.com",
      userId: "jo@example.com",
      sessionId: "s-jo@example.com",
      tags: ["jo@example.com"],
    });
  });

  it("capture: false drops inputs or outputs from a span and everything under it", async () => {
    const c = collector();
    const client = createClient(config({ tracing: [c.adapter], gateway: gateway("secret answer", "second") }));
    await client.trace("private", { input: "in", capture: { input: false, output: false } }, async () => {
      await client.run("support/ask", { variables: { question: "q", email: "e" } });
      return "out";
    });
    await client.run("support/ask", { variables: { question: "q", email: "e" }, trace: { capture: { output: false } } });
    await client.flush();

    const first = c.spans.filter((s) => s.traceId === byName(c.spans, "private").traceId);
    expect(first).toHaveLength(3);
    for (const span of first) expect([span.input, span.output]).toEqual([undefined, undefined]);
    expect(first.find((s) => s.kind === "generation")!.usage).toBeDefined(); // counts are kept, content is not
    const second = c.spans.filter((s) => !first.includes(s));
    for (const span of second) expect(span.output).toBeUndefined();
    expect(second.find((s) => s.kind === "generation")!.input).toBeDefined();
  });
});

describe("decisions: export", () => {
  it("a platform that is down or rejects spans never breaks the application", async () => {
    const bad = collector("bad", 500);
    const down: PlatformAdapter = {
      id: "down",
      tracing: {
        url: "https://down.test",
        headers: {},
        attributes: () => ({}),
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as typeof fetch,
      },
    };
    const good = collector("good");
    const errors: string[] = [];
    const client = createClient({
      platform: memory(),
      tracing: [bad.adapter, down, good.adapter],
      traceExport: { retryDelayMs: 1 },
      onTraceError: (e) => errors.push(e.message),
    });
    await expect(client.trace("work", () => "fine")).resolves.toBe("fine");
    await expect(client.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(2);
    expect(errors.join(" | ")).toMatch(/bad\.test rejected 1 span\(s\): 500/);
    expect(errors.join(" | ")).toContain("ECONNREFUSED");
    expect(good.spans).toHaveLength(1);
    expect(bad.requests).toHaveLength(3); // tried, then retried twice in the background, then dropped
  });

  it("traces go to `platform` by default, to every platform listed in `tracing`, and nowhere when it is false", async () => {
    const a = collector("a"),
      b = collector("b");
    const byDefault = createClient({ platform: a.adapter });
    const both = createClient({ platform: memory(), tracing: [a.adapter, b.adapter] });
    const off = createClient({ platform: a.adapter, tracing: false });
    for (const client of [byDefault, both, off]) {
      await client.trace("x", () => 1);
      await client.flush();
    }
    expect([a.spans.length, b.spans.length]).toEqual([2, 1]);
    expect(await off.trace("still runs", () => "yes")).toBe("yes");
  });

  it("keeps each client's traces separate: no shared exporters, masking or trace ids", async () => {
    const a = collector("a"),
      b = collector("b");
    const tenantA = createClient({ platform: a.adapter, masking: { keys: ["secret"] } });
    const tenantB = createClient({ platform: b.adapter });
    await tenantA.trace("outer", { input: { secret: 1 } }, () => tenantB.trace("inner", { input: { secret: 2 } }, () => undefined));
    await Promise.all([tenantA.flush(), tenantB.flush()]);
    expect(a.spans.map((s) => [s.name, s.input])).toEqual([["outer", { secret: "[REDACTED]" }]]);
    expect(b.spans.map((s) => [s.name, s.input, s.parentSpanId])).toEqual([["inner", { secret: 2 }, undefined]]);
    expect(b.spans[0]!.traceId).not.toBe(a.spans[0]!.traceId);
  });

  it("holds spans until flush or until a batch fills, and sends nothing when there is nothing", async () => {
    const c = collector();
    const tracer = new Tracer({ exporters: [c.adapter.tracing!], mask: (v) => v, batchSize: 3, intervalMs: 60_000 });
    await tracer.flush();
    expect(c.requests).toHaveLength(0);
    await tracer.span("1", {}, () => undefined);
    await tracer.span("2", {}, () => undefined);
    expect(c.requests).toHaveLength(0);
    await tracer.span("3", {}, () => undefined);
    await tracer.flush();
    expect(c.requests).toHaveLength(1);
    expect(c.spans).toHaveLength(3);
  });

  it("encodes spans as OTLP JSON", () => {
    const span: SpanRecord = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: "c".repeat(16),
      name: "n",
      kind: "generation",
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_000_250,
      error: "bad",
    };
    const body = toOtlp([span], () => ({
      text: "x",
      count: 3,
      ratio: 0.5,
      flag: true,
      list: ["a", "b"],
      object: { a: 1 },
      skipped: undefined,
    })) as any;
    expect(body.resourceSpans[0].scopeSpans[0].spans[0]).toEqual({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: "c".repeat(16),
      name: "n",
      kind: 3,
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000250000000",
      attributes: [
        { key: "text", value: { stringValue: "x" } },
        { key: "count", value: { intValue: "3" } },
        { key: "ratio", value: { doubleValue: 0.5 } },
        { key: "flag", value: { boolValue: true } },
        { key: "list", value: { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } } },
        { key: "object", value: { stringValue: '{"a":1}' } },
      ],
      status: { code: 2, message: "bad" },
    });
  });
});

describe("decisions: export never slows the application unless asked to", () => {
  /** A platform whose answers the test releases by hand, so "who waited for whom" can be observed. */
  function slowPlatform() {
    const calls: { spans: number; release: (status?: number) => void }[] = [];
    const adapter: PlatformAdapter = {
      id: "slow",
      tracing: {
        url: "https://slow.test/v1/traces",
        headers: {},
        attributes: () => ({}),
        fetch: ((_url: unknown, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const spans = JSON.parse(String(init!.body)).resourceSpans[0].scopeSpans[0].spans.length;
            calls.push({ spans, release: (status = 200) => resolve(new Response("{}", { status })) });
            init!.signal?.addEventListener("abort", () => reject(init!.signal!.reason));
          })) as typeof fetch,
      },
    };
    return { adapter, calls };
  }
  const settled = async (p: Promise<unknown>) =>
    Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 30))]);
  const nested = (client: ReturnType<typeof createClient>) => client.trace("outer", () => client.trace("inner", () => "value"));

  it("buffered (default): work returns at once and nothing is sent until the batch or timer", async () => {
    const slow = slowPlatform();
    const client = createClient({ platform: slow.adapter });
    expect(await nested(client)).toBe("value");
    expect(slow.calls).toHaveLength(0);
    const flushing = client.flush();
    expect(await settled(flushing)).toBe(false); // an explicit flush is the one thing that waits
    slow.calls[0]!.release();
    await flushing;
    expect(slow.calls[0]!.spans).toBe(2);
  });

  it("immediate: the whole trace is sent when its outermost span ends, without the caller waiting", async () => {
    const slow = slowPlatform();
    const client = createClient({ platform: slow.adapter, traceExport: { mode: "immediate" } });
    expect(await nested(client)).toBe("value"); // returned although the platform has not answered
    expect(slow.calls.map((c) => c.spans)).toEqual([2]); // one request for the trace, not one per span
    slow.calls[0]!.release();
    await client.flush();
  });

  it("blocking: the outermost call returns only after the platform answers; inner spans never wait", async () => {
    const slow = slowPlatform();
    const client = createClient({ platform: slow.adapter, traceExport: { mode: "blocking" } });
    let innerDone = false;
    const outer = client.trace("outer", async () => {
      await client.trace("inner", () => "value");
      innerDone = true; // reached with no request made yet: only the end of the trace waits
      expect(slow.calls).toHaveLength(0);
    });
    expect(await settled(outer)).toBe(false);
    expect(innerDone).toBe(true);
    slow.calls[0]!.release();
    await outer;
    expect(slow.calls.map((c) => c.spans)).toEqual([2]);
  });

  it("blocking still never throws export errors into the application, and still returns the result", async () => {
    const slow = slowPlatform();
    const errors: string[] = [];
    const client = createClient({ platform: slow.adapter, traceExport: { mode: "blocking" }, onTraceError: (e) => errors.push(e.message) });
    const work = client.trace("outer", () => "value");
    await new Promise((r) => setTimeout(r, 5));
    slow.calls[0]!.release(503);
    expect(await work).toBe("value");
    expect(errors).toHaveLength(1);
    const failing = client.trace("failing", () => Promise.reject(new Error("app error")));
    failing.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    slow.calls[1]!.release();
    await expect(failing).rejects.toThrow("app error"); // the application's own error still surfaces, after the trace is delivered
  });

  it("retries a failing platform in the background modes, but never in blocking mode", async () => {
    const attempts = async (mode: "buffered" | "immediate" | "blocking", retries?: number) => {
      const bad = collector("bad", 503);
      const client = createClient({
        platform: bad.adapter,
        traceExport: { mode, retryDelayMs: 1, ...(retries === undefined ? {} : { retries }) },
        onTraceError: () => undefined,
      });
      await client.trace("work", () => 1);
      await client.flush();
      return bad.requests.length;
    };
    expect(await attempts("buffered")).toBe(3);
    expect(await attempts("immediate")).toBe(3);
    expect(await attempts("blocking")).toBe(1); // every attempt would be added to the caller's wait
    expect(await attempts("blocking", 1)).toBe(2); // unless asked for
    expect(await attempts("buffered", 0)).toBe(1);
  });

  it("gives up on a platform that never answers, so blocking calls and shutdown cannot hang", async () => {
    const slow = slowPlatform();
    const errors: string[] = [];
    const client = createClient({
      platform: slow.adapter,
      traceExport: { mode: "blocking", timeoutMs: 40 },
      onTraceError: (e) => errors.push(e.message),
    });
    const started = Date.now();
    expect(await client.trace("outer", () => "value")).toBe("value");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/timeout|aborted/i);
  });

  it("records values as they were when the span ended, with or without masking rules", async () => {
    for (const masking of [undefined, { keys: ["secret"] }]) {
      const c = collector();
      const client = createClient({ platform: c.adapter, ...(masking ? { masking } : {}) });
      const input = { items: [1], nested: { note: "before" } };
      const output = { status: "open", handler: () => 1 };
      await client.trace("work", { input }, () => output);
      input.items.push(2);
      input.nested.note = "after";
      output.status = "closed";
      await client.flush();
      expect(c.spans[0]).toMatchObject({ input: { items: [1], nested: { note: "before" } }, output: { status: "open" } });
    }
  });

  it("with tracing off, or no platform that takes traces, nothing is recorded or waited for in any mode", async () => {
    for (const mode of ["buffered", "immediate", "blocking"] as const) {
      const client = createClient({ platform: memory(), traceExport: { mode } });
      expect(await nested(client)).toBe("value");
      await client.flush();
    }
  });
});

describe("platform trace mapping", () => {
  /** Send one traced run through a real adapter's exporter and return the request it made. */
  async function exported(
    adapter: PlatformAdapter,
    capture: { url?: string; headers?: Record<string, string>; body?: any },
    servedBy?: string,
  ) {
    const prompt = {
      definition: ask,
      hash: "h".repeat(64),
      source: "remote" as const,
      remote: { platform: servedBy ?? "elsewhere", version: "7", labels: [] },
    };
    const tracer = new Tracer({ exporters: [adapter.tracing!], mask: (v) => v });
    await tracer.span("request", { input: { q: 1 }, metadata: { region: "eu" }, userId: "u1", sessionId: "s1", tags: ["beta", "eu"] }, () =>
      tracer.span(
        "openai/gpt-5",
        {
          kind: "generation",
          input: [{ role: "user", content: "hi" }],
          model: "openai/gpt-5",
          modelParams: { temperature: 0 },
          prompt: { name: "support/ask", hash: prompt.hash, platform: prompt.remote.platform, version: "7" },
        },
        (s) => {
          s.update({ output: { role: "assistant", content: "yo" }, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
        },
      ),
    );
    await tracer.flush();
    const spans = capture.body.resourceSpans[0].scopeSpans[0].spans as any[];
    const attrs = (name: string) =>
      Object.fromEntries(spans.find((s) => s.name === name).attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
    return { root: attrs("request"), generation: attrs("openai/gpt-5") };
  }
  const capturing = () => {
    const capture: { url?: string; headers?: Record<string, string>; body?: any } = {};
    const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => (
      Object.assign(capture, { url: String(url), headers: init!.headers, body: JSON.parse(String(init!.body)) }), new Response("{}")
    )) as typeof fetch;
    return { capture, fetch: fetchImpl };
  };
  const common = {
    "gen_ai.request.model": "openai/gpt-5",
    "gen_ai.usage.input_tokens": "7",
    "gen_ai.usage.output_tokens": "3",
    "tas.prompt.name": "support/ask",
    "tas.prompt.hash": "h".repeat(64),
  };

  it("Braintrust", async () => {
    const { capture, fetch } = capturing();
    const { root, generation } = await exported(braintrust({ apiKey: "k", projectName: "demo", fetch }), capture);
    expect(capture.url).toBe("https://api.braintrust.dev/otel/v1/traces");
    expect(capture.headers).toMatchObject({ authorization: "Bearer k", "x-bt-parent": "project_name:demo" });
    expect(root).toMatchObject({
      "braintrust.span_attributes.type": "task",
      "braintrust.input_json": '{"q":1}',
      "braintrust.tags": { values: [{ stringValue: "beta" }, { stringValue: "eu" }] },
    });
    expect(JSON.parse(root["braintrust.metadata"])).toEqual({ region: "eu", user_id: "u1", session_id: "s1" });
    expect(generation).toMatchObject({
      ...common,
      "braintrust.span_attributes.type": "llm",
      "braintrust.output_json": '{"role":"assistant","content":"yo"}',
    });
    expect(JSON.parse(generation["braintrust.metrics"])).toEqual({ prompt_tokens: 7, completion_tokens: 3, tokens: 10 });
    expect(JSON.parse(generation["braintrust.metadata"])).toMatchObject({
      model: "openai/gpt-5",
      temperature: 0,
      prompt: { name: "support/ask", version: "7" },
    });
    expect(generation["braintrust.tags"]).toBeUndefined(); // tags belong to the root span
  });

  it("Langfuse", async () => {
    const { capture, fetch } = capturing();
    const adapter = langfuse({ publicKey: "pk", secretKey: "sk", fetch });
    const { root, generation } = await exported(adapter, capture);
    expect(capture.url).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");
    expect(capture.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("pk:sk").toString("base64")}`,
      "x-langfuse-ingestion-version": "4",
    });
    expect(root).toMatchObject({
      "langfuse.observation.type": "span",
      "langfuse.trace.name": "request",
      "langfuse.observation.input": '{"q":1}',
      "langfuse.observation.metadata.region": "eu",
      "langfuse.user.id": "u1",
      "langfuse.session.id": "s1",
    });
    expect(generation).toMatchObject({
      ...common,
      "langfuse.observation.type": "generation",
      "langfuse.observation.model.name": "openai/gpt-5",
      "langfuse.observation.model.parameters": '{"temperature":0}',
      "langfuse.observation.usage_details": '{"input":7,"output":3,"total":10}',
    });
    // The prompt came from another platform, so there is no Langfuse version to link to.
    expect(generation["langfuse.observation.prompt.name"]).toBeUndefined();
    const linked = await exported(adapter, capture, "langfuse");
    expect(linked.generation).toMatchObject({
      "langfuse.observation.prompt.name": "support/ask",
      "langfuse.observation.prompt.version": "7",
    });
  });

  it("LangSmith", async () => {
    const { capture, fetch } = capturing();
    const adapter = langsmith({ apiKey: "k", project: "prod-traces", fetch });
    const { root, generation } = await exported(adapter, capture);
    expect(capture.url).toBe("https://api.smith.langchain.com/otel/v1/traces");
    expect(capture.headers).toMatchObject({ "x-api-key": "k", "Langsmith-Project": "prod-traces" });
    expect(root).toMatchObject({
      "langsmith.span.kind": "chain",
      "langsmith.trace.name": "request",
      "input.value": '{"q":1}',
      "langsmith.metadata.region": "eu",
      "langsmith.metadata.user_id": "u1",
      "langsmith.metadata.thread_id": "s1",
      "langsmith.span.tags": "beta,eu",
    });
    expect(generation).toMatchObject({
      ...common,
      "langsmith.span.kind": "llm",
      "input.value": '{"messages":[{"role":"user","content":"hi"}]}',
      "output.value": '{"role":"assistant","content":"yo"}',
      "gen_ai.request.temperature": "0",
    });
    expect(generation["langsmith.metadata.lc_hub_commit_hash"]).toBeUndefined();
    const linked = await exported(adapter, capture, "langsmith");
    expect(linked.generation).toMatchObject({
      "langsmith.metadata.lc_hub_repo": "support--ask",
      "langsmith.metadata.lc_hub_commit_hash": "7",
    });
    expect((await exported(langsmith({ apiKey: "k", fetch }), capture)) && capture.headers!["Langsmith-Project"]).toBe("default");
  });
});
