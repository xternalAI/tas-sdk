import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPrompts, sync, writePrompt } from "../src/index.ts";
import { fixtures } from "./conformance.ts";
import { LIVE, liveTargets } from "./live.ts";

/**
 * The full file -> platform -> file journey against the real services: push a folder of prompts
 * with nested names, pull them into an empty folder, and expect identical files. Opt-in via
 * `pnpm test:live`. Prompts are written under "tas-live-<timestamp>/" and deleted afterwards.
 */
const targets = liveTargets();

describe.skipIf(!LIVE || targets.length === 0)("sync round trip (live)", { timeout: 180_000 }, () => {
  it.each(targets.map((t) => [t.id, t] as const))(
    "%s: push a folder, pull it into an empty one, get the same prompts",
    async (_id, target) => {
      const prefix = `tas-live-${Date.now()}/sync`;
      const prompts = fixtures.map((f) => ({ ...f, name: `${prefix}/${f.name}` }));
      const names = prompts.map((p) => p.name);
      const [source, copy] = await Promise.all([mkdtemp(join(tmpdir(), "tas-src-")), mkdtemp(join(tmpdir(), "tas-copy-"))]);
      const ctx = (dir: string) => ({ dir, registry: target.prompts!, platform: target.id, canonical: "repo" as const });
      try {
        for (const prompt of prompts) await writePrompt(source, prompt);
        const pushed = await sync.push(ctx(source), { only: names });
        expect(pushed.map((r) => r.action)).toEqual(names.map(() => "pushed"));

        const pulled = await sync.pull(ctx(copy), { only: names });
        expect(pulled.map((r) => [r.name, r.action]).sort()).toEqual(names.map((n) => [n, "pulled"]).sort());
        expect(await loadPrompts(copy)).toEqual(await loadPrompts(source));

        // Nothing changed, so a second push must not create versions, and both folders report in-sync.
        expect((await sync.push(ctx(source), { only: names })).map((r) => r.action)).toEqual(names.map(() => "unchanged"));
        const states = (await sync.status(ctx(copy))).filter((entry) => names.includes(entry.name)).map((entry) => entry.state);
        expect(states).toEqual(names.map(() => "in-sync"));
      } finally {
        for (const name of names) await target.prompts!.delete(name).catch(() => undefined);
        await Promise.all([rm(source, { recursive: true, force: true }), rm(copy, { recursive: true, force: true })]);
      }
    },
  );
});
