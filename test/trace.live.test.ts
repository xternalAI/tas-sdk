import { describe, expect, it } from "vitest";
import { createClient, memory } from "../src/index.ts";
import { LIVE, liveTargets } from "./live.ts";

/**
 * Sends a small trace to every platform that has credentials in the environment or .env, and
 * checks each one accepts it. Opt-in via `pnpm test:live`. Whether a platform then displays the
 * trace as intended was checked by hand (see docs/decisions.md); ingestion is too slow and
 * eventually-consistent to assert on here. Traces are left on the platforms.
 */
const targets = liveTargets({ langsmithProject: "tas-live" });

describe.skipIf(!LIVE || targets.length === 0)("tracing (live)", { timeout: 60_000 }, () => {
  it.each(targets.map((t) => [t.id, t] as const))("%s accepts a trace with nested spans", async (_id, target) => {
    const errors: string[] = [];
    const client = createClient({ platform: memory(), tracing: [target], onTraceError: (error) => errors.push(error.message) });
    await client.trace(
      "tas-live-trace",
      { input: { check: true }, userId: "tas-live", sessionId: "tas-live", tags: ["tas-live"], metadata: { source: "trace.live.test" } },
      () => client.trace("child", () => "ok"),
    );
    await client.flush();
    expect(errors).toEqual([]);
  });
});
