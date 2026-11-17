/**
 * The LangSmith adapter: its options, its error class and the factory that assembles the four
 * capabilities. Each capability lives in its own file and can be read without the others:
 *
 *   prompts.ts      prompt registry (repos, commits, commit tags), using
 *     manifest.ts     the codec between a prompt and a LangChain manifest, and
 *     models.ts       the provider table, model-id resolution and model/tools encoding
 *   tracing.ts      trace exporter (OpenTelemetry endpoint and attribute names)
 *   datasets.ts     dataset store (datasets and examples)
 *   experiments.ts  experiment reporter (sessions, runs, feedback)
 *
 * context.ts holds what they share per adapter instance (HTTP client, headers, options) and lc.ts
 * the serialized LangChain object shape.
 *
 * The other files import `LangSmithError` from here while this file imports their factories. That
 * circle is safe because they only use the class inside functions, never while a module loads.
 */
import type { PlatformAdapter } from "../../adapter.ts";
import { createContext } from "./context.ts";
import { createDatasets } from "./datasets.ts";
import { LangSmithError } from "./error.ts";
import { createExperiments } from "./experiments.ts";
import type { LangSmithProvider } from "./models.ts";
import { createPrompts } from "./prompts.ts";
import { createTracing } from "./tracing.ts";

export { LANGSMITH_PROVIDERS, type LangSmithProvider } from "./models.ts";
export { LangSmithError };

export interface LangSmithOptions {
  /** Passed explicitly, never read from the environment: one process may hold many tenants' keys. */
  apiKey: string;
  /** Default https://api.smith.langchain.com (EU: https://eu.api.smith.langchain.com). */
  baseURL?: string;
  /** Needed only when the key can reach more than one workspace. */
  workspaceId?: string;
  /** Tracing project that receives spans. Default "default". */
  project?: string;
  /**
   * Decide which LangSmith provider a model id belongs to, when the built-in rules guess wrong
   * for your gateway's naming. Return undefined to fall back to them.
   */
  resolveModel?: (modelId: string) => { provider: LangSmithProvider; model: string } | undefined;
  fetch?: typeof fetch;
}

/** LangSmith answered with an error, or cannot hold what was asked of it. `status` is set for HTTP failures. */

/** The LangSmith platform adapter: prompts, tracing, datasets and experiments over one set of credentials. */
export function langsmith(options: LangSmithOptions): PlatformAdapter {
  const ctx = createContext(options);
  const datasets = createDatasets(ctx);
  return {
    id: "langsmith",
    prompts: createPrompts(ctx),
    tracing: createTracing(ctx),
    datasets,
    experiments: createExperiments(ctx, datasets),
  };
}
