/**
 * Invocation. Also pins the invocation decisions in docs/decisions.md: no streaming, no retries,
 * tool errors propagate while bad tool arguments go back to the model, unhandled tool calls end the run.
 */
import { describe, expect, it } from "vitest";
import {
  createClient,
  GatewayError,
  memory,
  OutputValidationError,
  PromptArchivedError,
  TemplateError,
  ToolLoopError,
  type ChatMessage,
  type PromptDefinition,
  type StandardSchema,
  type TasConfig,
} from "../src/index.ts";

type Reply = Partial<ChatMessage> | { status: number; body: string };

/** An OpenAI-compatible gateway that answers with the scripted replies in order and records what it was sent. */
function fakeGateway(...replies: Reply[]) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
    const reply = replies.shift();
    if (!reply) throw new Error("fake gateway: no reply scripted");
    if ("status" in reply) return new Response(reply.body, { status: reply.status });
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: null, ...reply }, finish_reason: reply.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

const triage: PromptDefinition = {
  type: "chat",
  name: "triage",
  model: { id: "gpt-5", params: { temperature: 0 } },
  messages: [
    { role: "system", content: "You triage for {{company}}." },
    { role: "user", content: "{{ticket}}" },
  ],
  tools: [{ name: "lookup_order", description: "Find an order", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }],
  output: { name: "triage", strict: true, schema: { type: "object", properties: { queue: { type: "string", enum: ["billing", "tech"] } }, required: ["queue"] } },
};
const plain: PromptDefinition = { type: "chat", name: "plain", model: { id: "gpt-5" }, messages: [{ role: "system", content: "Be brief." }] };
const withTool: PromptDefinition = { ...plain, name: "with-tool", tools: triage.tools! };
const variables = { company: "Acme", ticket: "I was charged twice" };

function setup(gateway: ReturnType<typeof fakeGateway>, extra: Partial<TasConfig> = {}, gatewayExtra: Record<string, unknown> = {}) {
  return createClient({
    platform: memory(),
    prompts: [triage, plain, withTool, { ...plain, name: "retired", archived: true }, { type: "text", name: "loopy", text: "{{#a}}x{{/a}}", model: { id: "m" } }, { type: "text", name: "no-model", text: "hi" }],
    gateway: { baseURL: "https://gw.test/v1/", apiKey: "gw-key", fetch: gateway.fetch, ...gatewayExtra },
    ...extra,
  });
}
const toolCall = (name: string, args: string, id = "call_1") => ({ tool_calls: [{ id, type: "function" as const, function: { name, arguments: args } }] });

