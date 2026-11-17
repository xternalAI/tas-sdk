/**
 * The Braintrust adapter: the public options, the error class, and the factory that assembles the
 * four capabilities. Each capability lives in its own file and can be read without the others:
 *
 * - `prompts.ts`: how a prompt is stored in Braintrust (the codec) and the `PromptRegistry`.
 * - `tracing.ts`: the `TraceExporter` (OpenTelemetry endpoint, headers, attribute names).
 * - `datasets.ts`: the `DatasetStore`, plus the upsert that experiments reuse.
 * - `experiments.ts`: the `ExperimentReporter`.
 *
 * What they share per adapter instance (HTTP client, project id) is in `context.ts`.
 */
import type { PlatformAdapter } from "../../adapter.ts";
import { PlatformError } from "../shared.ts";
import { createContext } from "./context.ts";
import { createDatasetStore } from "./datasets.ts";
import { createExperimentReporter } from "./experiments.ts";
import { createPromptRegistry } from "./prompts.ts";
import { createTraceExporter } from "./tracing.ts";

export interface BraintrustOptions {
  /** Passed explicitly, never read from the environment: one process may hold many tenants' keys. */
  apiKey: string;
  /** One of these is required. The adapter never creates projects. */
  projectId?: string;
  projectName?: string;
  /** Default https://api.braintrust.dev (EU: https://api-eu.braintrust.dev). */
  baseURL?: string;
  fetch?: typeof fetch;
}

/** Braintrust answered with an error, or holds something this SDK cannot represent. `status` is set for HTTP failures. */
export class BraintrustError extends PlatformError {
  constructor(message: string, status?: number) {
    super("braintrust", message, status);
  }
}

/** A `PlatformAdapter` for one Braintrust project: prompts, tracing, datasets and experiments. */
export function braintrust(options: BraintrustOptions): PlatformAdapter {
  const context = createContext(options, (message, status) => new BraintrustError(message, status));
  return {
    id: "braintrust",
    prompts: createPromptRegistry(context),
    tracing: createTraceExporter(context),
    datasets: createDatasetStore(context),
    experiments: createExperimentReporter(context),
  };
}
