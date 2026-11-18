/**
 * Platform-to-platform migration of prompts and datasets. Also pins the migration decisions in
 * docs/decisions.md: labels always survive, history only on request and only where the source can
 * list versions, one failing prompt does not stop the rest, and nothing is migrated half-right.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  braintrust,
  langfuse,
  langsmith,
  memory,
  migrateDatasets,
  migratePrompts,
  type PromptDefinition,
  type PromptRegistry,
} from "../src/index.ts";
import { cli, SDK } from "./cli.ts";
import { datasetItems, fixtures } from "./conformance.ts";
import { fakeBraintrust, fakeLangfuse, fakeLangSmith } from "./fakes.ts";

const greet: PromptDefinition = { type: "text", name: "greet", text: "v1" };
const version = (n: number): PromptDefinition => ({ ...greet, text: `v${n}` });

/** A source with five versions of one prompt: staging on v2, production on v4, v5 newest. */
async function history(): Promise<PromptRegistry> {
  const source = memory().prompts!;
  for (const n of [1, 2, 3, 4, 5])
    await source.push(version(n), n === 2 ? { labels: ["staging"] } : n === 4 ? { labels: ["production"] } : {});
  return source;
}
const text = async (registry: PromptRegistry, ref: { label?: string; version?: string }) =>
  ((await registry.get({ name: "greet", ...ref }))!.definition as { text: string }).text;

describe("migrating prompts", () => {
  it("by default copies the versions in use: each labelled one, then the newest, with labels on the right ones", async () => {
    const [source, target] = [await history(), memory().prompts!];
    expect(await migratePrompts(source, target)).toEqual([
      { name: "greet", action: "migrated", versions: 3, labels: ["production", "staging"] },
    ]);
    expect(await target.versions!("greet")).toHaveLength(3);
    expect([await text(target, {}), await text(target, { label: "production" }), await text(target, { label: "staging" })]).toEqual([
      "v5",
      "v4",
      "v2",
    ]);
  });

  it("with history copies every version, oldest first", async () => {
    const [source, target] = [await history(), memory().prompts!];
    expect(await migratePrompts(source, target, { history: true })).toEqual([
      { name: "greet", action: "migrated", versions: 5, labels: ["production", "staging"] },
    ]);
    const versions = await target.versions!("greet");
    expect(await Promise.all(versions.map((v) => text(target, { version: v })))).toEqual(["v1", "v2", "v3", "v4", "v5"]);
    expect(await text(target, { label: "production" })).toBe("v4");
  });

  it("refuses history from a platform that cannot list versions", async () => {
    const { versions: _none, ...source } = await history();
    await expect(migratePrompts(source, memory().prompts!, { history: true })).rejects.toThrow(/cannot list prompt versions/);
    expect((await migratePrompts(source, memory().prompts!))[0]).toMatchObject({ action: "migrated", versions: 3 }); // without it, fine
    expect(braintrust({ apiKey: "k", projectId: "p" }).prompts!.versions).toBeUndefined(); // Braintrust is such a platform
  });

  it("is safe to run twice: nothing new is created the second time", async () => {
    const [source, target] = [await history(), memory().prompts!];
    await migratePrompts(source, target, { history: true });
    await migratePrompts(source, target, { history: true });
    expect(await target.versions!("greet")).toHaveLength(5);
  });

  it("takes names, and one prompt that fails does not stop the others", async () => {
    const source = memory().prompts!;
    for (const def of fixtures.slice(0, 3)) await source.push(def);
    const target = memory().prompts!;
    expect((await migratePrompts(source, target, { only: ["plain"] })).map((r) => r.name)).toEqual(["plain"]);

    const flaky: PromptRegistry = {
      ...source,
      get: (ref) => (ref.name === "plain" ? Promise.reject(new Error("not portable: reasons")) : source.get(ref)),
    };
    const results = await migratePrompts(flaky, memory().prompts!);
    expect(results.map((r) => [r.name, r.action])).toEqual([
      ["legacy/completion_v1", "migrated"],
      ["plain", "failed"],
      ["support/triage", "migrated"],
    ]);
    expect(results[1]).toMatchObject({ error: "not portable: reasons", versions: 0 });
  });

  it("fails a prompt whose history comes back empty, rather than reporting an empty success", async () => {
    const source = await history();
    const results = await migratePrompts({ ...source, versions: async () => [] }, memory().prompts!, { history: true });
    expect(results).toEqual([{ name: "greet", action: "failed", versions: 0, labels: [], error: "the source listed no versions for it" }]);
  });

  it("fails a prompt, loudly, if the target does not hand back what it was given", async () => {
    const target = memory().prompts!;
    const lossy: PromptRegistry = {
      ...target,
      push: async (def, options) => ({ ...(await target.push(def, options)), definition: { ...def, description: "changed on the way" } }),
    };
    expect(await migratePrompts(await history(), lossy)).toMatchObject([
      { action: "failed", error: expect.stringMatching(/did not survive the move intact/) },
    ]);
  });

  it("moves every kind of prompt across all three platforms and back to where it can be compared", async () => {
    const bt = braintrust({ apiKey: "test-key", projectName: "demo", fetch: fakeBraintrust().fetch }).prompts!;
    const lf = langfuse({ publicKey: "pk-test", secretKey: "sk-test", fetch: fakeLangfuse().fetch }).prompts!;
    const ls = langsmith({ apiKey: "ls-test", fetch: fakeLangSmith().fetch }).prompts!;
    for (const def of fixtures) await bt.push(def, { labels: ["production"] });
    await bt.push({ ...fixtures[1]!, description: "newer, not yet in production" });

    for (const [from, to, withHistory] of [
      [bt, lf, false],
      [lf, ls, true],
      [ls, memory().prompts!, true],
    ] as const) {
      const results = await migratePrompts(from, to, { history: withHistory });
      expect(results.filter((r) => r.action === "failed")).toEqual([]);
      for (const def of fixtures) {
        expect((await to.get({ name: def.name, label: "production" }))!.definition).toEqual(def);
      }
      expect((await to.get({ name: "plain" }))!.definition.description).toBe("newer, not yet in production");
    }
  });
});

