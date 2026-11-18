import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createClient,
  defineConfig,
  hashPrompt,
  inScope,
  loadDataset,
  loadPromptVersions,
  memory,
  type PromptDefinition,
  PromptNotFoundError,
  promptPath,
  resolveProfile,
  sync,
  writeDataset,
  writePrompt,
} from "../src/index.ts";
import { cli, SDK } from "./cli.ts";

/**
 * Decisions that came out of running a real application against a shared platform project (see
 * "Sharing a project, and not changing more than you meant" in docs/decisions.md).
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tas-safety-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const run = (...args: string[]) => cli(args, dir);
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const text = (name: string, body = "Hi {{name}}"): PromptDefinition => ({ type: "text", name, text: body });

/** A config whose platform already holds two prompts and two datasets that belong to another application. */
const sharedProject = (options = "") =>
  writeFile(
    join(dir, "tas.config.ts"),
    `import * as tas from ${SDK};
const platform = tas.memory();
await platform.prompts.push({ type: "text", name: "other/a", text: "theirs" }, { labels: ["production"] });
await platform.prompts.push({ type: "text", name: "other/b", text: "theirs" });
await platform.datasets.push({ name: "other/data", items: [{ id: "1", input: 1 }] });
await platform.datasets.push({ name: "mine/data", items: [{ id: "1", input: 1 }] });
export const store = platform;
export default tas.defineConfig({ platform, ${options} });
`,
  );
const platformOf = async () =>
  ((await import(pathToFileURL(join(dir, "tas.config.ts")).href)) as { store: ReturnType<typeof memory> }).store;

describe("decisions: a scope keeps the CLI inside your part of a shared project", () => {
  it("inScope: a folder covers everything under it, a name covers itself, no scope covers everything", () => {
    expect(inScope("mine/x", "mine/")).toBe(true);
    expect(inScope("mine/deep/x", ["other/", "mine/"])).toBe(true);
    expect(inScope("mine-too/x", "mine/")).toBe(false);
    expect(inScope("mine", "mine/")).toBe(false);
    expect(inScope("exact", ["exact"])).toBe(true);
    expect(inScope("exact/child", "exact")).toBe(false);
    expect(inScope("anything", undefined)).toBe(true);
  });

  it("status, pull and push neither show nor touch prompts outside the scope", async () => {
    await sharedProject('scope: "mine/"');
    await writePrompt(join(dir, "prompts"), text("mine/x"));
    expect((await run("prompts", "status")).out).toBe("local-only      mine/x\n");

    // Without a scope this pull would write other/a and other/b into the repository.
    expect(await run("prompts", "pull")).toEqual({ code: 0, out: "1 only in your files, left alone\n" });
    expect(await exists(promptPath(join(dir, "prompts"), "other/a"))).toBe(false);

    expect(await run("prompts", "push")).toEqual({ code: 0, out: "pushed     mine/x  @1\n" });
    const platform = await platformOf();
    expect((await platform.prompts!.list()).map((p) => p.name).sort()).toEqual(["mine/x", "other/a", "other/b"]);
    expect((await platform.prompts!.get({ name: "other/a" }))!.version).toBe("1");
  });

  it("a prompt file outside the scope is not pushed either", async () => {
    await sharedProject('scope: ["mine/"]');
    await writePrompt(join(dir, "prompts"), text("mine/x"));
    await writePrompt(join(dir, "prompts"), text("other/a", "edited here by mistake"));
    expect((await run("prompts", "push")).out).toBe("pushed     mine/x  @1\n");
    expect((await (await platformOf()).prompts!.get({ name: "other/a" }))!.definition).toMatchObject({ text: "theirs" });
    const checked = (await run("prompts", "check")).out;
    expect(checked).toMatch(/^ok {6}mine\/x\n/);
    expect(checked).not.toContain("other/a");
  });

  it("the lockfile keeps other scopes' entries", async () => {
    await writePrompt(dir, text("mine/x"));
    await writePrompt(dir, text("other/a"));
    const registry = memory().prompts!;
    const all = { dir, registry, platform: "memory", canonical: "repo" as const };
    await sync.push(all);
    await sync.push({ ...all, scope: "mine/" });
    expect(Object.keys((await loadPromptVersions(dir))!.prompts)).toEqual(["mine/x", "other/a"]);
  });

  it("datasets follow the scope too", async () => {
    await sharedProject('scope: "mine/"');
    expect((await run("datasets", "list")).out).toBe("mine/data\n");
    expect((await run("datasets", "pull")).out).toMatch(/^pulled {5}mine\/data {2}1 items/);
    expect(await exists(join(dir, "datasets", "other"))).toBe(false);
    await writeDataset(join(dir, "datasets"), { name: "other/local", items: [{ input: 1 }] });
    expect((await run("datasets", "push")).out).toBe("pushed     mine/data  1 items\n");
  });

  it("without a scope everything in the project is in play, as before", async () => {
    await sharedProject();
    await writePrompt(join(dir, "prompts"), text("mine/x"));
    expect((await run("prompts", "status")).out).toBe("local-only      mine/x\nremote-only     other/a\nremote-only     other/b\n");
    expect((await run("datasets", "list")).out).toBe("mine/data\nother/data\n");
  });
});

