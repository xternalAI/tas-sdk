import { braintrust, langfuse, langsmith, type PlatformAdapter } from "../src/index.ts";

/**
 * Shared setup for the live tests: the opt-in switch and one adapter per platform that has
 * credentials. Live tests run only via `pnpm test:live` (which sets TAS_LIVE=1), read credentials
 * from the environment or a local .env file, and name everything they create "tas-live-...".
 *
 *   BRAINTRUST_API_KEY + TAS_LIVE_PROJECT     an existing, disposable Braintrust project
 *   LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY (+ LANGFUSE_BASE_URL)
 *   LANGSMITH_API_KEY (+ LANGSMITH_BASE_URL)
 */
try {
  process.loadEnvFile();
} catch {
  // no .env file
}
const e = process.env;

/** True only under `pnpm test:live`. */
export const LIVE = e.TAS_LIVE === "1";

/** The platforms there are credentials for. `langsmithProject` is the tracing project spans go to. */
export function liveTargets(options: { langsmithProject?: string } = {}): PlatformAdapter[] {
  const targets: PlatformAdapter[] = [];
  if (e.BRAINTRUST_API_KEY && e.TAS_LIVE_PROJECT)
    targets.push(braintrust({ apiKey: e.BRAINTRUST_API_KEY, projectName: e.TAS_LIVE_PROJECT }));
  if (e.LANGFUSE_PUBLIC_KEY && e.LANGFUSE_SECRET_KEY) {
    targets.push(
      langfuse({
        publicKey: e.LANGFUSE_PUBLIC_KEY,
        secretKey: e.LANGFUSE_SECRET_KEY,
        ...(e.LANGFUSE_BASE_URL ? { baseURL: e.LANGFUSE_BASE_URL } : {}),
      }),
    );
  }
  if (e.LANGSMITH_API_KEY) {
    targets.push(
      langsmith({
        apiKey: e.LANGSMITH_API_KEY,
        ...(e.LANGSMITH_BASE_URL ? { baseURL: e.LANGSMITH_BASE_URL } : {}),
        ...(options.langsmithProject ? { project: options.langsmithProject } : {}),
      }),
    );
  }
  return targets;
}
