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
  /**
   * Limit the CLI and the studio to prompts and datasets whose names start with one of these, for
   * example "support/". Use it when several applications share one platform project: status, push,
   * pull and migrate then neither show nor touch anything outside it. A scope ending in "/" covers
   * everything under that folder; one without covers that exact name. Runtime calls are not affected.
   */
  scope?: string | string[];
  /**
   * Which platform version each bundled prompt was last synced as: `await loadPromptVersions("./prompts")`.
   * With it, traces of repo-canonical prompts link to the platform's prompt version, as long as the
   * bundled prompt is unchanged since that sync. Costs nothing at runtime: it is the lockfile, read once.
   */
  promptVersions?: PromptVersions;
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

/** The platform versions of synced prompts, as `tas.lock.json` records them for one profile. */
export interface PromptVersions {
  /** The platform these versions belong to. Ignored by a client configured for another platform. */
  platform: string;
  prompts: Record<string, { hash: string; version: string }>;
}

/** Named configs for the CLI (`--profile acme`) and for apps with a fixed set of tenants. */
export interface TasProfiles {
  profiles: Record<string, TasConfig>;
  default: string;
}

/** Identity helper for `tas.config.ts`, so the file gets type-checking and completion. */
/**
 * Pick one config out of a profiles file: the named profile, or its default. A single config is
 * returned as it is. This is how the CLI resolves `--profile`; `createClient(config, name)` uses it too.
 */
export function resolveProfile(config: TasConfig | TasProfiles, name?: string): { config: TasConfig; name: string } {
  if (!("profiles" in config)) {
    if (name !== undefined) throw new Error(`profile "${name}" was asked for, but the config is a single config without profiles`);
    return { config, name: "default" };
  }
  const chosen = name ?? config.default;
  const found = config.profiles[chosen];
  if (!found) throw new Error(`no profile "${chosen}" (have: ${Object.keys(config.profiles).join(", ")})`);
  return { config: found, name: chosen };
}

/** True when `name` is inside `scope`: under one of its folders ("support/") or equal to one of its names. No scope means everything. */
export function inScope(name: string, scope: string | string[] | undefined): boolean {
  if (scope === undefined) return true;
  return [scope].flat().some((entry) => (entry.endsWith("/") ? name.startsWith(entry) : name === entry));
}

export function defineConfig(config: TasConfig): TasConfig;
export function defineConfig(config: TasProfiles): TasProfiles;
export function defineConfig(config: TasConfig | TasProfiles): TasConfig | TasProfiles {
  return config;
}
