import { describe, expect, it } from "vitest";
import { migratePrompts, type PlatformAdapter } from "../src/index.ts";
import { fixtures } from "./conformance.ts";
import { LIVE, liveTargets } from "./live.ts";

/**
 * Migrates real prompts from platform to platform along the chain Langfuse -> LangSmith ->
 * Braintrust, with history and a label, and checks each hop. Opt-in via `pnpm test:live`; needs
 * all three sets of credentials and a Braintrust environment named by TAS_LIVE_LABELS (its first
 * entry). Prompts are written under "tas-live-<timestamp>/" and deleted afterwards.
 */
const byId = Object.fromEntries(liveTargets().map((t) => [t.id, t])) as Record<string, PlatformAdapter | undefined>;
const chain = [byId.langfuse, byId.langsmith, byId.braintrust];
const label = process.env.TAS_LIVE_LABELS?.split(",")[0]?.trim();

describe.skipIf(!LIVE || chain.some((t) => !t) || !label)("migration between platforms (live)", { timeout: 300_000 }, () => {
  it("carries every kind of prompt, its history and its label across all three", async () => {
    const prefix = `tas-live-${Date.now()}/migrate`;
    const prompts = fixtures.map((f) => ({ ...f, name: `${prefix}/${f.name}` }));
    const names = prompts.map((p) => p.name);
    const [first, ...rest] = chain.map((t) => t!.prompts!);
    try {
      // On the first platform: the labelled version, then a newer one, so there is history to carry.
      for (const prompt of prompts) {
        await first!.push(prompt, { labels: [label!] });
        await first!.push({ ...prompt, description: "newer, not labelled" });
      }
      let source = first!;
      for (const target of rest) {
        const results = await migratePrompts(source, target, { only: names, history: true });
        expect(results.map((r) => [r.name, r.action, r.error])).toEqual([...names].sort().map((name) => [name, "migrated", undefined]));
        for (const prompt of prompts) {
          expect((await target.get({ name: prompt.name, label: label! }))!.definition).toEqual(prompt);
          expect((await target.get({ name: prompt.name }))!.definition).toEqual({ ...prompt, description: "newer, not labelled" });
        }
        // Run again: everything is already there.
        expect((await migratePrompts(source, target, { only: names, history: true })).map((r) => r.versions)).toEqual(names.map(() => 0));
        if (!target.versions) break; // cannot be the source of a history migration
        source = target;
      }
    } finally {
      for (const platform of chain) for (const name of names) await platform!.prompts!.delete(name).catch(() => undefined);
    }
  });
});
