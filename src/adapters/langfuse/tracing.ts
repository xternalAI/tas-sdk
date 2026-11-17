/**
 * Tracing on Langfuse: where its OpenTelemetry endpoint is, which headers it needs, and how a span
 * is translated into Langfuse's attribute names.
 */
import { asText, commonAttributes, type SpanRecord, type TraceExporter } from "../../trace.ts";
import type { LangfuseContext } from "./context.ts";

/** The exporter the tracer sends spans through. Experiments reuse it to send their traces. */
export function traceExporter(context: LangfuseContext): TraceExporter {
  return {
    url: `${context.baseURL}/otel/v1/traces`,
    // Without the version header Langfuse holds spans back for several minutes.
    headers: { authorization: context.authorization, "x-langfuse-ingestion-version": "4" },
    ...(context.fetch ? { fetch: context.fetch } : {}),
    attributes: spanAttributes,
  };
}

/** A span under Langfuse's attribute names: the common ones, the observation itself, then what belongs to its trace. */
function spanAttributes(span: SpanRecord): Record<string, unknown> {
  return {
    ...commonAttributes(span),
    "langfuse.observation.type": span.kind,
    ...(span.input !== undefined ? { "langfuse.observation.input": asText(span.input) } : {}),
    ...(span.output !== undefined ? { "langfuse.observation.output": asText(span.output) } : {}),
    ...(span.model ? { "langfuse.observation.model.name": span.model } : {}),
    ...(span.modelParams ? { "langfuse.observation.model.parameters": JSON.stringify(span.modelParams) } : {}),
    ...(span.usage ? { "langfuse.observation.usage_details": usageDetails(span.usage) } : {}),
    ...Object.fromEntries(Object.entries(span.metadata ?? {}).map(([k, v]) => [`langfuse.observation.metadata.${k}`, asText(v)])),
    ...(span.userId ? { "langfuse.user.id": span.userId } : {}),
    ...(span.sessionId ? { "langfuse.session.id": span.sessionId } : {}),
    ...(span.tags?.length ? { "langfuse.trace.tags": span.tags } : {}),
    ...(span.parentSpanId ? {} : { "langfuse.trace.name": span.name }),
    ...(span.error ? { "langfuse.observation.level": "ERROR", "langfuse.observation.status_message": span.error } : {}),
    // Langfuse links a generation to a prompt by its own integer version, so only for prompts it served.
    ...(span.prompt?.platform === "langfuse" && span.prompt.version
      ? { "langfuse.observation.prompt.name": span.prompt.name, "langfuse.observation.prompt.version": Number(span.prompt.version) }
      : {}),
  };
}

/** Token counts under the names Langfuse uses, as the JSON text the attribute holds. */
function usageDetails(usage: NonNullable<SpanRecord["usage"]>): string {
  return JSON.stringify({ input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens });
}
