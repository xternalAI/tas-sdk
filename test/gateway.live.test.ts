import { describe, expect, it } from "vitest";
import { createClient, dataUrl, memory, type PromptDefinition } from "../src/index.ts";

/**
 * Runs invocation against a real OpenAI-compatible endpoint. Opt-in: only via `pnpm test:live`,
 * and only when the variables are set (in the environment or a local .env file).
 *
 *   TAS_LIVE_GATEWAY_URL     e.g. http://localhost:11434/v1 for a local Ollama
 *   TAS_LIVE_GATEWAY_MODEL   a model that endpoint serves, with tool and JSON-schema support
 *   TAS_LIVE_GATEWAY_KEY     optional
 *
 * Models are not deterministic, so these assert on shape and on what the SDK did, not on wording.
 */
try {
  process.loadEnvFile();
} catch {
  // no .env file
}
const { TAS_LIVE_GATEWAY_URL: baseURL, TAS_LIVE_GATEWAY_MODEL: model, TAS_LIVE_GATEWAY_KEY: apiKey } = process.env;

describe.skipIf(process.env.TAS_LIVE !== "1" || !baseURL || !model)("invocation (live gateway)", { timeout: 300_000 }, () => {
  const prompts: PromptDefinition[] = [
    {
      type: "chat",
      name: "ping",
      model: { id: "test-model", params: { temperature: 0 } },
      messages: [{ role: "user", content: "Reply with the single word {{word}} and nothing else." }],
    },
    {
      type: "chat",
      name: "triage",
      model: { id: "test-model", params: { temperature: 0 } },
      messages: [
        { role: "system", content: "Classify the support ticket into a queue." },
        { role: "user", content: "{{ticket}}" },
      ],
      output: {
        name: "triage",
        schema: { type: "object", properties: { queue: { type: "string", enum: ["billing", "technical"] } }, required: ["queue"] },
      },
    },
    {
      type: "chat",
      name: "weather",
      model: { id: "test-model", params: { temperature: 0 } },
      messages: [
        { role: "system", content: "Always call the get_weather tool before answering a weather question, then answer in one sentence." },
        { role: "user", content: "What is the weather in {{city}}?" },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
    },
    {
      type: "chat",
      name: "assistant",
      model: { id: "test-model", params: { temperature: 0 } },
      messages: [{ role: "system", content: "You are a concise assistant. Answer in a few words." }],
    },
  ];
  const client = createClient({
    platform: memory(),
    prompts,
    // The prompts name a neutral model id; the alias map points it at whatever this endpoint serves.
    gateway: { baseURL: baseURL!, ...(apiKey ? { apiKey } : {}), models: { "test-model": model! } },
  });

  it("plain run returns text and token usage", async () => {
    const result = await client.run("ping", { variables: { word: "pong" } });
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.model).toBe(model);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.steps).toBe(1);
  });

  it("structured output comes back parsed and valid against the prompt's schema", async () => {
    const result = await client.run("triage", { variables: { ticket: "I was charged twice for my subscription this month." } });
    expect(result.output).toEqual({ queue: "billing" });
  });

  it("a tool call is executed, fed back, and the model answers using the result", async () => {
    const calls: unknown[] = [];
    const result = await client.run("weather", {
      variables: { city: "Riga" },
      tools: { get_weather: (args) => (calls.push(args), { city: "Riga", temperature_c: -27, conditions: "blizzard" }) },
    });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]).toLowerCase()).toContain("riga");
    expect(result.steps).toBe(2);
    expect(result.messages.some((m) => m.role === "tool")).toBe(true);
    expect(result.text).toMatch(/27|blizzard/i); // only knowable from the tool result
  });

  it("streams text in several pieces and ends with the same result shape, including usage", async () => {
    const stream = client.stream("ping", { variables: { word: "pong" } });
    const pieces: string[] = [];
    for await (const delta of stream.text) pieces.push(delta);
    const result = await stream.result;
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.join("")).toBe(result.text);
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it("streams a tool round-trip: call, result, then the answer", async () => {
    const stream = client.stream("weather", {
      variables: { city: "Riga" },
      tools: { get_weather: () => ({ temperature_c: -27, conditions: "blizzard" }) },
    });
    const kinds: string[] = [];
    for await (const event of stream) if (kinds.at(-1) !== event.type) kinds.push(event.type);
    const result = await stream.result;
    expect(kinds.filter((k) => k !== "text")).toEqual(["tool-call", "tool-result"]);
    expect(kinds.at(-1)).toBe("text");
    expect(result.steps).toBe(2);
    expect(result.text).toMatch(/27|blizzard/i);
  });

  it("sends an image attachment the model can see", async () => {
    // A 64x64 solid red PNG, built here so the test carries no binary file.
    const { deflateSync, crc32 } = await import("node:zlib");
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type), data]);
      const out = Buffer.alloc(body.length + 8);
      out.writeUInt32BE(data.length, 0);
      body.copy(out, 4);
      out.writeUInt32BE(crc32(body), body.length + 4);
      return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(64, 0);
    header.writeUInt32BE(64, 4);
    header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 3).map((_, i) => (i % 3 === 0 ? 255 : 0))]);
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat(Array(64).fill(row)))),
      chunk("IEND", Buffer.alloc(0)),
    ]);

    const vision = createClient({
      platform: memory(),
      prompts: [
        {
          type: "chat",
          name: "colour",
          model: { id: "test-model", params: { temperature: 0 } },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "What single colour fills this image? Answer with one word." },
                { type: "image", url: "{{image}}" },
              ],
            },
          ],
        },
      ],
      gateway: { baseURL: baseURL!, ...(apiKey ? { apiKey } : {}), models: { "test-model": model! } },
    });
    const result = await vision.run("colour", { variables: { image: dataUrl(png, "image/png") } });
    expect(result.text.toLowerCase()).toContain("red");
  });

  it("chat remembers earlier turns", async () => {
    const session = client.chat("assistant");
    await session.send("My name is Zebulon. Remember it.");
    const reply = await session.send("What is my name?");
    expect(reply.text).toContain("Zebulon");
    expect(session.messages).toHaveLength(5);
  });
});
