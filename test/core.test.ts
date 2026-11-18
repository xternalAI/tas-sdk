import { describe, expect, it } from "vitest";
import {
  createClient,
  createClientPool,
  createMasker,
  currentClient,
  defineConfig,
  ENVELOPE_KEY,
  extractVariables,
  findNonPortable,
  fingerprint,
  hashPrompt,
  memory,
  type PromptDefinition,
  PromptNotFoundError,
  packEnvelope,
  pii,
  renderPrompt,
  unpackEnvelope,
  withClient,
} from "../src/index.ts";

const triage: PromptDefinition = {
  type: "chat",
  name: "support/triage",
  model: { id: "gpt-5", params: { temperature: 0 } },
  messages: [
    { role: "system", content: "You triage tickets for {{company}}." },
    { placeholder: "history" },
    { role: "user", content: "{{ ticket.body }}" },
  ],
};

describe("prompt model", () => {
  it("hash ignores key order and undefined fields", () => {
    const reordered = { messages: triage.messages, name: triage.name, model: triage.model, type: "chat" } as PromptDefinition;
    expect(hashPrompt(reordered)).toBe(hashPrompt(triage));
    expect(hashPrompt({ ...triage, description: undefined } as unknown as PromptDefinition)).toBe(hashPrompt(triage));
    expect(hashPrompt({ ...triage, description: "x" })).not.toBe(hashPrompt(triage));
  });

  it("renders variables and placeholders", () => {
    expect(extractVariables(triage)).toEqual(["company", "ticket.body"]);
    const messages = renderPrompt(triage, {
      variables: { company: "Acme", ticket: { body: "It broke" } },
      placeholders: { history: [{ role: "assistant", content: "Hi" }] },
    });
    expect(messages).toEqual([
      { role: "system", content: "You triage tickets for Acme." },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "It broke" },
    ]);
  });

  it("fails loudly on missing input and flags non-portable syntax", () => {
    expect(() => renderPrompt(triage, { variables: { company: "Acme" } })).toThrow(/missing placeholder "history"/);
    expect(() => renderPrompt(triage, { placeholders: { history: [] } })).toThrow(/missing variable "company"/);
    expect(findNonPortable(triage)).toEqual([]);
    expect(findNonPortable({ type: "text", name: "x", text: "{{#if a}}hi{{/if}} {{ok}}" })).toEqual(["{{#if a}}", "{{/if}}"]);
  });
});

describe("template strictness", () => {
  const text = (t: string): PromptDefinition => ({ type: "text", name: "x", text: t });
  const render = (t: string, variables: Record<string, unknown> = { name: "Ann" }, strict?: boolean) =>
    renderPrompt(text(t), { variables, ...(strict === undefined ? {} : { strict }) })[0]!.content;

  it("treats mustache's unescaped forms as plain variables", () => {
    expect(render("{{{name}}} {{{ name }}} {{&name}} {{& name}}")).toBe("Ann Ann Ann Ann");
    expect(extractVariables(text("{{{a.b}}} {{&c}} {{d}}"))).toEqual(["a.b", "c", "d"]);
    expect(findNonPortable(text('{{{name}}} {{&name}} {"json": 1} {single}'))).toEqual([]);
  });

  it.each([
    ["{{#items}}x{{/items}}", ["{{#items}}", "{{/items}}"]],
    ["{{ name | upper }}", ["{{ name | upper }}"]],
    ["{{user-name}}", ["{{user-name}}"]],
    ["{{> partial}}", ["{{> partial}}"]],
    ["{{price:.2f}}", ["{{price:.2f}}"]],
    ["{% if name %}hi{% endif %}", ["{% if name %}", "{% endif %}"]],
    ["{# note #} hi", ["{# note #}"]],
    ["a @@@langfusePrompt:name=base|label=production@@@ b", ["@@@langfusePrompt:name=base|label=production@@@"]],
  ])("flags %s and refuses to render it", (template, flagged) => {
    expect(findNonPortable(text(template))).toEqual(flagged);
    expect(() => render(template)).toThrow(/cannot render/);
  });

  it("strict: false sends unsupported syntax as written and still fills real variables", () => {
    expect(render("{{#items}}{{name}}{{/items}} {{ name | upper }}", { name: "Ann" }, false)).toBe(
      "{{#items}}Ann{{/items}} {{ name | upper }}",
    );
  });
});

