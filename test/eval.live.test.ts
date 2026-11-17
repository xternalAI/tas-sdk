import { describe, expect, it } from "vitest";
import { braintrust, createClient, exactMatch, langfuse, langsmith, memory, type PlatformAdapter } from "../src/index.ts";

/**
 * Reports a tiny experiment to every platform that has credentials in the environment or .env,
 * twice, and checks each accepts it. Opt-in via `pnpm test:live`. Datasets and experiments are
 * named "tas-live-..." and removed by `pnpm cleanup:live`.
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
  ...(e.LANGSMITH_API_KEY ? [langsmith({ apiKey: e.LANGSMITH_API_KEY, ...(e.LANGSMITH_BASE_URL ? { baseURL: e.LANGSMITH_BASE_URL } : {}) })] : []),
];
const stamp = Date.now();

describe.skipIf(e.TAS_LIVE !== "1" || targets.length === 0)("experiments (live)", { timeout: 120_000 }, () => {
  it.each(targets.map((t) => [t.id, t] as const))("%s stores an experiment, and a second run against the same dataset", async (_id, target) => {
    const client = createClient({ platform: memory(), tracing: false });
    const run = () =>
      client.evaluate(`tas-live-eval-${stamp}`, {
        data: {
          name: `tas-live-${stamp}`,
          description: "Created by the trace-and-scale live tests",
          items: [
            { id: "lv", input: { country: "Latvia" }, expected: "Riga" },
            { id: "lt", input: { country: "Lithuania" }, expected: "Vilnius", metadata: { region: "baltic" } },
            { id: "xx", input: { country: "Atlantis" }, expected: "?" },
          ],
        },
        task: (input: { country: string }) => {
          if (input.country === "Atlantis") throw new Error("unknown country");
          return input.country === "Latvia" ? "Riga" : "Kaunas";
        },
        scorers: { exact: exactMatch, partial: ({ output }) => ({ score: 0.5, comment: `saw ${output}` }) },
        metadata: { source: "eval.live.test" },
        report: [target],
      });
    const first = await run();
    await new Promise((r) => setTimeout(r, 5));
    const second = await run();
    expect(first.reports).toEqual([{ platform: target.id, ...(first.reports[0]!.url ? { url: first.reports[0]!.url } : {}) }]);
    expect(second.reports[0]!.error).toBeUndefined();
    expect(first.summary).toMatchObject({ errors: 1, scores: { exact: { mean: 0.5, count: 2 } } });
  });
});