describe("run", () => {
  it("sends the prompt's model, settings, tools and output schema, and returns parsed output", async () => {
    const gw = fakeGateway({ content: '{"queue":"billing"}' });
    const result = await setup(gw, {}, { headers: { "x-team": "cx" } }).run("triage", { variables });

    const { url, headers, body } = gw.requests[0]!;
    expect(url).toBe("https://gw.test/v1/chat/completions");
    expect(headers).toMatchObject({ authorization: "Bearer gw-key", "x-team": "cx" });
    expect(body).toEqual({
      model: "gpt-5",
      temperature: 0,
      messages: [
        { role: "system", content: "You triage for Acme." },
        { role: "user", content: "I was charged twice" },
      ],
      tools: [{ type: "function", function: { name: "lookup_order", description: "Find an order", parameters: triage.tools![0]!.parameters } }],
      response_format: { type: "json_schema", json_schema: { name: "triage", strict: true, schema: triage.output!.schema } },
    });
    expect(result).toMatchObject({
      text: '{"queue":"billing"}',
      output: { queue: "billing" },
      toolCalls: [],
      steps: 1,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "stop",
      model: "gpt-5",
    });
    expect(result.prompt.definition.name).toBe("triage");
    expect(result.messages).toHaveLength(3);
  });

  it("maps model ids for the gateway, and lets a call override model, settings and add messages", async () => {
    const gw = fakeGateway({ content: "a" }, { content: "b" });
    const client = setup(gw, {}, { models: { "gpt-5": "openai/gpt-5" } });
    expect((await client.run("plain")).model).toBe("openai/gpt-5");
    await client.run("plain", { model: "claude-sonnet-5-5", params: { temperature: 1, seed: 3 }, messages: [{ role: "user", content: "hi" }] });
    expect(gw.requests[1]!.body).toEqual({
      model: "claude-sonnet-5-5",
      temperature: 1,
      seed: 3,
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }],
    });
  });

  it("returns undefined output and no response_format when there is no schema", async () => {
    const gw = fakeGateway({ content: "Hello." });
    const result = await setup(gw).run("plain");
    expect(result).toMatchObject({ text: "Hello.", output: undefined });
    expect(gw.requests[0]!.body.response_format).toBeUndefined();
  });

  it("throws when the reply is not JSON or does not match the schema", async () => {
    await expect(setup(fakeGateway({ content: "Sure! Here you go" })).run("triage", { variables })).rejects.toMatchObject({ issues: ["reply is not valid JSON"], text: "Sure! Here you go" });
    const mismatch = setup(fakeGateway({ content: '{"queue":"sales"}' })).run("triage", { variables });
    await expect(mismatch).rejects.toBeInstanceOf(OutputValidationError);
    await expect(setup(fakeGateway({ content: '{"queue":"sales"}' })).run("triage", { variables })).rejects.toThrow(/queue: must be equal to one of the allowed values/);
  });

  it("accepts a Standard Schema validator: typed, transformed output, and its JSON Schema sent to the model", async () => {
    const schema: StandardSchema<{ queue: string; urgent: boolean }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v: any) => (typeof v?.queue === "string" ? { value: { queue: v.queue.toUpperCase(), urgent: v.urgent === true } } : { issues: [{ message: "required", path: ["queue"] }] }),
        jsonSchema: { input: () => ({ type: "object", title: "from-validator" }), output: () => ({}) },
      },
    };
    const gw = fakeGateway({ content: '{"queue":"tech"}' }, { content: "{}" });
    const client = setup(gw);
    const result = await client.run("plain", { output: schema });
    const queue: string = result.output.queue; // compiles only because the type is inferred from the schema
    expect([queue, result.output.urgent]).toEqual(["TECH", false]);
    expect(gw.requests[0]!.body.response_format.json_schema).toEqual({ name: "output", schema: { type: "object", title: "from-validator" } });
    await expect(client.run("plain", { output: schema })).rejects.toThrow(/queue: required/);
  });

  it("a validator that cannot produce JSON Schema uses the prompt's schema for the model, or fails if there is none", async () => {
    const opaque: StandardSchema<string> = { "~standard": { version: 1, vendor: "test", validate: (v: any) => ({ value: String(v.queue) }) } };
    const gw = fakeGateway({ content: '{"queue":"tech"}' });
    const result = await setup(gw).run("triage", { variables, output: opaque });
    expect(result.output).toBe("tech");
    expect(gw.requests[0]!.body.response_format.json_schema.schema).toEqual(triage.output!.schema);
    await expect(setup(fakeGateway()).run("plain", { output: opaque })).rejects.toThrow(/cannot produce JSON Schema/);
  });
});

describe("tools", () => {
  it("runs a tool the prompt declares, feeds the result back, and totals usage", async () => {
    const gw = fakeGateway(toolCall("lookup_order", '{"id":"A1"}'), { content: "Order A1 was refunded." });
    const seen: unknown[] = [];
    const result = await setup(gw).run("with-tool", {
      tools: { lookup_order: (args, call) => (seen.push([args, call]), { status: "refunded" }) },
    });
    expect(seen).toEqual([[{ id: "A1" }, { toolCallId: "call_1", name: "lookup_order" }]]);
    expect(gw.requests[1]!.body.messages.slice(-2)).toEqual([
      { role: "assistant", content: null, tool_calls: toolCall("lookup_order", '{"id":"A1"}').tool_calls },
      { role: "tool", tool_call_id: "call_1", content: '{"status":"refunded"}' },
    ]);
    expect(result).toMatchObject({ text: "Order A1 was refunded.", steps: 2, usage: { totalTokens: 30 }, toolCalls: [] });
  });

  it("a tool call with no function ends the run and is handed back, unexecuted", async () => {
    const gw = fakeGateway(toolCall("lookup_order", '{"id":"A1"}'));
    const result = await setup(gw).run("with-tool");
    expect(result.toolCalls).toEqual(toolCall("lookup_order", '{"id":"A1"}').tool_calls);
    expect(result).toMatchObject({ steps: 1, finishReason: "tool_calls", text: "" });
    expect(gw.requests).toHaveLength(1);
  });

  it("tools defined in code are sent to the model; bad arguments go back to the model instead of the function", async () => {
    const gw = fakeGateway(toolCall("add", '{"a":"one"}'), toolCall("add", "not json", "call_2"), toolCall("add", '{"a":2,"b":3}', "call_3"), { content: "5" });
    const calls: unknown[] = [];
    const result = await setup(gw).run("plain", {
      tools: {
        add: {
          description: "Add two numbers",
          parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
          execute: (args) => (calls.push(args), args.a + args.b),
        },
      },
    });
    expect(gw.requests[0]!.body.tools[0].function).toMatchObject({ name: "add", description: "Add two numbers" });
    const toolReplies = result.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(toolReplies[0]).toMatch(/^Error: invalid arguments: /);
    expect(toolReplies[1]).toBe("Error: arguments were not valid JSON");
    expect(toolReplies[2]).toBe("5");
    expect(calls).toEqual([{ a: 2, b: 3 }]);
    expect(result.steps).toBe(4);
  });

  it("an error thrown by a tool function propagates to the caller", async () => {
    const gw = fakeGateway(toolCall("lookup_order", '{"id":"A1"}'));
    const failing = setup(gw).run("with-tool", { tools: { lookup_order: () => { throw new Error("database down"); } } });
    await expect(failing).rejects.toThrow("database down");
    expect(gw.requests).toHaveLength(1);
  });

  it("stops with ToolLoopError when the model keeps calling tools past maxSteps", async () => {
    const gw = fakeGateway(toolCall("lookup_order", "{}"), toolCall("lookup_order", "{}"), toolCall("lookup_order", "{}"));
    const looping = setup(gw).run("with-tool", { maxSteps: 2, tools: { lookup_order: () => "again" } });
    await expect(looping).rejects.toBeInstanceOf(ToolLoopError);
    expect(gw.requests).toHaveLength(2);
  });

  it("rejects a function for a tool nobody defined", async () => {
    await expect(setup(fakeGateway()).run("plain", { tools: { ghost: () => 1 } })).rejects.toThrow(/has a function but no definition/);
  });
});