describe("adapter contract", () => {
  it("memory adapter round-trips, dedupes unchanged pushes and moves labels", async () => {
    const reg = memory().prompts!;
    const v1 = await reg.push(triage, { labels: ["production"] });
    expect((await reg.get({ name: triage.name, version: v1.version }))!.definition).toEqual(triage);
    expect((await reg.push(triage)).version).toBe(v1.version);

    const v2 = await reg.push({ ...triage, description: "v2" });
    expect(v2.version).not.toBe(v1.version);
    expect((await reg.get({ name: triage.name, label: "production" }))!.version).toBe(v1.version);
    await reg.setLabels(triage.name, v2.version, ["production"]);
    expect((await reg.get({ name: triage.name, label: "production" }))!.version).toBe(v2.version);
    expect(await reg.get({ name: "nope", label: "production" })).toBeNull();
  });

  it("a fingerprint ignores key order, which platforms do not preserve, but not values or list order", () => {
    expect(fingerprint([{ type: "text", text: "a" }, { b: { y: 1, x: 2 } }])).toBe(
      fingerprint([{ text: "a", type: "text" }, { b: { x: 2, y: 1 } }]),
    );
    expect(fingerprint([{ type: "text", text: "a" }])).not.toBe(fingerprint([{ type: "text", text: "b" }]));
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
    expect(fingerprint(undefined)).toBe(fingerprint(null));
  });

  it("envelope carries emulated fields through free-form metadata", () => {
    const envelope = packEnvelope(triage, ["model", "tools"]);
    expect(envelope.fields).toEqual({ model: triage.model });
    expect(unpackEnvelope({ other: 1, [ENVELOPE_KEY]: envelope })).toEqual(envelope);
    expect(unpackEnvelope({ other: 1 })).toBeUndefined();
  });
});

describe("client", () => {
  const remoteVersion = { ...triage, description: "edited in the platform UI" };

  async function setup(canonical: "repo" | "platform") {
    const platform = memory();
    await platform.prompts!.push(remoteVersion, { labels: ["production"] });
    return { platform, client: createClient({ platform, canonical, prompts: [triage] }) };
  }

  it("repo-canonical serves the bundled prompt, platform-canonical serves the platform's", async () => {
    const repo = await setup("repo");
    expect((await repo.client.prompts.get("support/triage")).source).toBe("local");
    const plat = await setup("platform");
    const got = await plat.client.prompts.get("support/triage");
    expect(got.source).toBe("remote");
    expect(got.definition.description).toBe("edited in the platform UI");
    expect(got.remote).toMatchObject({ platform: "memory", labels: ["production"] });
  });

  it("an explicit label always asks the platform, even when repo-canonical", async () => {
    const { client } = await setup("repo");
    expect((await client.prompts.get("support/triage", { label: "production" })).source).toBe("remote");
    await expect(client.prompts.get("support/triage", { label: "staging" })).rejects.toBeInstanceOf(PromptNotFoundError);
  });

  it("platform-canonical falls back to the snapshot when the platform is down, then to stale cache", async () => {
    const { platform, client } = await setup("platform");
    const real = platform.prompts!.get;
    platform.prompts!.get = async () => {
      throw new Error("503");
    };
    expect((await client.prompts.get("support/triage")).source).toBe("local");
    await expect(client.prompts.get("support/triage", { label: "production" })).rejects.toThrow("503");

    platform.prompts!.get = real;
    const warm = createClient({ platform, canonical: "platform", cacheTtlMs: 0 });
    await warm.prompts.get("support/triage");
    platform.prompts!.get = async () => {
      throw new Error("503");
    };
    expect((await warm.prompts.get("support/triage")).source).toBe("remote");
  });
});