describe('decisions: a name ending in "/" means everything under that folder', () => {
  it("works for status, push, pull and datasets", async () => {
    await sharedProject();
    await writePrompt(join(dir, "prompts"), text("mine/x"));
    await writePrompt(join(dir, "prompts"), text("mine/y"));
    await writePrompt(join(dir, "prompts"), text("solo"));
    expect((await run("prompts", "status", "mine/")).out).toBe("local-only      mine/x\nlocal-only      mine/y\n");
    expect((await run("prompts", "push", "mine/")).out).toBe("pushed     mine/x  @1\npushed     mine/y  @1\n");
    expect((await run("prompts", "pull", "other/")).out).toBe("pulled     other/a  @1\npulled     other/b  @1\n");
    expect((await run("datasets", "pull", "other/")).out).toMatch(/^pulled {5}other\/data/);
    expect((await run("datasets", "pull", "nope")).out).toBe("missing    nope  (not on the platform)\n");
  });

  it("works for migration", async () => {
    await writeFile(
      join(dir, "tas.config.ts"),
      `import * as tas from ${SDK};
const a = tas.memory(); const b = tas.memory();
for (const name of ["mine/x", "mine/y", "other/a"]) await a.prompts.push({ type: "text", name, text: "t" });
for (const name of ["mine/d", "other/d"]) await a.datasets.push({ name, items: [{ id: "1", input: 1 }] });
export default tas.defineConfig({ default: "a", profiles: { a: { platform: a, scope: "other/" }, b: { platform: b } } });
`,
    );
    expect((await run("prompts", "migrate", "--from", "a", "--to", "b", "mine/")).out).toBe(
      "migrated   mine/x  1 version\nmigrated   mine/y  1 version\n",
    );
    // With no names, the source profile's scope decides.
    expect((await run("prompts", "migrate", "--from", "a", "--to", "b")).out).toBe("migrated   other/a  1 version\n");
    expect((await run("datasets", "migrate", "--from", "a", "--to", "b")).out).toBe("migrated   other/d  1 items\n");
  });
});

