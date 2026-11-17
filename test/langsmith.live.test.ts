import { describe } from "vitest";
import { langsmith } from "../src/index.ts";
import { conformance } from "./conformance.ts";

/**
 * Runs the conformance suite against a real LangSmith workspace. Opt-in: it only
 * runs via `pnpm test:live`, and only when the key is set (in the environment or a local .env file).
 *
 *   LANGSMITH_API_KEY    key for a disposable or personal workspace
 *   LANGSMITH_BASE_URL   optional; default https://api.smith.langchain.com
 *
 * Each run writes prompts under a fresh "tas-live-<timestamp>/" prefix; `pnpm cleanup:live` removes them.
 */
try {
  process.loadEnvFile();
} catch {
  // no .env file
}
const { LANGSMITH_API_KEY: apiKey, LANGSMITH_BASE_URL: baseURL } = process.env;

describe.skipIf(process.env.TAS_LIVE !== "1" || !apiKey)("langsmith adapter (live)", { timeout: 120_000 }, () => {
  const registry = langsmith({ apiKey: apiKey!, ...(baseURL ? { baseURL } : {}) }).prompts!;
  conformance(() => registry, { prefix: `tas-live-${Date.now()}/` });
});
