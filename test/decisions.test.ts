/**
 * One test per decision recorded in docs/decisions.md that is not already pinned elsewhere,
 * with emphasis on what we deliberately flag, refuse or do not handle. If one of these
 * behaviours is ever changed on purpose, change the test and the entry in decisions.md together.
 *
 * Decisions pinned in other files: canonical side and sync rules (sync.test.ts), multi-tenancy,
 * masking and template strictness (core.test.ts), per-platform round-trips and UI-edit handling
 * (adapters.test.ts, conformance.ts), invocation (run.test.ts), tracing and masking (trace.test.ts).
 */
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  braintrust,
  createClient,
  ENVELOPE_KEY,
  findNonPortable,
  LANGSMITH_PROVIDERS,
  langfuse,
  langsmith,
  memory,
  parsePrompt,
  promptPath,
  PromptArchivedError,
  PromptValidationError,
  renderPrompt,
  sync,
  writePrompt,
  type PromptDefinition,
  type PromptRegistry,
} from "../src/index.ts";
import { fixtures } from "./conformance.ts";
import { fakeBraintrust, fakeLangfuse, fakeLangSmith } from "./fakes.ts";

const bt = (fake = fakeBraintrust()) => braintrust({ apiKey: "test-key", projectName: "demo", fetch: fake.fetch }).prompts!;
const lf = (fake = fakeLangfuse()) => langfuse({ publicKey: "pk-test", secretKey: "sk-test", fetch: fake.fetch }).prompts!;
const ls = (fake = fakeLangSmith()) => langsmith({ apiKey: "ls-test", fetch: fake.fetch }).prompts!;
const lcNode = (id: string[], kwargs: Record<string, unknown>) => ({ lc: 1, type: "constructor", id, kwargs });

describe("decisions: dependencies", () => {
  it("the only runtime dependencies are typebox and yaml", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["typebox", "yaml"]);
    expect(pkg.peerDependencies).toBeUndefined();
  });

  it("adapters never read credentials from the environment", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { BRAINTRUST_API_KEY: "test-key", LANGSMITH_API_KEY: "ls-test", LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" });
    try {
      // The environment holds keys the fakes would accept; the explicitly passed wrong ones must be what is sent.
      await expect(braintrust({ apiKey: "wrong", projectId: "proj-1", fetch: fakeBraintrust().fetch }).prompts!.get({ name: "x" })).rejects.toMatchObject({ status: 401 });
      await expect(langsmith({ apiKey: "wrong", fetch: fakeLangSmith().fetch }).prompts!.get({ name: "x" })).rejects.toMatchObject({ status: 401 });
      await expect(langfuse({ publicKey: "pk-test", secretKey: "wrong", fetch: fakeLangfuse().fetch }).prompts!.get({ name: "x" })).rejects.toMatchObject({ status: 401 });
    } finally {
      process.env = saved;
    }
  });
});

describe("decisions: canonical prompt model", () => {
  const text = (extra: Record<string, unknown>) => ({ type: "text", name: "x", text: "hi", ...extra });

  it.each(["Support/Triage", "has space", "/leading", "trailing/", "a//b", "dots.not.allowed", ""])("rejects the name %j", (name) => {
    expect(() => parsePrompt(text({ name }))).toThrow(PromptValidationError);
  });

  it("accepts lowercase path segments with digits, hyphens and underscores", () => {
    expect(parsePrompt(text({ name: "team-a/v2/triage_final" })).name).toBe("team-a/v2/triage_final");
  });

  it("treats unknown keys as errors at every level, so typos are caught", () => {
    expect(() => parsePrompt(text({ mesages: [] }))).toThrow(/unknown key "mesages"/);
    expect(() => parsePrompt(text({ model: { id: "gpt-5", temprature: 0 } }))).toThrow(/unknown key "temprature"/);
    expect(() => parsePrompt(text({ tools: [{ name: "t", parameters: {}, extra: 1 }] }))).toThrow(/unknown key "extra"/);
  });

  it("requires a model id whenever model settings are given", () => {
    expect(() => parsePrompt(text({ model: { params: { temperature: 0 } } }))).toThrow(PromptValidationError);
  });

  it("keeps chat and text prompts distinct", () => {
    expect(() => parsePrompt({ type: "chat", name: "x", messages: [] })).toThrow(/fewer than 1/);
    expect(() => parsePrompt({ type: "chat", name: "x", messages: [{ role: "user", content: "a" }], text: "b" })).toThrow(/unknown key "text"/);
    expect(() => parsePrompt({ type: "chat", name: "x", messages: [{ role: "tool", content: "a" }] })).toThrow(PromptValidationError);
  });

  it("the envelope key is __tas (renaming it would orphan data already stored on platforms)", () => {
    expect(ENVELOPE_KEY).toBe("__tas");
  });
});

