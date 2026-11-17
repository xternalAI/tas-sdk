import { describe, expect, it } from "vitest";
import { braintrust, langfuse, langsmith, memory, type PromptDefinition } from "../src/index.ts";
import { conformance, fixtures } from "./conformance.ts";
import { fakeBraintrust, fakeLangfuse, fakeLangSmith } from "./fakes.ts";

describe("memory adapter", () => conformance(() => memory().prompts!));

describe("braintrust adapter (against a fake server)", () => {
  const make = (fake = fakeBraintrust()) => braintrust({ apiKey: "test-key", projectName: "demo", fetch: fake.fetch }).prompts!;
  conformance(() => make());

  it("writes native Braintrust fields so the prompt is usable in the Braintrust UI", async () => {
    const fake = fakeBraintrust();
    await make(fake).push(fixtures[0]!);
    const row = fake.versions.get("support/triage")![0] as any;
    expect([row.slug, row.name]).toEqual(["support/triage", "support/triage"]); // names with "/" are stored as they are
    expect(row.prompt_data.template_format).toBe("mustache");
    expect(row.prompt_data.options.model).toBe("gpt-5");
    expect(row.prompt_data.options.params.response_format.json_schema.name).toBe("triage");
    expect(row.prompt_data.prompt.messages).toHaveLength(2); // placeholder is envelope-only
    expect(JSON.parse(row.prompt_data.prompt.tools)[0].function.name).toBe("lookup_order");
    expect(row.metadata.owner).toBe("cx-team");
    expect(row.metadata.__tas.fields.messages).toHaveLength(3);
  });

  it("a prompt edited in the Braintrust UI wins over a stale envelope", async () => {
    const fake = fakeBraintrust();
    const reg = make(fake);
    await reg.push(fixtures[0]!);
    const row = fake.versions.get("support/triage")![0] as any;
    row.prompt_data.prompt.messages[0].content = "Edited in the UI";
    const got = (await reg.get({ name: "support/triage" }))!.definition as Extract<PromptDefinition, { type: "chat" }>;
    expect(got.messages).toEqual([
      { role: "system", content: "Edited in the UI" },
      { role: "user", content: "{{ticket.body}}" },
    ]);
  });

  it("keeps parameters Braintrust drops, but lets a real edit in Braintrust win", async () => {
    const fake = fakeBraintrust();
    const reg = make(fake);
    await reg.push(fixtures[0]!);
    const row = fake.versions.get("support/triage")![0] as any;
    expect(row.prompt_data.options.params.temperature).toBeUndefined();
    expect((await reg.get({ name: "support/triage" }))!.definition.model).toEqual(fixtures[0]!.model);

    row.prompt_data.options.params.max_tokens = 999;
    expect((await reg.get({ name: "support/triage" }))!.definition.model).toEqual({ id: "gpt-5", params: { max_tokens: 999 } });
  });

  it("reads prompts that were never touched by this SDK", async () => {
    const fake = fakeBraintrust();
    fake.versions.set("made-in-ui", [
      {
        id: "p9",
        _xact_id: "7",
        slug: "made-in-ui",
        name: "Made In UI",
        prompt_data: {
          prompt: { type: "chat", messages: [{ role: "user", content: "hi" }] },
          options: { model: "gpt-5", params: { response_format: { type: "json_object" } } },
        },
      },
    ]);
    expect((await make(fake).get({ name: "made-in-ui" }))!.definition).toEqual({
      type: "chat",
      name: "made-in-ui",
      model: { id: "gpt-5", params: { response_format: { type: "json_object" } } },
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("rejects a prompt whose braces Braintrust treats as literal text", async () => {
    const fake = fakeBraintrust();
    const row = (template_format: string, content: string) => [
      { id: "p1", _xact_id: "1", slug: "literal", name: "literal", prompt_data: { template_format, prompt: { type: "completion", content } } },
    ];
    fake.versions.set("literal", row("none", "Use {{braces}} literally"));
    await expect(make(fake).get({ name: "literal" })).rejects.toThrow(/template format is "none"/);
    fake.versions.set("literal", row("none", "no braces here"));
    await expect(make(fake).get({ name: "literal" })).resolves.toBeDefined();
    fake.versions.set("literal", row("nunjucks", "{% if a %}{{ a }}{% endif %}"));
    expect((await make(fake).get({ name: "literal" }))!.definition).toMatchObject({ text: "{% if a %}{{ a }}{% endif %}" }); // read as-is; sync flags it
  });

  it("fails loudly instead of silently losing data", async () => {
    const dropsMetadata = make(fakeBraintrust({ keepMetadata: false }));
    await expect(dropsMetadata.push(fixtures[0]!)).rejects.toThrow(/did not keep the metadata/);
    await expect(dropsMetadata.push(fixtures[1]!)).resolves.toBeDefined(); // needs no envelope

    await expect(make().push(fixtures[1]!, { labels: ["qa"] })).rejects.toThrow(/environment qa does not exist/);
    const noProject = braintrust({ apiKey: "test-key", projectName: "nope", fetch: fakeBraintrust().fetch }).prompts!;
    await expect(noProject.get({ name: "plain" })).rejects.toThrow(/never creates projects/);
    const badKey = braintrust({ apiKey: "wrong", projectId: "proj-1", fetch: fakeBraintrust().fetch }).prompts!;
    await expect(badKey.get({ name: "plain" })).rejects.toMatchObject({ status: 401 });
  });

  it("never issues a project-creating request", async () => {
    const fake = fakeBraintrust();
    const reg = make(fake);
    for (const def of fixtures) await reg.push(def, { labels: ["production"] });
    await reg.list();
    expect(fake.calls.filter((c) => c.includes("/v1/project") && !c.startsWith("GET"))).toEqual([]);
  });
});

describe("langfuse adapter (against a fake server)", () => {
  const make = (fake = fakeLangfuse()) => langfuse({ publicKey: "pk-test", secretKey: "sk-test", fetch: fake.fetch }).prompts!;
  conformance(() => make());

  it("writes a config the Langfuse playground understands", async () => {
    const fake = fakeLangfuse();
    await make(fake).push(fixtures[0]!);
    const row = fake.store.get("support/triage")![0] as any;
    expect(row.type).toBe("chat");
    expect(row.prompt[1]).toEqual({ type: "placeholder", name: "history" });
    expect(row.config).toMatchObject({ model: "gpt-5", temperature: 0, max_tokens: 400 });
    expect(row.config.tools[0].function.name).toBe("lookup_order");
    expect(row.config.response_format.json_schema.name).toBe("triage");
    expect(row.config.__tas.fields).toEqual({ description: "Routes a ticket", metadata: { owner: "cx-team" }, tags: ["support"] });
    expect(row.tags).toEqual(["support"]);
  });

  it("the newest version is fetched by default, not the production label", async () => {
    const reg = make();
    const plain = fixtures[1]!;
    await reg.push(plain, { labels: ["production"] });
    await reg.push({ ...plain, description: "newer" });
    expect((await reg.get({ name: plain.name }))!.definition.description).toBe("newer");
    expect((await reg.get({ name: plain.name, label: "production" }))!.definition.description).toBeUndefined();
  });

  it("reads prompts made in the Langfuse UI, including config with no model", async () => {
    const fake = fakeLangfuse();
    fake.store.set("made-in-ui", [
      { name: "made-in-ui", version: 1, type: "text", prompt: "Hello {{name}}", config: { temperature: 0.2 }, labels: ["latest"], tags: [] },
    ]);
    const reg = make(fake);
    const got = (await reg.get({ name: "made-in-ui" }))!.definition;
    expect(got).toEqual({ type: "text", name: "made-in-ui", text: "Hello {{name}}", metadata: { "langfuse.config": { temperature: 0.2 } } });
    // Pushing it back unchanged must not create a version, and an edit must keep the orphan config in place.
    expect((await reg.push(got)).version).toBe("1");
    await reg.push({ ...got, description: "now described" });
    expect((fake.store.get("made-in-ui")![1] as any).config.temperature).toBe(0.2);
  });

  it("will not overwrite a prompt that includes other prompts by reference, unless forced", async () => {
    const fake = fakeLangfuse();
    const reg = make(fake);
    // What the real API returns for such a prompt: the references already expanded, plus a resolution graph.
    fake.store.set("composed", [
      { name: "composed", version: 1, type: "text", prompt: "Intro. BASE TEXT. Outro.", config: {}, labels: ["latest"], tags: [], resolutionGraph: { root: {} } } as any,
    ]);
    const pulled = (await reg.get({ name: "composed" }))!.definition;
    expect(pulled).toMatchObject({ text: "Intro. BASE TEXT. Outro." });
    expect((await reg.push(pulled)).version).toBe("1"); // unchanged: nothing to push, nothing lost
    const edited = { ...pulled, description: "edited locally" };
    await expect(reg.push(edited)).rejects.toThrow(/includes other prompts by reference/);
    expect((await reg.push(edited, { force: true })).version).toBe("2");
  });

  it("fails loudly on a type change and on bad credentials", async () => {
    const reg = make();
    await reg.push(fixtures[1]!);
    await expect(reg.push({ type: "text", name: "plain", text: "x" })).rejects.toThrow(/fixes the type at creation/);
    const badKey = langfuse({ publicKey: "pk-test", secretKey: "wrong", fetch: fakeLangfuse().fetch }).prompts!;
    await expect(badKey.get({ name: "plain" })).rejects.toMatchObject({ status: 401 });
  });
});

describe("langsmith adapter (against a fake server)", () => {
  const make = (fake = fakeLangSmith()) => langsmith({ apiKey: "ls-test", fetch: fake.fetch }).prompts!;
  conformance(() => make());

  it("writes the same structure the LangSmith playground does: prompt, model, tools, output schema", async () => {
    const fake = fakeLangSmith();
    await make(fake).push({ ...fixtures[0]!, model: { id: "gpt-5", params: { temperature: 0, max_tokens: 400, seed: 7 } } });
    const repo = fake.repos.get("support--triage")!;
    const manifest = repo.commits[0]!.manifest;
    expect(manifest.id).toEqual(["langchain", "schema", "runnable", "RunnableSequence"]);

    const prompt = manifest.kwargs.first;
    expect(prompt.id.at(-1)).toBe("StructuredPrompt");
    expect(prompt.kwargs.schema_).toEqual({ type: "object", properties: { queue: { type: "string" } }, title: "triage", strict: true });
    expect(prompt.kwargs.input_variables).toEqual(["company", "ticket"]);
    expect(prompt.kwargs.messages.map((m: any) => m.id.at(-1))).toEqual(["SystemMessagePromptTemplate", "MessagesPlaceholder", "HumanMessagePromptTemplate"]);
    expect(prompt.kwargs.messages[0].kwargs.prompt.kwargs).toMatchObject({ template_format: "mustache", input_variables: ["company"] });

    const binding = manifest.kwargs.last;
    expect(binding.id.at(-1)).toBe("RunnableBinding");
    expect(binding.kwargs.bound.id).toEqual(["langchain", "chat_models", "openai", "ChatOpenAI"]);
    // Common settings are real model arguments; `seed` has no playground control and stays in the envelope.
    expect(binding.kwargs.bound.kwargs).toEqual({ model: "gpt-5", temperature: 0, max_tokens: 400, openai_api_key: { lc: 1, type: "secret", id: ["OPENAI_API_KEY"] } });
    expect(binding.kwargs.kwargs.tools[0].function.name).toBe("lookup_order");
    expect(prompt.kwargs.metadata.__tas.fields.model.params.seed).toBe(7);
    expect(repo).toMatchObject({ description: "Routes a ticket", tags: ["support"] });
    expect((await make(fake).get({ name: "support/triage" }))!.definition.model).toEqual({ id: "gpt-5", params: { temperature: 0, max_tokens: 400, seed: 7 } });
  });

  it.each([
    ["gpt-5", "ChatOpenAI", "gpt-5"],
    ["o3-mini", "ChatOpenAI", "o3-mini"],
    ["claude-sonnet-5-5", "ChatAnthropic", "claude-sonnet-5-5"],
    ["anthropic/claude-sonnet-5-5", "ChatAnthropic", "claude-sonnet-5-5"],
    ["gemini-2.5-pro", "ChatGoogleGenerativeAI", "gemini-2.5-pro"],
    ["groq/openai/gpt-oss-120b", "ChatGroq", "openai/gpt-oss-120b"],
    ["mistral-large-latest", "ChatMistralAI", "mistral-large-latest"],
    ["deepseek/deepseek-reasoner", "ChatDeepSeek", "deepseek-reasoner"],
    ["fireworks/accounts/fireworks/models/qwen3", "ChatFireworks", "accounts/fireworks/models/qwen3"],
    ["my-custom-finetune", "ChatOpenAI", "my-custom-finetune"],
  ])("maps model id %s to %s and returns the same id", async (id, cls, stored) => {
    const fake = fakeLangSmith();
    const reg = make(fake);
    await reg.push({ type: "text", name: "m", text: "hi", model: { id } });
    const bound = fake.repos.get("m")!.commits[0]!.manifest.kwargs.last.kwargs.bound;
    expect([bound.id.at(-1), bound.kwargs.model]).toEqual([cls, stored]);
    expect((await reg.get({ name: "m" }))!.definition.model).toEqual({ id });
  });

  it("lets you override the provider mapping for your gateway's naming", async () => {
    const fake = fakeLangSmith();
    const reg = langsmith({
      apiKey: "ls-test",
      fetch: fake.fetch,
      resolveModel: (id) => (id.startsWith("fast-") ? { provider: "groq", model: "llama-3.3-70b-versatile" } : undefined),
    }).prompts!;
    await reg.push({ type: "text", name: "m", text: "hi", model: { id: "fast-default" } });
    const bound = fake.repos.get("m")!.commits[0]!.manifest.kwargs.last.kwargs.bound;
    expect([bound.id.at(-1), bound.kwargs.model]).toEqual(["ChatGroq", "llama-3.3-70b-versatile"]);
    expect((await reg.get({ name: "m" }))!.definition.model).toEqual({ id: "fast-default" });
  });

  it("picks up edits made in the LangSmith playground without losing envelope-only settings", async () => {
    const fake = fakeLangSmith();
    const reg = make(fake);
    await reg.push({ ...fixtures[0]!, model: { id: "anthropic/claude-sonnet-5-5", params: { temperature: 0, seed: 7 } } });
    const manifest = fake.repos.get("support--triage")!.commits[0]!.manifest;
    const bound = manifest.kwargs.last.kwargs.bound;

    bound.kwargs.temperature = 0.9; // a slider moved
    bound.kwargs.max_tokens = 2048; // a setting added
    bound.kwargs.top_p = null; // the playground writes nulls for untouched controls
    manifest.kwargs.last.kwargs.kwargs.tools = []; // tools removed
    manifest.kwargs.first.kwargs.schema_.title = "renamed";
    let got = (await reg.get({ name: "support/triage" }))!.definition;
    expect(got.model).toEqual({ id: "anthropic/claude-sonnet-5-5", params: { seed: 7, temperature: 0.9, max_tokens: 2048 } });
    expect(got.tools).toBeUndefined();
    expect(got.output).toEqual({ name: "renamed", schema: { type: "object", properties: { queue: { type: "string" } } }, strict: true });

    bound.id = ["langchain", "chat_models", "openai", "ChatOpenAI"]; // a different model chosen
    bound.kwargs.model = "gpt-4o";
    got = (await reg.get({ name: "support/triage" }))!.definition;
    expect(got.model!.id).toBe("gpt-4o");
  });

  it("reads a prompt saved from the LangSmith playground: f-string format, model attached", async () => {
    const fake = fakeLangSmith();
    const reg = make(fake);
    await reg.push({ type: "chat", name: "made-in-ui", messages: [{ role: "user", content: "x" }] });
    const repo = fake.repos.get("made-in-ui")!;
    Object.assign(repo, { description: "From the UI", tags: ["team-a"] });
    const tpl = (template: string) => ({ lc: 1, type: "constructor", id: ["langchain", "prompts", "prompt", "PromptTemplate"], kwargs: { template, template_format: "f-string", input_variables: [] } });
    repo.commits.push({
      id: "uuid-ui",
      commit_hash: "f".repeat(64),
      manifest: {
        lc: 1, type: "constructor", id: ["langchain", "schema", "runnable", "RunnableSequence"],
        kwargs: {
          first: { lc: 1, type: "constructor", id: ["langchain", "prompts", "chat", "ChatPromptTemplate"], kwargs: { messages: [
            { lc: 1, type: "constructor", id: ["langchain", "prompts", "chat", "SystemMessagePromptTemplate"], kwargs: { prompt: tpl('Reply as JSON like {{"a": 1}} to {user_name}') } },
          ] } },
          last: { lc: 1, type: "constructor", id: ["langchain", "schema", "runnable", "RunnableBinding"], kwargs: { bound: { lc: 1, type: "constructor", id: ["langchain", "chat_models", "openai", "ChatOpenAI"], kwargs: { model: "gpt-4o", temperature: 0.3, openai_api_key: { lc: 1, type: "secret", id: ["OPENAI_API_KEY"] } } }, kwargs: {} } },
        },
      },
    });
    expect((await reg.get({ name: "made-in-ui" }))!.definition).toEqual({
      type: "chat",
      name: "made-in-ui",
      description: "From the UI",
      tags: ["team-a"],
      model: { id: "gpt-4o", params: { temperature: 0.3 } },
      messages: [{ role: "system", content: 'Reply as JSON like {"a": 1} to {{user_name}}' }],
    });
  });

  it("rejects names LangSmith cannot hold, before any request", async () => {
    const reg = make();
    await expect(reg.push({ type: "text", name: "1starts-with-digit", text: "x" })).rejects.toThrow(/must start with a letter/);
    await expect(reg.push({ type: "text", name: "double--dash", text: "x" })).rejects.toThrow(/reserved/);
    const badKey = langsmith({ apiKey: "wrong", fetch: fakeLangSmith().fetch }).prompts!;
    await expect(badKey.get({ name: "plain" })).rejects.toMatchObject({ status: 401 });
  });
});
