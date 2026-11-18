import type { PlatformAdapter } from "./adapter.ts";
import type { MaskingConfig } from "./masking.ts";
import type { PromptDefinition } from "./prompt/model.ts";
import type { OpenTelemetryApi, TraceExportOptions } from "./trace.ts";

export interface GatewayConfig {
  /** Any OpenAI-compatible endpoint: LiteLLM, Braintrust Gateway, Langfuse AI Gateway, a provider directly. */
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /**
   * Model ids differ between gateways ("gpt-5" here, "openai/gpt-5" there). Map the ids used in
   * your prompts to what this gateway expects, so switching gateway never means editing prompts.
   */
  models?: Record<string, string>;
  /**
   * Extra attempts when the endpoint is unreachable, rate-limits (429) or fails server-side (5xx),
   * with exponential backoff and respect for Retry-After. Default 2; 0 turns retrying off.
   */
  retries?: number;
  /** First wait between attempts; doubles each time. Default 500. */
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

export interface TasConfig {
  /** Where prompts, traces and experiments go. */
  platform: PlatformAdapter;
  /**
   * Which side wins when the repo and the platform disagree.
   * - "repo": local prompt files are the truth; the platform is a mirror. Runtime reads local.
   * - "platform": the platform is the truth; local files are a snapshot used as fallback.
   * Default "repo".
   */
  canonical?: "repo" | "platform";
  /** Label resolved when a call names neither a version nor a label. Default "production". */
  defaultLabel?: string;
  /** Prompts bundled with the app, usually `await loadPrompts("./prompts")`. */
  prompts?: PromptDefinition[];
  /** Where the CLI reads and writes prompt files. Default "./prompts". */
  promptsDir?: string;
  /** Where the CLI reads and writes dataset files. Default "./datasets". */
  datasetsDir?: string;
  gateway?: GatewayConfig;
  masking?: MaskingConfig;
  /**
   * Platforms that receive traces. Default: `platform`. List two to send the same spans to both
   * (for example while trialling a new vendor), or pass false to turn tracing off.
   */
  tracing?: PlatformAdapter[] | false;
  /**
   * Join your application's existing OpenTelemetry tracing. Pass the API module:
   * `import * as api from "@opentelemetry/api"`. Spans from this SDK then nest under your active
   * span, your spans started inside `trace()` or a tool nest under ours, and everything is exported
   * by your OpenTelemetry pipeline (masked first). Independent of `tracing`: set `tracing: false` if
   * your pipeline already delivers to the platform, or you will have each span there twice.
   */
  openTelemetry?: OpenTelemetryApi;
  /**
   * When spans are sent. Default `{ mode: "buffered" }`: in the background, so tracing never adds to
   * your response time. See `ExportMode` for "immediate" and "blocking".
   */
  traceExport?: TraceExportOptions;
  /** Called when a platform cannot be reached or rejects spans. Default: a console warning. */
  onTraceError?: (error: Error) => void;
  /** How long a prompt fetched from the platform is reused. Default 60s. Stale copies serve on fetch failure. */
  cacheTtlMs?: number;
}

/** Named configs for the CLI (`--profile acme`) and for apps with a fixed set of tenants. */
export interface TasProfiles {
  profiles: Record<string, TasConfig>;
  default: string;
}

/** Identity helper for `tas.config.ts`, so the file gets type-checking and completion. */
export function defineConfig<T extends TasConfig | TasProfiles>(config: T): T {
  return config;
}