describe("decisions: templates", () => {
  const render = (t: string) => renderPrompt({ type: "text", name: "x", text: t }, { variables: { name: "Ann" } })[0]!.content;

  it("has no escape syntax: a backslash does not stop a variable", () => {
    expect(render("\\{{name}}")).toBe("\\Ann");
  });

  it("leaves unclosed or single braces alone, unflagged", () => {
    for (const literal of ["{{name", "name}}", '{"a": {"b": 1}}', "{name}"]) {
      expect(render(literal)).toBe(literal);
      expect(findNonPortable({ type: "text", name: "x", text: literal })).toEqual([]);
    }
  });
});

describe("decisions: sync", () => {
  let dir: string;
  let registry: PromptRegistry;
  const ctx = () => ({ dir, registry, platform: "memory", canonical: "repo" as const });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tas-"));
    registry = memory().prompts!;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const plain = fixtures[1]!;
  const synced = async (canonical: "repo" | "platform") => {
    await writePrompt(dir, plain);
    await sync.push(ctx());
    return { ...ctx(), canonical };
  };
  const fileExists = () => readFile(promptPath(dir, "plain"), "utf8").then(() => true, () => false);

  it("a file deleted locally is not pulled back when the repo is canonical, and the platform copy is never deleted", async () => {
    const c = await synced("repo");
    await rm(promptPath(dir, "plain"));
    expect(await sync.status(c)).toMatchObject([{ name: "plain", state: "deleted-locally" }]);
    expect(await sync.pull(c)).toMatchObject([{ action: "skipped", reason: "deleted-locally" }]);
    expect(await fileExists()).toBe(false);
    expect(await sync.push(c)).toMatchObject([{ action: "skipped", reason: "deleted-locally" }]);
    expect(await registry.get({ name: "plain" })).not.toBeNull(); // sync never deletes on a platform
    expect(await sync.status(c)).toMatchObject([{ state: "deleted-locally" }]); // and it stays remembered
    expect(await sync.pull(c, { force: true })).toMatchObject([{ action: "pulled", overwrote: "local" }]);
    expect(await fileExists()).toBe(true);
  });

  it("a file deleted locally is restored by pull when the platform is canonical", async () => {
    const c = await synced("platform");
    await rm(promptPath(dir, "plain"));
    expect(await sync.pull(c)).toMatchObject([{ action: "pulled", overwrote: "local" }]);
    expect(await fileExists()).toBe(true);
  });

  it("a prompt deleted on the platform is not pushed back when the platform is canonical; pull removes the file", async () => {
    const c = await synced("platform");
    await registry.delete("plain");
    expect(await sync.status(c)).toMatchObject([{ name: "plain", state: "deleted-remotely" }]);
    expect(await sync.push(c)).toMatchObject([{ action: "refused", reason: "deleted-remotely" }]);
    expect(await registry.get({ name: "plain" })).toBeNull();
    expect(await sync.pull(c)).toMatchObject([{ action: "removed", overwrote: "local" }]);
    expect(await fileExists()).toBe(false);
    expect(await sync.status(c)).toEqual([]); // gone from both sides: forgotten
  });

  it("a prompt deleted on the platform is pushed back when the repo is canonical; pull keeps the file", async () => {
    const c = await synced("repo");
    await registry.delete("plain");
    expect(await sync.pull(c)).toMatchObject([{ action: "skipped", reason: "deleted-remotely" }]);
    expect(await fileExists()).toBe(true);
    expect(await sync.push(c)).toMatchObject([{ action: "pushed", overwrote: "remote" }]);
    expect(await registry.get({ name: "plain" })).not.toBeNull();
  });

  it("a prompt that was never synced is new, not deleted", async () => {
    await writePrompt(dir, plain);
    await registry.push(fixtures[2]!);
    expect((await sync.status(ctx())).map((e) => e.state)).toEqual(["remote-only", "local-only"]);
  });

  it("remove is the only thing that deletes on the platform: all versions, the file and the lock entry", async () => {
    const c = await synced("repo");
    expect(await sync.remove(c, ["plain"])).toEqual([{ name: "plain", action: "removed" }]);
    expect(await registry.get({ name: "plain" })).toBeNull();
    expect(await fileExists()).toBe(false);
    expect(await sync.status(c)).toEqual([]);
  });

  it("one prompt the adapter cannot read fails status for the whole project (known limitation)", async () => {
    await registry.push(fixtures[1]!);
    await registry.push(fixtures[2]!);
    const broken: PromptRegistry = {
      ...registry,
      get: async (ref) => {
        if (ref.name === "plain") throw new Error('prompt "plain" is not portable');
        return registry.get(ref);
      },
    };
    await expect(sync.status({ ...ctx(), registry: broken })).rejects.toThrow(/not portable/);
  });
});