describe("multi-tenancy", () => {
  it("pool isolates tenants, shares concurrent resolves, evicts LRU and does not cache failures", async () => {
    let resolves = 0;
    let fail = true;
    const pool = createClientPool({
      max: 2,
      resolve: async (tenant) => {
        if (tenant === "flaky" && fail) throw new Error("no config");
        resolves++;
        return { platform: memory(), masking: { keys: [tenant] }, prompts: [{ type: "text", name: "hello", text: tenant }] };
      },
    });
    const [a1, a2, b] = await Promise.all([pool.get("a"), pool.get("a"), pool.get("b")]);
    expect(a1).toBe(a2);
    expect(resolves).toBe(2);
    expect((await a1.prompts.get("hello")).definition).toMatchObject({ text: "a" });
    expect(a1.mask({ a: 1, b: 2 })).toEqual({ a: "[REDACTED]", b: 2 });
    expect(b.mask({ a: 1, b: 2 })).toEqual({ a: 1, b: "[REDACTED]" });

    await pool.get("a"); // touch a, so b is now least recently used
    await pool.get("c");
    expect(await pool.get("a")).toBe(a1);
    expect(await pool.get("b")).not.toBe(b);

    await expect(pool.get("flaky")).rejects.toThrow("no config");
    fail = false;
    await expect(pool.get("flaky")).resolves.toBeDefined();
  });

  it("evicting or closing the pool closes its clients, and a tenant evicted is built afresh next time", async () => {
    let built = 0;
    const pool = createClientPool({ resolve: () => (built++, { platform: memory() }) });
    const first = await pool.get("a");
    await pool.get("b");
    await pool.evict("a");
    await pool.evict("never-seen"); // nothing to do, and no error
    expect(await pool.get("a")).not.toBe(first);
    await pool.close();
    await pool.get("a");
    expect(built).toBe(4);
  });

  it("withClient scopes a client across awaits without leaking between requests", async () => {
    const a = createClient({ platform: memory() });
    const b = createClient({ platform: memory() });
    const seen = await Promise.all(
      [a, b].map((c) =>
        withClient(c, async () => {
          await new Promise((r) => setTimeout(r, 5));
          return currentClient();
        }),
      ),
    );
    expect(seen).toEqual([a, b]);
    expect(() => currentClient()).toThrow(/no tas client in scope/);
  });
});

describe("masking", () => {
  it("redacts keys, patterns, nested values and survives cycles", () => {
    const mask = createMasker({ keys: ["Authorization", /token/i], patterns: [pii.email] });
    const input: Record<string, unknown> = {
      authorization: "Bearer abc",
      apiToken: "t",
      messages: [{ content: "mail me at jo@example.com or jo2@example.com" }],
      n: 3,
    };
    input.self = input;
    expect(mask(input)).toEqual({
      authorization: "[REDACTED]",
      apiToken: "[REDACTED]",
      messages: [{ content: "mail me at [REDACTED] or [REDACTED]" }],
      n: 3,
      self: "[REDACTED]",
    });
    expect(input.authorization).toBe("Bearer abc");
    expect(createMasker(undefined)(input)).toBe(input);
  });
});

describe("defineConfig", () => {
  it("hands back what it was given, typed so createClient accepts it even with callbacks inside", () => {
    // A callback in the config once made the type widen to "config or profiles", which createClient rejects.
    const config = defineConfig({ platform: memory(), tracing: false, masking: { custom: (value, _path) => value } });
    expect(createClient(config).config).toBe(config);
    const profiles = defineConfig({ default: "a", profiles: { a: { platform: memory() } } });
    expect(profiles.profiles.a?.platform.id).toBe("memory");
  });
});