describe("decisions: seeing what a sync would do, and not hiding what it did", () => {
  it("--dry-run reports and changes nothing: no versions, no files, no lockfile", async () => {
    await sharedProject();
    await writePrompt(join(dir, "prompts"), text("mine/x"));
    expect(await run("prompts", "push", "--dry-run")).toEqual({
      code: 0,
      out: "would push mine/x\n2 only on the platform, left alone\nDry run: nothing was changed.\n",
    });
    expect((await (await platformOf()).prompts!.list()).map((p) => p.name)).not.toContain("mine/x");
    expect(await run("prompts", "pull", "--dry-run")).toEqual({
      code: 0,
      out: "would pull other/a  @1\nwould pull other/b  @1\n1 only in your files, left alone\nDry run: nothing was changed.\n",
    });
    expect(await exists(promptPath(join(dir, "prompts"), "other/a"))).toBe(false);
    expect(await exists(join(dir, "prompts", sync.LOCKFILE))).toBe(false);
  });

  it("a dry run still refuses what the real run would refuse, and deletes nothing", async () => {
    const registry = memory().prompts!;
    const ctx = { dir, registry, platform: "memory", canonical: "platform" as const };
    await writePrompt(dir, text("gone"));
    await sync.push(ctx);
    await registry.delete("gone");
    expect(await sync.pull(ctx, { dryRun: true })).toEqual([{ name: "gone", action: "removed", overwrote: "local" }]);
    expect(await exists(promptPath(dir, "gone"))).toBe(true);
    await writePrompt(dir, text("loopy", "{{#a}}x{{/a}}"));
    expect((await sync.push(ctx, { dryRun: true, only: ["loopy"] }))[0]).toMatchObject({ action: "refused", reason: "non-portable" });
    expect(await sync.push({ ...ctx, canonical: "repo" }, { dryRun: true, only: ["gone"] })).toEqual([
      { name: "gone", action: "pushed", overwrote: "remote" },
    ]);
  });

  it("prompts that needed nothing are counted, not listed, unless you named them", async () => {
    await sharedProject();
    await writePrompt(join(dir, "prompts"), text("mine/x"));
    await run("prompts", "push");
    expect((await run("prompts", "push")).out).toBe("1 unchanged\n2 only on the platform, left alone\n");
    expect((await run("prompts", "push", "mine/x")).out).toBe("unchanged  mine/x  @1\n");
    expect((await run("prompts", "push", "nothing/")).out).toBe("no prompts\n");
  });
});

describe("decisions: a label is never applied to every prompt by leaving the names out", () => {
  it("--label with no names is refused, and changes nothing", async () => {
    await sharedProject();
    await writePrompt(join(dir, "prompts"), text("mine/x"));
    const refused = await run("prompts", "push", "--label", "staging");
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(
      /^tas: --label with no prompt names would point "staging" at every prompt\. Name the prompts .* or pass --all/,
    );
    expect((await (await platformOf()).prompts!.list()).map((p) => p.name)).not.toContain("mine/x");
  });

  it("naming prompts, a folder, or --all says what is meant; labelled prompts are always listed", async () => {
    await sharedProject('scope: "mine/"');
    await writePrompt(join(dir, "prompts"), text("mine/x"));
    await writePrompt(join(dir, "prompts"), text("mine/y"));
    expect((await run("prompts", "push", "--label", "staging", "mine/x")).out).toBe("pushed     mine/x  @1\n");
    expect((await run("prompts", "push", "--label", "staging", "mine/")).out).toBe("unchanged  mine/x  @1\npushed     mine/y  @1\n");
    // --all still stays inside the scope.
    expect((await run("prompts", "push", "--label", "production", "--all")).out).toBe("unchanged  mine/x  @1\nunchanged  mine/y  @1\n");
    const platform = await platformOf();
    expect((await platform.prompts!.get({ name: "mine/y", label: "production" }))!.version).toBe("1");
    expect(await platform.prompts!.get({ name: "other/b", label: "production" })).toBeNull();
  });
});

