/**
 * The Langfuse adapter: its options, its error class, and the factory that assembles one adapter
 * from the four capabilities. Each capability lives in its own file and can be read on its own:
 *
 * - `prompts.ts`: how a prompt is stored in Langfuse (the codec) and the prompt registry.
 * - `tracing.ts`: where traces go and what the span attributes are called.
 * - `datasets.ts`: datasets and their items.
 * - `experiments.ts`: reporting a finished evaluation run.
 *
 * `context.ts` holds what they share per adapter instance (HTTP client, base URL, auth header).
 */
import type { PlatformAdapter } from "../../adapter.ts";
import { createContext } from "./context.ts";
import { datasetStore } from "./datasets.ts";
import { experimentReporter } from "./experiments.ts";
import { promptRegistry } from "./prompts.ts";
import { traceExporter } from "./tracing.ts";

export { LangfuseError } from "./error.ts";

export interface LangfuseOptions {
  /** Passed explicitly, never read from the environment: one process may hold many tenants' keys. */
  publicKey: string;
  secretKey: string;
  /** Default https://cloud.langfuse.com (US: https://us.cloud.langfuse.com, or your self-hosted URL). */
  baseURL?: string;
  fetch?: typeof fetch;
}

/** A Langfuse adapter for one project, identified by its key pair. */
export function langfuse(options: LangfuseOptions): PlatformAdapter {
  const context = createContext(options);
  const tracing = traceExporter(context);
  return {
    id: "langfuse",
    prompts: promptRegistry(context),
    tracing,
    datasets: datasetStore(context),
    experiments: experimentReporter(context, tracing),
  };
}
