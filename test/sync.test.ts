import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadPrompts,
  memory,
  parsePromptFile,
  promptFileSchema,
  promptPath,
  SCHEMA_FILE,
  stringifyPrompt,
  sync,
  validateSchema,
  writePrompt,
  writePromptSchema,
  type PromptDefinition,
  type PromptRegistry,
} from "../src/index.ts";
import { cli, SDK } from "./cli.ts";
import { fixtures } from "./conformance.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tas-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const greet: PromptDefinition = { type: "chat", name: "team/greet", messages: [{ role: "user", content: "Hi {{name}}" }] };
const edit = (def: PromptDefinition, description: string): PromptDefinition => ({ ...def, description });

describe("prompt files", () => {
  it.each(fixtures)("round-trips $name through YAML", (def) => {
    expect(parsePromptFile(stringifyPrompt(def), def.name)).toEqual(def);
  });

  it("takes the name from the path and keeps multi-line text readable", async () => {
    const def: PromptDefinition = { type: "text", name: "a/b/c", text: "line one\nline two {{x}}\n" };
    const path = await writePrompt(dir, def);
    expect(path).toBe(promptPath(dir, "a/b/c"));
    // The first line points editors at the schema, relative to the file, however deep it is.
    expect(await readFile(path, "utf8")).toBe("# yaml-language-server: $schema=../../prompt.schema.json\ntext: |\n  line one\n  line two {{x}}\n");
    await writePrompt(dir, greet);
    expect(await loadPrompts(dir)).toEqual([def, greet]);
    expect(await loadPrompts(join(dir, "missing"))).toEqual([]);
  });

  it("ships a JSON Schema for prompt files that accepts what the SDK writes and rejects what it would reject", async () => {
    const check = (file: unknown) => validateSchema(promptFileSchema, file);
    for (const def of fixtures) {
      const { name: _name, type: _type, ...file } = def as Record<string, unknown>;
      expect(await check(file)).toMatchObject({ ok: true });
    }
    expect(await check({ text: "hi", name: "x" })).toMatchObject({ ok: false }); // name comes from the path
    expect(await check({ messages: [{ role: "user", content: "hi" }], text: "both" })).toMatchObject({ ok: false });
    expect(await check({ mesages: [] })).toMatchObject({ ok: false });
    expect(await check({ text: "hi", archived: false })).toMatchObject({ ok: false });
    // Every field carries a description: that text is the hover documentation in editors.
    const undocumented: string[] = [];
    const walk = (node: any, path: string) => {
      for (const [key, child] of Object.entries<any>(node?.properties ?? {})) {
        if (!child.description && !child.anyOf && !child.oneOf) undocumented.push(`${path}${key}`);
        walk(child, `${path}${key}.`);
        walk(child.items, `${path}${key}[].`);
        for (const option of child.items?.anyOf ?? []) walk(option, `${path}${key}[].`);
      }
    };
    for (const variant of promptFileSchema.oneOf) walk(variant, "");
    expect(undocumented).toEqual([]);
  });

  it("writes the schema next to the prompts, once, and leaves it alone when it is current", async () => {
    const path = await writePromptSchema(dir);
    expect(path).toBe(join(dir, SCHEMA_FILE));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(JSON.parse(JSON.stringify(promptFileSchema)));
    const before = (await stat(path)).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await writePrompt(dir, greet); // writing a prompt keeps the schema present without rewriting it
    expect((await stat(path)).mtimeMs).toBe(before);
    expect(await loadPrompts(dir)).toEqual([greet]); // the schema file is not mistaken for a prompt
  });

  it("rejects files that restate name or type, and invalid content", () => {
    expect(() => parsePromptFile("name: x\ntext: hi\n", "x")).toThrow(/derived from the file/);
    expect(() => parsePromptFile("messages: []\n", "x")).toThrow();
    expect(() => parsePromptFile("- a\n", "x")).toThrow(/YAML mapping/);
  });
});

