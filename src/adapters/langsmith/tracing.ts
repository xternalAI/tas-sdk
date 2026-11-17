/**
 * The `TraceExporter` for LangSmith: where its OpenTelemetry endpoint is, the headers it wants, and
 * the attribute names its UI reads.
 */
import { asText, commonAttributes, type SpanRecord, type TraceExporter } from "../../trace.ts";
import type { LangSmithContext } from "./context.ts";

/** The same metadata LangChain's own hub client attaches when it pulls a prompt. Only set when LangSmith served the prompt. */
function promptLink(span: SpanRecord): Record<string, unknown> {
  if (span.prompt?.platform !== "langsmith" || !span.prompt.version) return {};
  return {
    "langsmith.metadata.lc_hub_owner": "-",
    "langsmith.metadata.lc_hub_repo": span.prompt.name.replaceAll("/", "--"),
    "langsmith.metadata.lc_hub_commit_hash": span.prompt.version,
  };
}

/** A span's attributes under the names LangSmith reads. */
function attributes(span: SpanRecord): Record<string, unknown> {
  return {
    ...commonAttributes(span),
    "langsmith.span.kind": span.kind === "generation" ? "llm" : span.kind === "tool" ? "tool" : "chain",
    // LangSmith shows a model call as a conversation only when its input is an object holding the messages.
    ...(span.input !== undefined
      ? { "input.value": asText(span.kind === "generation" && Array.isArray(span.input) ? { messages: span.input } : span.input) }
      : {}),
    ...(span.output !== undefined ? { "output.value": asText(span.output) } : {}),
    ...Object.fromEntries(Object.entries(span.metadata ?? {}).map(([k, v]) => [`langsmith.metadata.${k}`, asText(v)])),
    ...Object.fromEntries(Object.entries(span.modelParams ?? {}).map(([k, v]) => [`gen_ai.request.${k}`, v])),
    // LangSmith has no user or session field; these metadata keys are what its threads view reads.
    ...(span.userId ? { "langsmith.metadata.user_id": span.userId } : {}),
    ...(span.sessionId ? { "langsmith.metadata.thread_id": span.sessionId } : {}),
    ...(span.tags?.length ? { "langsmith.span.tags": span.tags.join(",") } : {}),
    ...(span.parentSpanId ? {} : { "langsmith.trace.name": span.name }),
    ...promptLink(span),
  };
}

/** The trace exporter of one adapter instance. Spans go to the tracing project named in the options. */
export function createTracing(ctx: LangSmithContext): TraceExporter {
  return {
    url: `${ctx.origin}/otel/v1/traces`,
    headers: { ...ctx.headers, "Langsmith-Project": ctx.options.project ?? "default" },
    ...(ctx.options.fetch ? { fetch: ctx.options.fetch } : {}),
    attributes,
  };
}