describe("migrating datasets", () => {
  it("copies items with their ids, takes names, and reports a dataset that fails without stopping", async () => {
    const [source, target] = [memory().datasets!, memory().datasets!];
    await source.push({ name: "qa", description: "QA set", items: datasetItems });
    await source.push({ name: "smoke", items: [{ id: "a", input: 1 }] });
    expect(await migrateDatasets(source, target, { only: ["smoke"] })).toEqual([{ name: "smoke", action: "migrated", items: 1 }]);
    expect(await migrateDatasets(source, target)).toEqual([
      { name: "qa", action: "migrated", items: 4 },
      { name: "smoke", action: "migrated", items: 1 },
    ]);
    expect(await target.pull("qa")).toEqual({ name: "qa", description: "QA set", items: datasetItems });

    const flaky = { ...source, pull: (name: string) => (name === "qa" ? Promise.resolve(null) : source.pull(name)) };
    expect(await migrateDatasets(flaky, memory().datasets!)).toEqual([
      { name: "qa", action: "failed", items: 0, error: "listed by the source but could not be fetched" },
      { name: "smoke", action: "migrated", items: 1 },
    ]);
  });
});

describe("tas ... migrate", () => {
  it("copies between two profiles of one config, and says what it needs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tas-migrate-"));
    try {
      await writeFile(
        join(dir, "tas.config.ts"),
        `import { defineConfig, memory } from ${SDK};
const old = memory();
await old.prompts.push({ type: "text", name: "greet", text: "v1" }, { labels: ["production"] });
await old.prompts.push({ type: "text", name: "greet", text: "v2" });
await old.datasets.push({ name: "qa", items: [{ id: "a", input: 1 }] });
export const next = memory();
export default defineConfig({ profiles: { old: { platform: old }, next: { platform: next }, bare: { platform: { id: "bare" } } }, default: "old" });
`,
      );
      expect(await cli(["prompts", "migrate", "--from", "old", "--to", "next"], dir)).toEqual({
        code: 0,
        out: "migrated   greet  2 versions, labels: production\n",
      });
      expect(await cli(["prompts", "migrate", "--from", "old", "--to", "next", "--history", "greet"], dir)).toEqual({
        code: 0,
        out: "migrated   greet  0 versions, labels: production\n",
      });
      expect(await cli(["datasets", "migrate", "--from", "old", "--to", "next"], dir)).toEqual({
        code: 0,
        out: "migrated   qa  1 items\n",
      });
      expect(await cli(["prompts", "migrate", "--from", "next", "--to", "old", "nothing-by-this-name"], dir)).toEqual({
        code: 0,
        out: "no prompts on the source platform\n",
      });

      expect((await cli(["prompts", "migrate", "--from", "old"], dir)).out).toBe(
        "tas: migrate needs --from <profile> and --to <profile>\n",
      );
      expect((await cli(["prompts", "migrate", "--from", "old", "--to", "old"], dir)).out).toBe(
        "tas: --from and --to are the same profile\n",
      );
      expect((await cli(["prompts", "migrate", "--from", "old", "--to", "nope"], dir)).out).toMatch(/no profile "nope"/);
      expect((await cli(["prompts", "migrate", "--from", "old", "--to", "bare"], dir)).out).toBe(
        "tas: both platforms must have a prompt registry\n",
      );
      expect((await cli(["datasets", "migrate", "--from", "old", "--to", "bare"], dir)).out).toBe(
        "tas: both platforms must store datasets\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
