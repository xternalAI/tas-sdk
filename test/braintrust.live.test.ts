import { describe } from "vitest";
import { braintrust } from "../src/index.ts";
import { conformance } from "./conformance.ts";

/**
 * Runs the conformance suite against the real Braintrust API. Opt-in: it only
 * runs via `pnpm test:live`, and only when both variables are set (in the environment or a local .env file).
 *
 *   BRAINTRUST_API_KEY   key for the org to test against
 *   TAS_LIVE_PROJECT     name of an existing, disposable project; never created here
 *   TAS_LIVE_LABELS      optional "prod,staging": two environments that exist in the org
 *
 * Each run writes prompts under a fresh "tas-live-<timestamp>/" prefix; `pnpm cleanup:live` removes them.
 */
try {
  process.loadEnvFile();
} catch {
  // no .env file
}
const { BRAINTRUST_API_KEY: apiKey, TAS_LIVE_PROJECT: projectName, TAS_LIVE_LABELS: labelList } = process.env;
const labels = labelList?.split(",").map((l) => l.trim());

describe.skipIf(process.env.TAS_LIVE !== "1" || !apiKey || !projectName)("braintrust adapter (live)", { timeout: 60_000 }, () => {
  const registry = braintrust({ apiKey: apiKey!, projectName: projectName! }).prompts!;
  conformance(() => registry, {
    prefix: `tas-live-${Date.now()}/`,
    labels: labels?.length === 2 ? [labels[0]!, labels[1]!] : null,
  });
});
