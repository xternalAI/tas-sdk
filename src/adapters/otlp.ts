import type { PlatformAdapter } from "../adapter.ts";
import { genericAttributes, type SpanRecord } from "../trace.ts";

/**
 * A tracing-only target for anything that accepts OpenTelemetry over HTTP: an OpenTelemetry
 * Collector, Jaeger, Grafana Tempo, Honeycomb, Datadog's intake, and so on. Spans are sent as
 * OTLP JSON with vendor-neutral attribute names. It stores no prompts, datasets or experiments.
 */
export interface OtlpOptions {
  /** The full traces endpoint, for example "http://localhost:4318/v1/traces". */
  url: string;
  /** Sent with every request, typically authentication. */
  headers?: Record<string, string>;
  /** Replace or extend the attributes written on each span. Receives the default ones. */
  attributes?: (span: SpanRecord, defaults: Record<string, unknown>) => Record<string, unknown>;
  fetch?: typeof fetch;
}

export function otlp(options: OtlpOptions): PlatformAdapter {
  const custom = options.attributes;
  return {
    id: "otlp",
    tracing: {
      url: options.url,
      headers: options.headers ?? {},
      attributes: custom ? (span) => custom(span, genericAttributes(span)) : genericAttributes,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  };
}
