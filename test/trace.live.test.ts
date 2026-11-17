import { describe, expect, it } from "vitest";
import { braintrust, createClient, langfuse, langsmith, memory, type PlatformAdapter } from "../src/index.ts";

/**
 * Sends a small trace to every platform that has credentials in the environment or .env, and
 * checks each one accepts it. Opt-in via `pnpm test:live`. Whether a platform then displays the
 * trace as intended was checked by hand (see docs/decisions.md); ingestion is too slow and
 * eventually-consistent to assert on here. Traces are left on the platforms.
 */
try {
  process.loadEnvFile();
} catch {
  // no .env file
}
const e = process.env;
const targets: PlatformAdapter[] = [
  ...(e.BRAINTRUST_API_KEY && e.TAS_LIVE_PROJECT ? [braintrust({ apiKey: e.BRAINTRUST_API_KEY, projectName: e.TAS_LIVE_PROJECT })] : []),
  ...(e.LANGFUSE_PUBLIC_KEY && e.LANGFUSE_SECRET_KEY ? [langfuse({ publicKey: e.LANGFUSE_PUBLIC_KEY, secretKey: e.LANGFUSE_SECRET_KEY, ...(e.LANGFUSE_BASE_URL ? { baseURL: e.LANGFUSE_BASE_URL } : {}) })] : []),
  ...(e.LANGSMITH_API_KEY ? [langsmith({ apiKey: e.LANGSMITH_API_KEY, project: "tas-live", ...(e.LANGSMITH_BASE_URL ? { baseURL: e.LANGSMITH_BASE_URL } : {}) })] : []),
];

describe.skipIf(e.TAS_LIVE !== "1" || targets.length === 0)("tracing (live)", { timeout: 60_000 }, () => {
  it.each(targets.map((t) => [t.id, t] as const))("%s accepts a trace with nested spans", async (_id, target) => {
    const errors: string[] = [];
    const client = createClient({ platform: memory(), tracing: [target], onTraceError: (error) => errors.push(error.message) });
    await client.trace("tas-live-trace", { input: { check: true }, userId: "tas-live", sessionId: "tas-live", tags: ["tas-live"], metadata: { source: "trace.live.test" } }, () =>
      client.trace("child", () => "ok"),
    );
    await client.flush();
    expect(errors).toEqual([]);
  });
});