describe("decisions: profiles in application code", () => {
  const profiles = defineConfig({
    default: "a",
    profiles: { a: { platform: memory(), defaultLabel: "one" }, b: { platform: memory(), defaultLabel: "two" } },
  });

  it("createClient takes a profiles config: the default profile, or the one named", () => {
    expect(createClient(profiles).config.defaultLabel).toBe("one");
    expect(createClient(profiles, "b").config.defaultLabel).toBe("two");
    expect(() => createClient(profiles, "c")).toThrow('no profile "c" (have: a, b)');
  });

  it("resolveProfile is the same rule the CLI uses, and refuses a profile name for a single config", () => {
    expect(resolveProfile(profiles)).toEqual({ config: profiles.profiles.a, name: "a" });
    expect(resolveProfile(profiles, "b").name).toBe("b");
    const single = defineConfig({ platform: memory() });
    expect(resolveProfile(single)).toEqual({ config: single, name: "default" });
    expect(() => resolveProfile(single, "b")).toThrow("single config without profiles");
  });
});

describe("decisions: a prompt that is not found says where it was looked for", () => {
  it("names the default label, the usual reason on a platform that calls it something else", async () => {
    const platform = memory();
    await platform.prompts!.push(text("greet"), { labels: ["prod"] });
    const client = createClient({ platform, canonical: "platform", tracing: false });
    const error = await client.prompts.get("greet").catch((e: Error) => e);
    expect(error).toBeInstanceOf(PromptNotFoundError);
    expect((error as Error).message).toBe(
      'prompt "greet" not found at the default label "production" (set `defaultLabel` if your platform uses another name), nor among the bundled prompts (canonical: platform)',
    );
    expect(
      (await createClient({ platform, canonical: "platform", defaultLabel: "prod", tracing: false }).prompts.get("greet")).source,
    ).toBe("remote");
    await expect(createClient({ platform: { id: "bare" }, tracing: false }).prompts.get("greet")).rejects.toThrow(
      'prompt "greet" not found among the bundled prompts',
    );
  });
});

describe("decisions: traces of bundled prompts link to the platform version they were synced as", () => {
  const greet = text("greet");

  it("loadPromptVersions reads the lockfile; the client uses it while the content is unchanged", async () => {
    const platform = memory();
    await writePrompt(dir, greet);
    await sync.push({ dir, registry: platform.prompts!, platform: "memory", canonical: "repo" });
    const versions = await loadPromptVersions(dir);
    expect(versions).toEqual({ platform: "memory", prompts: { greet: { hash: hashPrompt(greet), version: "1" } } });

    const linked = await createClient({ platform, prompts: [greet], promptVersions: versions!, tracing: false }).prompts.get("greet");
    expect(linked).toMatchObject({ source: "local", remote: { platform: "memory", version: "1", labels: [] } });

    // Edited since the sync: the lockfile's version is no longer this content, so no link is claimed.
    const edited = await createClient({ platform, prompts: [text("greet", "changed")], promptVersions: versions!, tracing: false });
    expect((await edited.prompts.get("greet")).remote).toBeUndefined();
  });

  it("versions of another platform, or of another profile, are ignored", async () => {
    const versions = { platform: "langfuse", prompts: { greet: { hash: hashPrompt(greet), version: "9" } } };
    const client = createClient({ platform: memory(), prompts: [greet], promptVersions: versions, tracing: false });
    expect((await client.prompts.get("greet")).remote).toBeUndefined();
    expect(await loadPromptVersions(dir, "nope")).toBeUndefined();
    expect((await createClient({ platform: memory(), prompts: [greet], tracing: false }).prompts.get("greet")).remote).toBeUndefined();
  });
});

describe("decisions: a dataset in a folder keeps its full name", () => {
  it("loadDataset takes the name when the path alone cannot give it", async () => {
    const path = await writeDataset(dir, { name: "support/tickets", items: [{ input: 1 }] });
    expect((await loadDataset(path)).name).toBe("tickets");
    expect(await loadDataset(path, { name: "support/tickets" })).toEqual({ name: "support/tickets", items: [{ input: 1 }] });
    expect(await readFile(path, "utf8")).toBe('{"input":1}\n');
  });
});
