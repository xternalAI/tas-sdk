import { describe } from "vitest";
import { langfuse } from "../src/index.ts";
import { conformance } from "./conformance.ts";

/**
 * Runs the conformance suite against a real Langfuse project. Opt-in: it only
 * runs via `pnpm test:live`, and only when both keys are set (in the environment or a local .env file).
 *
 *   LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY   keys of a disposable project
 *   LANGFUSE_BASE_URL                          optional; default https://cloud.langfuse.com
 *
 * Each run writes prompts under a fresh "tas-live-<timestamp>/" prefix; `pnpm cleanup:live` removes them.
 */
try {
  process.loadEnvFile();
} catch {
  // no .env file
}
const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: baseURL } = process.env;

describe.skipIf(process.env.TAS_LIVE !== "1" || !publicKey || !secretKey)("langfuse adapter (live)", { timeout: 60_000 }, () => {
  const registry = langfuse({ publicKey: publicKey!, secretKey: secretKey!, ...(baseURL ? { baseURL } : {}) }).prompts!;
  conformance(() => registry, { prefix: `tas-live-${Date.now()}/` });
});
