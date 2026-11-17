import { describe, expect, it } from "vitest";
import { createHttp, fromOpenAITools, fromResponseFormat, PlatformError, toOpenAITools, toResponseFormat } from "../src/adapters/shared.ts";

describe("createHttp", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const answering = (status: number, body = "") =>
    (async (url: URL | RequestInfo, init?: RequestInit) => (calls.push({ url: String(url), init: init! }), new Response(body || null, { status }))) as typeof fetch;
  const http = (status: number, body?: string) => createHttp({ platform: "acme", baseURL: "https://api.acme.test/v1", headers: { authorization: "Bearer k" }, fetch: answering(status, body) });

  it("sends JSON with the adapter's headers and query, skipping undefined query values", async () => {
    calls.length = 0;
    expect(await http(200, '{"ok":true}').request("POST", "/things", { query: { a: "1", skipped: undefined }, body: { x: 1 } })).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("https://api.acme.test/v1/things?a=1");
    expect(calls[0]!.init).toMatchObject({ method: "POST", body: '{"x":1}', headers: { "content-type": "application/json", authorization: "Bearer k" } });
    await http(200, "{}").request("GET", "/things");
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it("returns undefined for an empty reply body, as deletes give", async () => {
    expect(await http(204).request("DELETE", "/things/1")).toBeUndefined();
  });

  it("throws a PlatformError carrying the status and the start of the reply", async () => {
    const failure = await http(500, "boom ".repeat(200)).request("GET", "/things").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlatformError);
    expect(failure).toMatchObject({ platform: "acme", status: 500 });
    expect((failure as Error).message).toMatch(/^acme GET \/things failed: 500 boom /);
    expect((failure as Error).message.length).toBeLessThan(360);
  });

  it("`find` treats 404 as an answer and everything else like `request`", async () => {
    expect(await http(404, "nope").find("GET", "/things/1")).toBeUndefined();
    expect(await http(200, '{"id":1}').find("GET", "/things/1")).toEqual({ id: 1 });
    await expect(http(404, "nope").request("GET", "/things/1")).rejects.toMatchObject({ status: 404 });
    await expect(http(403).find("GET", "/things/1")).rejects.toMatchObject({ status: 403 });
  });

  it("uses the adapter's own error class when given one, and exposes the fetch it was given", async () => {
    class AcmeError extends Error {}
    const fetchImpl = answering(400, "bad");
    const client = createHttp({ platform: "acme", baseURL: "https://x.test", headers: {}, fetch: fetchImpl, error: (message) => new AcmeError(message) });
    await expect(client.request("GET", "/")).rejects.toBeInstanceOf(AcmeError);
    expect(client.fetch).toBe(fetchImpl);
    expect(createHttp({ platform: "acme", baseURL: "https://x.test", headers: {} }).fetch).toBe(fetch);
  });
});

describe("OpenAI shapes", () => {
  it("converts tools both ways; no tools has one spelling", () => {
    const tools = [{ name: "a", description: "does a", parameters: { type: "object" } }, { name: "b", parameters: {} }];
    const wire = toOpenAITools(tools);
    expect(wire).toEqual([
      { type: "function", function: { name: "a", description: "does a", parameters: { type: "object" } } },
      { type: "function", function: { name: "b", parameters: {} } },
    ]);
    expect(fromOpenAITools(wire)).toEqual(tools);
    expect(fromOpenAITools([{ type: "function", function: { name: "bare" } }])).toEqual([{ name: "bare", parameters: {} }]);
    expect([fromOpenAITools([]), fromOpenAITools(null), fromOpenAITools(undefined)]).toEqual([undefined, undefined, undefined]);
  });

  it("converts an output contract both ways, and a missing name survives the trip", () => {
    const named = { name: "triage", schema: { type: "object" }, strict: true };
    expect(toResponseFormat(named)).toEqual({ type: "json_schema", json_schema: { name: "triage", schema: { type: "object" }, strict: true } });
    expect(fromResponseFormat(toResponseFormat(named))).toEqual({ output: named });
    const unnamed = { schema: { type: "object" } };
    expect(toResponseFormat(unnamed)).toEqual({ type: "json_schema", json_schema: { name: "output", schema: { type: "object" } } });
    expect(fromResponseFormat(toResponseFormat(unnamed))).toEqual({ output: unnamed });
  });

  it("leaves other response formats to the caller", () => {
    expect(fromResponseFormat({ type: "json_object" })).toEqual({ other: { type: "json_object" } });
    expect(fromResponseFormat({ type: "json_schema" })).toEqual({ other: { type: "json_schema" } });
    expect(fromResponseFormat({ type: "json_schema", json_schema: {} })).toEqual({ output: { schema: {} } });
    expect([fromResponseFormat(undefined), fromResponseFormat(null)]).toEqual([{}, {}]);
  });
});
