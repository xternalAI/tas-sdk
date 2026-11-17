/**
 * The studio (its API, its server's safeguards, the command that starts it) and the portability
 * checker behind its "across platforms" panel. Also pins the studio decisions in docs/decisions.md:
 * it edits the same files as everything else, serves this machine only, and never trusts a request
 * that does not carry its session token.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPortability,
  loadPrompts,
  memory,
  type PlatformAdapter,
  type PromptDefinition,
  portabilityLevel,
  promptPath,
  type TasConfig,
  writePrompt,
} from "../src/index.ts";
import { createStudioApi, inspectPrompt } from "../src/studio/api.ts";
import { startStudio } from "../src/studio/server.ts";
import { cli, SDK } from "./cli.ts";
import { fixtures } from "./conformance.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tas-studio-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const greet: PromptDefinition = {
  type: "chat",
  name: "team/greet",
  model: { id: "gpt-5" },
  messages: [{ role: "system", content: "Be kind." }, { placeholder: "history" }, { role: "user", content: "Hi {{user.name}}" }],
};
const by = (def: PromptDefinition, platform: string) =>
  checkPortability(def)
    .filter((n) => n.platform === platform)
    .map((n) => `${n.level}: ${n.message}`);

describe("portability", () => {
  it("a plain prompt is native everywhere", () => {
    const plain: PromptDefinition = { type: "chat", name: "plain", messages: [{ role: "user", content: "Hi {{name}}" }] };
    expect(checkPortability(plain)).toEqual([]);
    expect(portabilityLevel([])).toBe("ok");
  });

  it("non-portable template syntax is an error on every platform", () => {
    const notes = checkPortability({ type: "text", name: "x", text: "{{#a}}{{b}}{{/a}} {{#a}}" });
    expect(notes[0]).toMatchObject({ platform: "all", level: "error" });
    expect(notes[0]!.message).toContain("{{#a}}  {{/a}}"); // each construct listed once
    expect(portabilityLevel(notes)).toBe("error");
  });

  it("says what LangSmith cannot name, bind or template", () => {
    expect(by({ type: "text", name: "1st", text: "x" }, "langsmith")[0]).toMatch(/^error: The name "1st" cannot be stored/);
    expect(by({ type: "text", name: "a--b", text: "x" }, "langsmith")[0]).toMatch(/^error: .*"--" is reserved/);
    expect(by({ type: "text", name: "a/b", text: "x" }, "langsmith")).toEqual([
      'info: Stored as "a--b": LangSmith names cannot contain "/".',
    ]);
    const tools = [{ name: "t", parameters: {} }];
    expect(by({ type: "text", name: "x", text: "x", tools }, "langsmith")[0]).toMatch(/^warning: Tools are kept in metadata only/);
    expect(by({ type: "text", name: "x", text: "x", tools, model: { id: "gpt-5" } }, "langsmith")).toEqual([]);
    expect(by({ type: "text", name: "x", text: "x", output: { schema: {} } }, "langsmith")[0]).toMatch(
      /^warning: The output schema is kept in metadata only/,
    );
    expect(by({ type: "chat", name: "x", messages: [{ role: "user", content: "x" }], output: { schema: {} } }, "langsmith")).toEqual([]);
  });

  it("says where attachments are not native", () => {
    const vision = fixtures.find((f) => f.name === "vision/describe")!;
    expect(by(vision, "braintrust")).toEqual([]);
    expect(by(vision, "langfuse")[0]).toMatch(/^warning: Langfuse messages are text only/);
    expect(by(vision, "langsmith").some((n) => /^warning: File attachments are kept in metadata only/.test(n))).toBe(true);
    const imagesOnly: PromptDefinition = {
      type: "chat",
      name: "x",
      messages: [{ role: "user", content: [{ type: "image", url: "{{u}}" }] }],
    };
    expect(by(imagesOnly, "langsmith")).toEqual([]);
    expect(portabilityLevel(checkPortability(vision))).toBe("warning");
  });

  it("lists what is merely kept in metadata as info, most serious notes first", () => {
    const full = fixtures[0]!;
    const notes = checkPortability({ ...full, archived: true });
    expect(notes.map((n) => n.level)).toEqual(
      [...notes.map((n) => n.level)].sort((a, b) => ["error", "warning", "info"].indexOf(a) - ["error", "warning", "info"].indexOf(b)),
    );
    expect(by(full, "braintrust")).toEqual([
      expect.stringMatching(/^info: Placeholders are kept in metadata/),
      expect.stringMatching(/^info: Braintrust drops settings/),
    ]);
    expect(by({ type: "text", name: "x", text: "x", tools: [{ name: "t", parameters: {} }] }, "braintrust")).toEqual([
      expect.stringMatching(/Tools on a text prompt/),
    ]);
    expect(by(full, "langfuse")).toEqual([
      expect.stringMatching(/description is kept in metadata/),
      expect.stringMatching(/Metadata is kept inside/),
    ]);
    for (const platform of ["braintrust", "langfuse", "langsmith"])
      expect(by({ ...full, archived: true }, platform).some((n) => n.includes("archived flag"))).toBe(true);
    expect(portabilityLevel(notes)).toBe("ok"); // info alone is not a problem
  });

  it("tas prompts check prints the notes and exits 1 only when something cannot be stored", async () => {
    await writeFile(
      join(dir, "tas.config.ts"),
      `import { defineConfig, memory } from ${SDK};\nexport default defineConfig({ platform: memory() });\n`,
    );
    expect(await cli(["prompts", "check"], dir)).toEqual({ code: 0, out: "no prompts\n" });
    await writePrompt(join(dir, "prompts"), { type: "text", name: "fine", text: "Hi {{name}}" });
    await writePrompt(join(dir, "prompts"), { type: "text", name: "tooled", text: "x", tools: [{ name: "t", parameters: {} }] });
    const ok = await cli(["prompts", "check"], dir);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(
      /^ok {6}fine\nwarning tooled\n {8}warning langsmith: Tools are kept in metadata only[^\n]*\n {8}info {4}braintrust: /,
    );
    await writePrompt(join(dir, "prompts"), { type: "text", name: "9lives", text: "{{#a}}x{{/a}}" });
    const blocked = await cli(["prompts", "check", "9lives"], dir);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toMatch(/^error {3}9lives\n {8}error {3}every platform: Template syntax[^\n]*\n {8}error {3}langsmith: The name/);
  });
});

describe("studio API", () => {
  const setup = (extra: Partial<TasConfig> = {}) => {
    const platform = memory();
    const api = createStudioApi({ config: { platform, ...extra }, dir, target: "default" });
    const call = async (method: string, path: string, body?: unknown) => api({ method, path, body });
    return { platform, call };
  };
  const yaml = "messages:\n  - role: user\n    content: Hello {{name}}\n";

  it("describes itself and lists prompt files, including one that does not validate", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/info")).body).toEqual({
      platform: "memory",
      canonical: "repo",
      promptsDir: dir,
      canSync: true,
      canRun: false,
    });
    expect((await call("GET", "/api/prompts")).body).toEqual([]);
    await writePrompt(dir, greet);
    await writePrompt(dir, { type: "text", name: "old", text: "x", archived: true, description: "Retired" });
    await writeFile(promptPath(dir, "broken"), "mesages: []\n");
    expect((await call("GET", "/api/prompts")).body).toEqual([
      { name: "broken", type: null, description: null, archived: false, valid: false, level: "error" },
      { name: "old", type: "text", description: "Retired", archived: true, valid: true, level: "ok" },
      { name: "team/greet", type: "chat", description: null, archived: false, valid: true, level: "ok" },
    ]);
  });

  it("shows a prompt with its variables, placeholders and notes, without the editor hint line", async () => {
    const { call } = setup();
    await writePrompt(dir, greet);
    const { status, body } = (await call("GET", "/api/prompts/team%2Fgreet")) as { status: number; body: any };
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "team/greet", issues: [], variables: ["user.name"], placeholders: ["history"], level: "ok" });
    expect(body.source.startsWith("model:")).toBe(true);
    expect(body.definition).toEqual(greet);
    expect(body.notes.map((n: any) => n.platform)).toContain("braintrust");
    expect(await call("GET", "/api/prompts/nope")).toEqual({ status: 404, body: { error: 'no prompt "nope"' } });
  });

  it("saving validates, then writes the file the way the SDK writes it", async () => {
    const { call } = setup();
    const saved = (await call("PUT", "/api/prompts/hello", { source: `tags: [a]\n${yaml}` })) as { status: number; body: any };
    expect(saved.status).toBe(200);
    expect(await readFile(promptPath(dir, "hello"), "utf8")).toBe(
      "# yaml-language-server: $schema=prompt.schema.json\nmessages:\n  - role: user\n    content: Hello {{name}}\ntags:\n  - a\n",
    );
    expect(saved.body.source).toBe("messages:\n  - role: user\n    content: Hello {{name}}\ntags:\n  - a\n"); // normalised, as on disk
    expect(await loadPrompts(dir)).toEqual([
      { type: "chat", name: "hello", messages: [{ role: "user", content: "Hello {{name}}" }], tags: ["a"] },
    ]);

    const invalid = await call("PUT", "/api/prompts/hello", { source: "mesages: []\n" });
    expect(invalid).toEqual({
      status: 422,
      body: { error: "the prompt is not valid", issues: [expect.stringContaining('unknown key "mesages"')] },
    });
    expect((await call("PUT", "/api/prompts/hello", { source: "a: [unclosed" })).status).toBe(422); // not even YAML
    expect((await loadPrompts(dir))[0]!.tags).toEqual(["a"]); // a failed save leaves the file alone
    expect(await call("PUT", "/api/prompts/Bad%20Name", { source: yaml })).toMatchObject({ status: 400 });
  });

  it("creates a starter prompt, refuses a duplicate or a bad name, and deletes the file only", async () => {
    const { call, platform } = setup();
    expect((await call("POST", "/api/prompts", { name: "new/chat" })).body).toMatchObject({
      name: "new/chat",
      variables: ["input"],
      definition: { type: "chat" },
    });
    expect((await call("POST", "/api/prompts", { name: "new/text", type: "text" })).body).toMatchObject({
      definition: { type: "text", text: "{{input}}" },
    });
    expect(await call("POST", "/api/prompts", { name: "new/chat" })).toMatchObject({ status: 409 });
    expect(await call("POST", "/api/prompts", { name: "Not Valid" })).toMatchObject({ status: 400 });
    expect(await call("POST", "/api/prompts", undefined)).toMatchObject({ status: 400 });

    await call("POST", "/api/push", {});
    expect(await call("DELETE", "/api/prompts/new%2Fchat")).toEqual({ status: 200, body: { deleted: "new/chat" } });
    expect((await loadPrompts(dir)).map((p) => p.name)).toEqual(["new/text"]);
    expect(await platform.prompts!.get({ name: "new/chat" })).not.toBeNull(); // deleting in the studio never deletes on the platform
    expect(await call("DELETE", "/api/prompts/new%2Fchat")).toMatchObject({ status: 404 });
  });

  it("checks unsaved text without writing anything", async () => {
    const { call } = setup();
    const good = (await call("POST", "/api/check", { name: "draft", source: "text: 'Hi {{a}} {{#b}}'\n" })).body as any;
    expect(good).toMatchObject({ variables: ["a"], level: "error", issues: [] });
    expect(good.notes[0]).toMatchObject({ platform: "all", level: "error" });
    expect((await call("POST", "/api/check", { source: "text: 1\n" })).body).toMatchObject({
      name: "untitled",
      definition: null,
      issues: [expect.any(String)],
    });
    expect(await loadPrompts(dir)).toEqual([]);
    expect(inspectPrompt("x", "# yaml-language-server: $schema=whatever\ntext: hi\n").source).toBe("text: hi\n");
  });

  it("previews rendered messages, with empty placeholders unless given", async () => {
    const { call } = setup();
    const source = "messages:\n  - placeholder: history\n  - role: user\n    content: Hi {{user.name}}\n";
    expect((await call("POST", "/api/render", { name: "p", source, variables: { user: { name: "Jo" } } })).body).toEqual({
      messages: [{ role: "user", content: "Hi Jo" }],
    });
    const withHistory = await call("POST", "/api/render", {
      source,
      variables: { user: { name: "Jo" } },
      placeholders: { history: [{ role: "assistant", content: "Hello" }] },
    });
    expect((withHistory.body as any).messages).toHaveLength(2);
    expect(await call("POST", "/api/render", { source })).toEqual({
      status: 422,
      body: { error: 'prompt "untitled": missing variable "user.name"' },
    });
    expect(await call("POST", "/api/render", { source: "nope: 1\n" })).toMatchObject({
      status: 422,
      body: { issues: [expect.any(String)] },
    });
  });

  it("reports sync status and pushes and pulls through the same engine as the CLI", async () => {
    const { call, platform } = setup();
    await writePrompt(dir, greet);
    await writePrompt(dir, { type: "text", name: "loopy", text: "{{#a}}x{{/a}}" });
    await platform.prompts!.push({ type: "text", name: "remote", text: "from the platform" });
    expect((await call("GET", "/api/status")).body).toEqual([
      { name: "loopy", state: "local-only", nonPortable: ["{{#a}}", "{{/a}}"] },
      { name: "remote", state: "remote-only" },
      { name: "team/greet", state: "local-only" },
    ]);
    expect((await call("POST", "/api/push", { names: ["team/greet"], labels: ["production"] })).body).toMatchObject([
      { name: "team/greet", action: "pushed" },
    ]);
    expect((await platform.prompts!.get({ name: "team/greet", label: "production" }))!.definition).toEqual(greet);
    expect((await call("POST", "/api/push", { names: ["loopy"] })).body).toMatchObject([{ action: "refused", reason: "non-portable" }]);
    expect((await call("POST", "/api/push", { names: ["loopy"], force: true })).body).toMatchObject([{ action: "pushed" }]);
    expect((await call("POST", "/api/pull", { names: ["remote"] })).body).toMatchObject([{ name: "remote", action: "pulled" }]);
    expect((await call("POST", "/api/pull", undefined)).status).toBe(200);
    expect((await loadPrompts(dir)).map((p) => p.name)).toContain("remote");
  });

  it("runs a saved prompt through the gateway when there is one", async () => {
    let sent: any;
    const gateway = {
      baseURL: "https://gw.test/v1",
      fetch: (async (_u: unknown, init?: RequestInit) => (
        (sent = JSON.parse(String(init!.body))),
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "Hello Jo" } }],
            usage: { prompt_tokens: 4, completion_tokens: 2 },
          }),
        )
      )) as typeof fetch,
    };
    const { call } = setup({ gateway });
    await writePrompt(dir, greet);
    expect((await call("GET", "/api/info")).body).toMatchObject({ canRun: true });
    expect((await call("POST", "/api/run", { name: "team/greet", variables: { user: { name: "Jo" } } })).body).toEqual({
      text: "Hello Jo",
      output: null,
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      model: "gpt-5",
      toolCalls: [],
    });
    expect(sent.messages).toEqual([
      { role: "system", content: "Be kind." },
      { role: "user", content: "Hi Jo" },
    ]);
    expect((await call("POST", "/api/run", { name: "team/greet" })).body).toEqual({
      error: 'prompt "team/greet": missing variable "user.name"',
    });
    expect(await setup().call("POST", "/api/run", { name: "team/greet" })).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("no gateway configured") },
    });
  });

  it("answers clearly for an unknown route and for a platform that cannot sync", async () => {
    const { call } = setup();
    expect(await call("GET", "/api/nope")).toEqual({ status: 404, body: { error: "no such route: GET /api/nope" } });
    const bare = createStudioApi({ config: { platform: { id: "bare" } as PlatformAdapter }, dir, target: "default" });
    expect(await bare({ method: "GET", path: "/api/status" })).toEqual({
      status: 400,
      body: { error: 'platform "bare" has no prompt registry' },
    });
    expect((await bare({ method: "GET", path: "/api/info" })).body).toMatchObject({ canSync: false });
  });
});

describe("studio server", () => {
  /** A raw request, so the Host header can be chosen (fetch does not allow that). */
  const raw = (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; body: string; type: string }>((resolve, reject) => {
      const request = httpRequest(url, { method: options.method ?? "GET", headers: options.headers }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode!, body, type: String(response.headers["content-type"]) }));
      });
      request.on("error", reject);
      request.end(options.body);
    });

  it("serves the page, and the API only to a request carrying the page's token", async () => {
    await writePrompt(dir, greet);
    const studio = await startStudio({ config: { platform: memory() }, dir, target: "default" }, { port: 0 });
    try {
      expect(studio.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const page = await raw(studio.url);
      expect([page.status, page.type]).toEqual([200, "text/html; charset=utf-8"]);
      expect(page.body).toContain("Trace and Scale Studio");
      expect(page.body).toContain(studio.token);

      const auth = { "x-tas-token": studio.token, "content-type": "application/json" };
      expect(JSON.parse((await raw(`${studio.url}/api/prompts`, { headers: auth })).body)).toMatchObject([{ name: "team/greet" }]);
      const saved = await raw(`${studio.url}/api/prompts/hello`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ source: "text: hi\n" }),
      });
      expect(saved.status).toBe(200);
      expect((await loadPrompts(dir)).map((p) => p.name)).toEqual(["hello", "team/greet"]);

      expect((await raw(`${studio.url}/api/prompts`)).status).toBe(401);
      expect((await raw(`${studio.url}/api/prompts`, { headers: { "x-tas-token": "guess" } })).status).toBe(401);
      expect((await raw(`${studio.url}/elsewhere`)).status).toBe(404);
      expect((await raw(`${studio.url}/api/prompts/x`, { method: "PUT", headers: auth, body: "{not json" })).status).toBe(400);
      expect(
        (await raw(`${studio.url}/api/check`, { method: "POST", headers: auth, body: JSON.stringify({ source: "x".repeat(2_100_000) }) }))
          .status,
      ).toBe(400);
    } finally {
      await studio.close();
    }
  });

  it("refuses a request addressed to it under another host name", async () => {
    const studio = await startStudio({ config: { platform: memory() }, dir, target: "default" }, { port: 0 });
    try {
      const port = new URL(studio.url).port;
      const rebound = await raw(studio.url, { headers: { host: `evil.example:${port}`, "x-tas-token": studio.token } });
      expect(rebound.status).toBe(403);
      expect(rebound.body).not.toContain(studio.token);
      expect((await raw(`${studio.url}/api/info`, { headers: { host: `localhost:${port}`, "x-tas-token": studio.token } })).status).toBe(
        200,
      );
    } finally {
      await studio.close();
    }
  });

  it("tas studio serves until stopped, on the port asked for", async () => {
    await writeFile(
      join(dir, "tas.config.ts"),
      `import { defineConfig, memory } from ${SDK};\nexport default defineConfig({ platform: memory() });\n`,
    );
    const stop = new AbortController();
    const lines: string[] = [];
    const { runCli } = await import("../src/cli.ts");
    const running = runCli(["studio", "--port", "0"], {
      cwd: dir,
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
      signal: stop.signal,
    });
    while (!lines.length) await new Promise((r) => setTimeout(r, 5));
    const url = /Studio is running at (http:\/\/127\.0\.0\.1:\d+)/.exec(lines[0]!)![1]!;
    expect((await raw(url)).status).toBe(200);
    stop.abort();
    expect(await running).toBe(0);
    await expect(raw(url)).rejects.toThrow();
    expect(await cli(["studio", "--port", "seventy"], dir)).toEqual({ code: 1, out: 'tas: --port must be a port number, got "seventy"\n' });
  });
});
