import { expect, it } from "vitest";
import type { PromptDefinition, PromptRegistry } from "../src/index.ts";

/** Prompts exercising every part of the canonical model. Every adapter must round-trip all of them. */
export const fixtures: PromptDefinition[] = [
  {
    type: "chat",
    name: "support/triage",
    description: "Routes a ticket",
    model: { id: "gpt-5", params: { temperature: 0, max_tokens: 400 } },
    messages: [
      { role: "system", content: "You triage tickets for {{company}}." },
      { placeholder: "history" },
      { role: "user", content: "{{ticket.body}}" },
    ],
    tools: [
      { name: "lookup_order", description: "Find an order", parameters: { type: "object", properties: { id: { type: "string" } } } },
    ],
    output: { name: "triage", schema: { type: "object", properties: { queue: { type: "string" } } }, strict: true },
    tags: ["support"],
    metadata: { owner: "cx-team" },
  },
  { type: "chat", name: "plain", messages: [{ role: "user", content: "Hi {{name}}" }] },
  { type: "text", name: "legacy/completion_v1", text: "Summarise: {{text}}", model: { id: "gpt-5-mini" } },
  { type: "text", name: "text-with-tools", text: "Go", tools: [{ name: "noop", parameters: {} }] },
];

export interface ConformanceOptions {
  /** Two labels that exist on the platform, or null to skip label checks. */
  labels?: [string, string] | null;
  /** Prefix for prompt names, so runs against a shared, persistent platform never collide. */
  prefix?: string;
}

export function conformance(make: () => PromptRegistry, options: ConformanceOptions = {}) {
  const labels = options.labels === undefined ? (["production", "staging"] as const) : options.labels;
  const cases = fixtures.map((f): PromptDefinition => ({ ...f, name: (options.prefix ?? "") + f.name }));

  it.each(cases)("round-trips $name", async (def) => {
    const reg = make();
    const pushed = await reg.push(def);
    expect(pushed.definition).toEqual(def);
    expect((await reg.get({ name: def.name, version: pushed.version }))!.definition).toEqual(def);
    expect((await reg.get({ name: def.name }))!.definition).toEqual(def);
  });

  it("does not create a version when nothing changed", async () => {
    const reg = make();
    for (const def of cases) {
      const first = await reg.push(def);
      expect((await reg.push(def)).version).toBe(first.version);
    }
  });

  it("versions are immutable", async () => {
    const reg = make();
    const def: PromptDefinition = { ...cases[1]!, name: cases[1]!.name + "-versions" };
    const v1 = await reg.push(def);
    const v2 = await reg.push({ ...def, description: "second" });
    expect(v2.version).not.toBe(v1.version);
    expect((await reg.get({ name: def.name, version: v1.version }))!.definition).toEqual(def);
    expect((await reg.get({ name: def.name }))!.definition.description).toBe("second");
  });

  it.skipIf(!labels)("labels point at a version and can be moved", async () => {
    const reg = make();
    const [prod, staging] = labels!;
    const def: PromptDefinition = { ...cases[1]!, name: cases[1]!.name + "-labels" };
    const v1 = await reg.push(def, { labels: [prod] });
    const v2 = await reg.push({ ...def, description: "second" }, { labels: [staging] });
    expect((await reg.get({ name: def.name, label: prod }))!.version).toBe(v1.version);
    expect((await reg.get({ name: def.name, label: staging }))!.version).toBe(v2.version);
    expect((await reg.get({ name: def.name, version: v1.version }))!.labels).toEqual([prod]);
    await reg.setLabels(def.name, v2.version, [prod]);
    const moved = (await reg.get({ name: def.name, label: prod }))!;
    expect(moved.version).toBe(v2.version);
    expect([...moved.labels].sort()).toEqual([prod, staging].sort());
    expect((await reg.get({ name: def.name, version: v1.version }))!.labels).toEqual([]);
    expect((await reg.list()).find((p) => p.name === def.name)!.labels.sort()).toEqual([prod, staging].sort());
  });

  it("archiving is a version like any other, and removing the flag restores the prompt", async () => {
    const reg = make();
    const def: PromptDefinition = { ...cases[0]!, name: cases[0]!.name + "-archive" };
    const live = await reg.push(def);
    const archived = await reg.push({ ...def, archived: true });
    expect(archived.version).not.toBe(live.version);
    expect((await reg.get({ name: def.name }))!.definition).toEqual({ ...def, archived: true }); // user tags untouched
    expect((await reg.push({ ...def, archived: true })).version).toBe(archived.version);
    await reg.push(def);
    expect((await reg.get({ name: def.name }))!.definition).toEqual(def);
    expect((await reg.get({ name: def.name, version: live.version }))!.definition.archived).toBeUndefined();
  });

  it("delete removes a prompt and all its versions, and is a no-op when there is nothing to delete", async () => {
    const reg = make();
    const def: PromptDefinition = { ...cases[1]!, name: cases[1]!.name + "-delete" };
    const v1 = await reg.push(def);
    await reg.push({ ...def, description: "second" });
    await reg.delete(def.name);
    expect(await reg.get({ name: def.name })).toBeNull();
    expect(await reg.get({ name: def.name, version: v1.version })).toBeNull();
    expect((await reg.list()).map((p) => p.name)).not.toContain(def.name);
    await reg.delete(def.name);
    expect((await reg.push(def)).definition).toEqual(def); // the name can be used again
  });

  it("returns null for unknown prompts and lists known ones", async () => {
    const reg = make();
    expect(await reg.get({ name: (options.prefix ?? "") + "missing" })).toBeNull();
    if (labels) {
      expect(await reg.get({ name: (options.prefix ?? "") + "missing", label: labels[0] })).toBeNull();
      const unlabelled = await reg.push({ ...cases[1]!, name: cases[1]!.name + "-unlabelled" });
      expect(await reg.get({ name: unlabelled.definition.name, label: labels[0] })).toBeNull();
    }
    for (const def of cases) await reg.push(def);
    expect((await reg.list()).map((p) => p.name)).toEqual(expect.arrayContaining(cases.map((c) => c.name)));
  });
}
