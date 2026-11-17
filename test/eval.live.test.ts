import { describe, expect, it } from "vitest";
import { createClient, exactMatch, memory } from "../src/index.ts";
import { LIVE, liveTargets } from "./live.ts";

/**
 * Reports a tiny experiment to every platform that has credentials in the environment or .env,
 * twice, and checks each accepts it. Opt-in via `pnpm test:live`. Datasets and experiments are
 * named "tas-live-..." and removed by `pnpm cleanup:live`.
 */
const targets = liveTargets();
const stamp = Date.now();

describe.skipIf(!LIVE || targets.length === 0)("experiments (live)", { timeout: 120_000 }, () => {
  it.each(targets.map((t) => [t.id, t] as const))(
    "%s stores an experiment, and a second run against the same dataset",
    async (_id, target) => {
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
    },
  );
});