describe("decisions: archiving", () => {
  const live: PromptDefinition = { type: "text", name: "old", text: "hi", tags: ["team-a"] };
  const archived: PromptDefinition = { ...live, archived: true };

  it("the SDK refuses to serve an archived prompt unless asked, from files and from the platform alike", async () => {
    const platform = memory();
    await platform.prompts!.push(archived, { labels: ["production"] });
    for (const client of [createClient({ platform, prompts: [archived] }), createClient({ platform, canonical: "platform" })]) {
      await expect(client.prompts.get("old")).rejects.toBeInstanceOf(PromptArchivedError);
      await expect(client.prompts.render("old")).rejects.toThrow(/is archived/);
      expect((await client.prompts.get("old", { allowArchived: true })).definition.archived).toBe(true);
    }
  });

  it("only `archived: true` is valid, so an unarchived prompt has one spelling", () => {
    expect(() => parsePrompt({ ...live, archived: false })).toThrow(PromptValidationError);
    expect(parsePrompt(live).archived).toBeUndefined();
  });

  it('reserves the tag "archived" on an archived prompt, since adapters add it themselves', () => {
    expect(() => parsePrompt({ ...archived, tags: ["archived"] })).toThrow(/added automatically/);
    expect(parsePrompt({ ...live, tags: ["archived"] }).tags).toEqual(["archived"]); // fine when not archived
  });

  it("mirrors the flag as an `archived` tag on every platform, without changing the user's tags", async () => {
    const b = fakeBraintrust(), l = fakeLangfuse(), s = fakeLangSmith();
    for (const reg of [bt(b), lf(l), ls(s)]) {
      await reg.push(archived);
      expect((await reg.get({ name: "old" }))!.definition).toEqual(archived);
    }
    expect((b.versions.get("old")![0] as any).tags).toEqual(["team-a", "archived"]);
    expect(l.store.get("old")![0]!.tags).toEqual(["team-a", "archived"]);
    expect(s.repos.get("old")!.tags).toEqual(["team-a", "archived"]);
  });

  it("the flag in our metadata is the truth: removing the mirrored tag in a vendor UI does not unarchive", async () => {
    const b = fakeBraintrust(), l = fakeLangfuse();
    await bt(b).push(archived);
    await lf(l).push(archived);
    (b.versions.get("old")![0] as any).tags = ["team-a"];
    l.store.get("old")![0]!.tags = ["team-a"];
    expect((await bt(b).get({ name: "old" }))!.definition.archived).toBe(true);
    expect((await lf(l).get({ name: "old" }))!.definition.archived).toBe(true);
  });

  it("archived prompts still sync like any other prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tas-"));
    try {
      const registry = memory().prompts!;
      const c = { dir, registry, platform: "memory", canonical: "repo" as const };
      await writePrompt(dir, live);
      await sync.push(c);
      await writePrompt(dir, archived);
      expect(await readFile(promptPath(dir, "old"), "utf8")).toBe("archived: true\ntext: hi\ntags:\n  - team-a\n");
      expect(await sync.push(c)).toMatchObject([{ action: "pushed" }]);
      expect((await registry.get({ name: "old" }))!.definition.archived).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("decisions: Braintrust", () => {
  it("keeps tools on a text prompt in the envelope only (completion prompts have no tools field)", async () => {
    const fake = fakeBraintrust();
    await bt(fake).push(fixtures[3]!);
    const row = fake.versions.get("text-with-tools")![0] as any;
    expect(row.prompt_data.prompt).toEqual({ type: "completion", content: "Go" });
    expect(row.metadata.__tas.fields.tools).toEqual(fixtures[3]!.tools);
  });

  it.each([
    ["multimodal content", { role: "user", content: [{ type: "text", text: "hi" }] }, /not plain text/],
    ["a tool-role message", { role: "tool", content: "result" }, /role "tool"/],
  ])("rejects a prompt with %s as not portable", async (_what, message, error) => {
    const fake = fakeBraintrust();
    fake.versions.set("foreign", [{ id: "p1", _xact_id: "1", slug: "foreign", name: "foreign", prompt_data: { prompt: { type: "chat", messages: [message] } } }]);
    await expect(bt(fake).get({ name: "foreign" })).rejects.toThrow(error);
  });
});

describe("decisions: Langfuse", () => {
  it("tags belong to the whole prompt: an old version reports the newest tags", async () => {
    const reg = lf();
    const v1 = await reg.push({ ...fixtures[1]!, tags: ["first"] });
    await reg.push({ ...fixtures[1]!, tags: ["second"] });
    expect((await reg.get({ name: "plain", version: v1.version }))!.definition.tags).toEqual(["second"]);
  });

  it.each([
    ["multimodal content", { role: "user", content: [{ type: "text", text: "hi" }] }, /not plain text/],
    ["a developer-role message", { role: "developer", content: "x" }, /role "developer"/],
  ])("rejects a prompt with %s as not portable", async (_what, message, error) => {
    const fake = fakeLangfuse();
    fake.store.set("foreign", [{ name: "foreign", version: 1, type: "chat", prompt: [message], config: {}, labels: ["latest"], tags: [] }]);
    await expect(lf(fake).get({ name: "foreign" })).rejects.toThrow(error);
  });
});

describe("decisions: LangSmith", () => {
  const chat: PromptDefinition = { type: "chat", name: "p", messages: [{ role: "user", content: "hi {{name}}" }] };
  const tools = [{ name: "lookup", parameters: { type: "object" } }];
  const output = { name: "answer", schema: { type: "object" } };

  /** Replace the latest commit of an SDK-written prompt with a manifest as the LangSmith UI would write it. */
  async function foreign(manifest: unknown) {
    const fake = fakeLangSmith();
    const reg = ls(fake);
    await reg.push(chat);
    fake.repos.get("p")!.commits.push({ id: "uuid-ui", commit_hash: "f".repeat(64), manifest });
    return reg;
  }
  const fstring = (template: string) => lcNode(["langchain", "prompts", "prompt", "PromptTemplate"], { template, template_format: "f-string", input_variables: [] });
  const chatOf = (...messages: unknown[]) => lcNode(["langchain", "prompts", "chat", "ChatPromptTemplate"], { messages });
  const human = (prompt: unknown) => lcNode(["langchain", "prompts", "chat", "HumanMessagePromptTemplate"], { prompt });

  it("tools without a model stay in the envelope: there is nothing in LangSmith to bind them to", async () => {
    const fake = fakeLangSmith();
    const reg = ls(fake);
    await reg.push({ ...chat, tools });
    const manifest = fake.repos.get("p")!.commits[0]!.manifest;
    expect(manifest.id.at(-1)).toBe("ChatPromptTemplate");
    expect(JSON.stringify({ ...manifest.kwargs, metadata: undefined })).not.toContain("lookup");
    expect((await reg.get({ name: "p" }))!.definition.tools).toEqual(tools);
  });

  it("an output schema is native only on chat prompts; on a text prompt it stays in the envelope", async () => {
    const fake = fakeLangSmith();
    const reg = ls(fake);
    await reg.push({ ...chat, output });
    await reg.push({ type: "text", name: "t", text: "hi", output });
    expect(fake.repos.get("p")!.commits[0]!.manifest.id.at(-1)).toBe("StructuredPrompt");
    const textManifest = fake.repos.get("t")!.commits[0]!.manifest;
    expect(textManifest.id.at(-1)).toBe("PromptTemplate");
    expect(textManifest.kwargs.schema_).toBeUndefined();
    expect((await reg.get({ name: "t" }))!.definition.output).toEqual(output);
  });

  it("reads an Azure OpenAI model but has no way to write one", async () => {
    const azure = lcNode(["langchain", "chat_models", "azure_openai", "AzureChatOpenAI"], { deployment_name: "gpt-4o", azure_endpoint: "https://example.invalid/", temperature: 0 });
    const reg = await foreign(lcNode(["langchain", "schema", "runnable", "RunnableSequence"], { first: chatOf(human(fstring("hi"))), last: lcNode(["langchain", "schema", "runnable", "RunnableBinding"], { bound: azure, kwargs: {} }) }));
    expect((await reg.get({ name: "p" }))!.definition.model).toEqual({ id: "gpt-4o", params: { temperature: 0 } });
    expect(Object.keys(LANGSMITH_PROVIDERS)).not.toContain("azure");
  });

  it("converts f-string variables, and flags format specifiers it cannot convert", async () => {
    const reg = await foreign(chatOf(human(fstring("{name} owes {price:.2f} for {{literal}}"))));
    const got = (await reg.get({ name: "p" }))!.definition;
    expect(got).toMatchObject({ messages: [{ role: "user", content: "{{name}} owes {{price:.2f}} for {literal}" }] });
    expect(findNonPortable(got)).toEqual(["{{price:.2f}}"]);
    expect(() => renderPrompt(got, { variables: { name: "Ann" } })).toThrow(/cannot render/);
  });

  it.each([
    ["a multimodal message", () => chatOf(human([fstring("hi"), { type: "image_url" }])), /non-text content/],
    ["an unknown message type", () => chatOf(lcNode(["langchain", "prompts", "chat", "ToolMessagePromptTemplate"], { prompt: fstring("x") })), /message type "ToolMessagePromptTemplate"/],
    ["an object that is not a prompt", () => lcNode(["langchain", "schema", "runnable", "RunnableLambda"], {}), /unsupported object "RunnableLambda"/],
  ])("rejects %s as not portable", async (_what, manifest, error) => {
    const reg = await foreign(manifest());
    await expect(reg.get({ name: "p" })).rejects.toThrow(error);
  });
});
