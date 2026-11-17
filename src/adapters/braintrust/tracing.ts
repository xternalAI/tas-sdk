/**
 * Braintrust tracing: where spans are sent (its OpenTelemetry endpoint), the headers that file
 * them under the right project, and the translation of a span into Braintrust's attribute names.
 */
import { commonAttributes, type SpanRecord, type TraceExporter } from "../../trace.ts";
import type { BraintrustContext } from "./context.ts";

/** The `TraceExporter` for this adapter's project. */
export function createTraceExporter({ options, baseURL }: BraintrustContext): TraceExporter {
  return {
    url: `${baseURL}/otel/v1/traces`,
    // Braintrust files spans under whatever this header names.
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "x-bt-parent": options.projectId ? `project_id:${options.projectId}` : `project_name:${options.projectName}`,
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    attributes: spanAttributes,
  };
}

/** A span as Braintrust's OpenTelemetry attributes. Structured values travel as JSON strings. */
function spanAttributes(span: SpanRecord): Record<string, unknown> {
  return {
    ...commonAttributes(span),
    "braintrust.span_attributes.type": span.kind === "generation" ? "llm" : span.kind === "tool" ? "tool" : "task",
    ...(span.input !== undefined ? { "braintrust.input_json": JSON.stringify(span.input) } : {}),
    ...(span.output !== undefined ? { "braintrust.output_json": JSON.stringify(span.output) } : {}),
    "braintrust.metadata": JSON.stringify(spanMetadata(span)),
    ...(span.usage ? { "braintrust.metrics": JSON.stringify(spanMetrics(span.usage)) } : {}),
    ...(span.tags?.length && !span.parentSpanId ? { "braintrust.tags": span.tags } : {}),
  };
}

/** The metadata object of a span: the user's metadata plus model, model parameters, user, session and prompt link. */
function spanMetadata(span: SpanRecord): Record<string, unknown> {
  return {
    ...span.metadata,
    ...(span.model ? { model: span.model } : {}),
    ...span.modelParams,
    ...(span.userId ? { user_id: span.userId } : {}),
    ...(span.sessionId ? { session_id: span.sessionId } : {}),
    ...(span.prompt ? { prompt: span.prompt } : {}),
  };
}

/** Token usage under Braintrust's metric names. */
function spanMetrics(usage: NonNullable<SpanRecord["usage"]>): Record<string, unknown> {
  return { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, tokens: usage.totalTokens };
}
