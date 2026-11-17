import { describe } from "vitest";
import { braintrust, langfuse, langsmith, type PlatformAdapter } from "../src/index.ts";
import { datasetConformance } from "./conformance.ts";

/**
 * Runs the dataset store conformance suite against every platform that has credentials in the
 * environment or .env. Opt-in via `pnpm test:live`. Datasets are named "tas-live-..." and removed
 * by `pnpm cleanup:live` (except on Langfuse, whose API cannot delete datasets).
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

describe.skipIf(e.TAS_LIVE !== "1" || targets.length === 0)("dataset stores (live)", { timeout: 120_000 }, () => {
  for (const target of targets) {
    // A fresh dataset per test: these platforms keep what earlier tests wrote.
    describe(target.id, () => datasetConformance(() => target.datasets!, `tas-live-${Date.now()}-${target.id}`));
  }
});