describe("sync", () => {
  let registry: PromptRegistry;
  const ctx = (canonical: "repo" | "platform") => ({ dir, registry, platform: "memory", canonical });
  const states = async (canonical: "repo" | "platform" = "repo") =>
    Object.fromEntries((await sync.status(ctx(canonical))).map((e) => [e.name, e.state]));

  beforeEach(() => {
    registry = memory().prompts!;
  });

  it("push creates, is idempotent, and pull brings remote-only prompts down", async () => {
    await writePrompt(dir, greet);
    await registry.push(fixtures[1]!);
    expect(await states()).toEqual({ plain: "remote-only", "team/greet": "local-only" });

    expect(await sync.push(ctx("repo"))).toMatchObject([{ name: "plain", action: "skipped" }, { name: "team/greet", action: "pushed" }]);
    expect(await sync.pull(ctx("repo"))).toMatchObject([{ name: "plain", action: "pulled" }, { name: "team/greet", action: "unchanged" }]);
    expect(await states()).toEqual({ plain: "in-sync", "team/greet": "in-sync" });
    expect((await sync.push(ctx("repo"))).map((r) => r.action)).toEqual(["unchanged", "unchanged"]);
    expect(await loadPrompts(dir)).toEqual([fixtures[1], greet]);
  });

  async function diverge(local: boolean, remote: boolean) {
    await writePrompt(dir, greet);
    await sync.push(ctx("repo"));
    if (local) await writePrompt(dir, edit(greet, "edited in repo"));
    if (remote) await registry.push(edit(greet, "edited in UI"));
  }
  const localText = async () => (await loadPrompts(dir))[0]!.description;
  const remoteText = async () => (await registry.get({ name: greet.name }))!.definition.description;

  it("detects each kind of drift", async () => {
    await diverge(true, false);
    expect(await states()).toEqual({ "team/greet": "local-changed" });
    await sync.push(ctx("repo"));
    await registry.push(edit(greet, "edited in UI"));
    expect(await states()).toEqual({ "team/greet": "remote-changed" });
    await writePrompt(dir, edit(greet, "third"));
    expect(await states()).toEqual({ "team/greet": "conflict" });
  });

  it("repo-canonical: push overwrites UI edits, pull refuses to clobber local edits", async () => {
    await diverge(true, true);
    expect(await sync.pull(ctx("repo"))).toMatchObject([{ action: "refused" }]);
    expect(await localText()).toBe("edited in repo");
    expect(await sync.push(ctx("repo"))).toMatchObject([{ action: "pushed", overwrote: "remote" }]);
    expect(await remoteText()).toBe("edited in repo");
    expect(await states()).toEqual({ "team/greet": "in-sync" });
  });

  it("repo-canonical: a UI-only edit can still be pulled in as a proposal", async () => {
    await diverge(false, true);
    expect(await sync.pull(ctx("repo"))).toMatchObject([{ action: "pulled" }]);
    expect(await localText()).toBe("edited in UI");
  });

  it("platform-canonical: pull overwrites local edits, push refuses unless forced", async () => {
    await diverge(true, true);
    expect(await sync.push(ctx("platform"))).toMatchObject([{ action: "refused" }]);
    expect(await remoteText()).toBe("edited in UI");
    expect(await sync.push(ctx("platform"), { force: true })).toMatchObject([{ action: "pushed", overwrote: "remote" }]);

    await registry.push(edit(greet, "UI again"));
    await writePrompt(dir, edit(greet, "repo again"));
    expect(await sync.pull(ctx("platform"))).toMatchObject([{ action: "pulled", overwrote: "local" }]);
    expect(await localText()).toBe("UI again");
  });

  it("platform-canonical: a repo-only edit can still be pushed", async () => {
    await diverge(true, false);
    expect(await sync.push(ctx("platform"))).toMatchObject([{ action: "pushed" }]);
    expect(await remoteText()).toBe("edited in repo");
  });

  it("refuses to push non-portable template syntax unless forced, and reports it on status and pull", async () => {
    const loopy: PromptDefinition = { type: "text", name: "loopy", text: "{{#items}}{{name}}{{/items}}" };
    await writePrompt(dir, loopy);
    expect(await sync.status(ctx("repo"))).toMatchObject([{ name: "loopy", nonPortable: ["{{#items}}", "{{/items}}"] }]);
    expect(await sync.push(ctx("repo"))).toMatchObject([{ action: "refused", reason: "non-portable", nonPortable: ["{{#items}}", "{{/items}}"] }]);
    expect(await registry.get({ name: "loopy" })).toBeNull();
    expect(await sync.push(ctx("repo"), { force: true })).toMatchObject([{ action: "pushed", nonPortable: ["{{#items}}", "{{/items}}"] }]);

    // Something written on the platform is still pulled, so the file shows what is really there.
    await registry.push({ type: "text", name: "from-ui", text: "{% if x %}y{% endif %}" });
    const pulled = await sync.pull(ctx("repo"), { only: ["from-ui"] });
    expect(pulled).toMatchObject([{ action: "pulled", nonPortable: ["{% if x %}", "{% endif %}"] }]);
  });

  it("labels, name filters, and switching platform", async () => {
    await writePrompt(dir, greet);
    await writePrompt(dir, fixtures[1]!);
    expect(await sync.push(ctx("repo"), { only: ["plain"], labels: ["production"] })).toMatchObject([{ name: "plain", action: "pushed" }]);
    expect((await registry.get({ name: "plain", label: "production" }))!.definition).toEqual(fixtures[1]);
    expect(await registry.get({ name: "team/greet" })).toBeNull();

    // Same repo, new vendor: everything is local-only there and one push migrates it.
    const other = { dir, registry: memory().prompts!, platform: "elsewhere", canonical: "repo" as const };
    expect((await sync.push(other)).map((r) => r.action)).toEqual(["pushed", "pushed"]);
    expect((await other.registry.get({ name: "team/greet" }))!.definition).toEqual(greet);
  });
});

