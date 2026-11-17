import { describe } from "vitest";
import { datasetConformance } from "./conformance.ts";
import { LIVE, liveTargets } from "./live.ts";

/**
 * Runs the dataset store conformance suite against every platform that has credentials in the
 * environment or .env. Opt-in via `pnpm test:live`. Datasets are named "tas-live-..." and removed
 * by `pnpm cleanup:live` (except on Langfuse, whose API cannot delete datasets).
 */
const targets = liveTargets();

describe.skipIf(!LIVE || targets.length === 0)("dataset stores (live)", { timeout: 120_000 }, () => {
  for (const target of targets) {
    // A fresh dataset per test: these platforms keep what earlier tests wrote.
    describe(target.id, () => datasetConformance(() => target.datasets!, `tas-live-${Date.now()}-${target.id}`));
  }
});