describe("chat", () => {
  it("renders the prompt once and carries the conversation forward", async () => {
    const gw = fakeGateway({ content: "Hi, how can I help?" }, { content: "Refunds take 5 days." });
    const session = setup(gw).chat("plain");
    expect(session.messages).toEqual([]);
    await session.send("hello");
    const second = await session.send("how long do refunds take?");
    expect(gw.requests[1]!.body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi, how can I help?" },
      { role: "user", content: "how long do refunds take?" },
    ]);
    expect(second.text).toBe("Refunds take 5 days.");
    expect(session.messages).toHaveLength(5);
  });

  it("a failed turn leaves the conversation as it was", async () => {
    const gw = fakeGateway({ content: "one" }, { status: 500, body: "boom" }, { content: "three" });
    const session = setup(gw).chat("plain");
    await session.send("a");
    await expect(session.send("b")).rejects.toBeInstanceOf(GatewayError);
    expect(session.messages).toHaveLength(3);
    await session.send("c");
    expect(gw.requests[2]!.body.messages.map((m: ChatMessage) => m.content)).toEqual(["Be brief.", "a", "one", "c"]);
  });
});

describe("decisions: invocation", () => {
  it("does not retry: a gateway error is reported after one attempt, with its status", async () => {
    const gw = fakeGateway({ status: 429, body: "slow down" }, { content: "would have worked" });
    await expect(setup(gw).run("plain")).rejects.toMatchObject({ status: 429, message: expect.stringContaining("slow down") });
    expect(gw.requests).toHaveLength(1);
  });

  it("does not stream: the request never asks for it", async () => {
    const gw = fakeGateway({ content: "x" });
    await setup(gw).run("plain");
    expect(gw.requests[0]!.body.stream).toBeUndefined();
  });

  it("fails before calling the gateway when the prompt cannot be used", async () => {
    const gw = fakeGateway();
    const client = setup(gw);
    await expect(client.run("retired")).rejects.toBeInstanceOf(PromptArchivedError);
    await expect(client.run("loopy")).rejects.toBeInstanceOf(TemplateError);
    await expect(client.run("triage")).rejects.toThrow(/missing variable "company"/);
    await expect(client.run("no-model")).rejects.toThrow(/names no model/);
    await expect(createClient({ platform: memory(), prompts: [plain] }).run("plain")).rejects.toThrow(/no gateway configured/);
    expect(gw.requests).toHaveLength(0);
  });

  it("a text prompt is sent as a single user message", async () => {
    const gw = fakeGateway({ content: "x" });
    await createClient({ platform: memory(), prompts: [{ type: "text", name: "t", text: "Summarise {{doc}}", model: { id: "m" } }], gateway: { baseURL: "https://gw.test/v1", fetch: gw.fetch } }).run("t", { variables: { doc: "this" } });
    expect(gw.requests[0]!.body.messages).toEqual([{ role: "user", content: "Summarise this" }]);
    expect(gw.requests[0]!.headers.authorization).toBeUndefined(); // no key configured, none sent
  });
});