describe("cli", () => {
  const run = (args: string[]) => cli(args, dir);

  it("loads a TypeScript config, reports status and pushes", async () => {
    await writeFile(
      join(dir, "tas.config.ts"),
      `import { defineConfig, memory } from ${SDK};\n` +
        `export default defineConfig({ profiles: { acme: { platform: memory(), promptsDir: "p" } }, default: "acme" });\n`,
    );
    await writePrompt(join(dir, "p"), greet);

    expect(await run(["prompts", "status"])).toEqual({ code: 0, out: "local-only      team/greet\n" });
    const pushed = await run(["prompts", "push", "--label", "production"]);
    expect(pushed).toMatchObject({ code: 0, out: "pushed     team/greet  @1\n" });
    const lock = JSON.parse(await readFile(join(dir, "p", "tas.lock.json"), "utf8"));
    expect(lock.targets.acme).toMatchObject({ platform: "memory", prompts: { "team/greet": { version: "1" } } });

    const schema = await run(["prompts", "schema"]);
    expect(schema.out).toMatch(/wrote .*p\/prompt\.schema\.json[\s\S]*yaml\.schemas/);

    // delete lists first and only acts with --yes
    const dry = await run(["prompts", "delete", "team/greet"]);
    expect(dry.code).toBe(1);
    expect(dry.out).toMatch(/would delete team\/greet[\s\S]*Nothing deleted/);
    expect(await loadPrompts(join(dir, "p"))).toHaveLength(1);
    expect(await run(["prompts", "delete", "team/greet", "--yes"])).toEqual({ code: 0, out: "removed    team/greet\n" });
    expect(await loadPrompts(join(dir, "p"))).toEqual([]);
    expect((await run(["prompts", "delete"])).out).toMatch(/needs at least one prompt name/);

    expect(await run(["prompts", "status", "--profile", "nope"])).toMatchObject({ code: 1, out: expect.stringMatching(/no profile "nope"/) });
    expect((await run(["bogus"])).code).toBe(2);
  });
});
