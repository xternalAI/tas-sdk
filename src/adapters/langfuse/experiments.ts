/**
 * Experiments on Langfuse: storing a finished evaluation run. Langfuse has no "create experiment"
 * call, so a run is written as its dataset, then one trace per item carrying experiment attributes,
 * then the scores on those traces. No URL is returned.
 */
import { randomBytes } from "node:crypto";
import type { EvalRow, ExperimentReporter, ExperimentResult } from "../../eval.ts";
import { asText, type SpanRecord, type TraceExporter, toOtlp } from "../../trace.ts";
import type { Http } from "../shared.ts";
import type { LangfuseContext } from "./context.ts";
import { remoteItemId, upsertDataset } from "./datasets.ts";
import { LangfuseError } from "./error.ts";

/** One trace of a run: the span that is sent and the row it stands for. */
interface RowTrace {
  span: SpanRecord;
  row: EvalRow;
}

/** `tracing` is this adapter's exporter: experiment traces go to the same endpoint with the same span attributes. */
export function experimentReporter({ http }: LangfuseContext, tracing: TraceExporter): ExperimentReporter {
  return {
    async report(result) {
      const datasetId = await upsertDataset(http, { ...result.dataset, items: result.rows.map(toDatasetItem) });

      // Langfuse has no "create experiment" call: a run exists as one trace per item carrying these attributes.
      const experimentId = randomBytes(8).toString("hex");
      const traces = result.rows.map((row): RowTrace => ({ span: rowSpan(result.runName, row), row }));
      await sendTraces(http, tracing, traces, (trace) => experimentAttributes(result, experimentId, datasetId, trace));
      await sendScores(http, experimentId, traces);
      return {};
    },
  };
}

/** The dataset item a row was run on. */
function toDatasetItem({ id, input, expected, metadata }: EvalRow) {
  return { id, input, expected, ...(metadata ? { metadata } : {}) };
}

/** A row as the root span of a trace of its own. */
function rowSpan(runName: string, row: EvalRow): SpanRecord {
  return {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    name: runName,
    kind: "span",
    startTime: row.startTime,
    endTime: row.endTime,
    input: row.input,
    ...(row.output !== undefined ? { output: row.output } : {}),
    metadata: { rowId: row.id },
    ...(row.error ? { error: row.error } : {}),
  };
}

/** The attributes that make Langfuse show a trace as one item of an experiment on a dataset. */
function experimentAttributes(
  result: ExperimentResult,
  experimentId: string,
  datasetId: string,
  { span, row }: RowTrace,
): Record<string, unknown> {
  const metadata = { ...result.metadata, evaluation: result.name };
  return {
    "langfuse.experiment.id": experimentId,
    "langfuse.experiment.name": result.runName,
    "langfuse.experiment.dataset.id": datasetId,
    "langfuse.experiment.item.id": remoteItemId(result.dataset.name, row.id),
    "langfuse.experiment.item.root_observation_id": span.spanId,
    ...(row.expected !== undefined ? { "langfuse.experiment.item.expected_output": JSON.stringify(row.expected) } : {}),
    ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`langfuse.experiment.metadata.${k}`, asText(v)])),
  };
}

/** Send every trace in one OTLP request. Each span gets the exporter's attributes, then `extra`. */
async function sendTraces(
  http: Http,
  tracing: TraceExporter,
  traces: RowTrace[],
  extra: (trace: RowTrace) => Record<string, unknown>,
): Promise<void> {
  const bySpan = new Map(traces.map((trace) => [trace.span.spanId, trace]));
  const body = toOtlp(
    traces.map((trace) => trace.span),
    (span) => ({ ...tracing.attributes(span), ...extra(bySpan.get(span.spanId)!) }),
  );
  const headers = { "content-type": "application/json", ...tracing.headers };
  const sent = await http.fetch(tracing.url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!sent.ok)
    throw new LangfuseError(`langfuse experiment traces rejected: ${sent.status} ${(await sent.text()).slice(0, 200)}`, sent.status);
}

/** Attach each row's scores to its trace, one call per score. */
async function sendScores(http: Http, experimentId: string, traces: RowTrace[]): Promise<void> {
  for (const { span, row } of traces) {
    for (const [name, s] of Object.entries(row.scores)) {
      await http.request("POST", "/scores", {
        body: {
          id: `${experimentId}-${row.id}-${name}`,
          traceId: span.traceId,
          observationId: span.spanId,
          name,
          value: s.score,
          dataType: "NUMERIC",
          ...(s.comment ? { comment: s.comment } : {}),
        },
      });
    }
  }
}
