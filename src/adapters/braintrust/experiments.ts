/**
 * Braintrust experiments: the `ExperimentReporter`. A finished evaluation run becomes a dataset
 * (rows upserted by id) and a new experiment whose rows link back to that dataset.
 */
import type { DatasetItem } from "../../dataset.ts";
import type { EvalRow, ExperimentReporter, ExperimentResult } from "../../eval.ts";
import type { BraintrustContext } from "./context.ts";
import { upsertDataset } from "./datasets.ts";

/** The `ExperimentReporter` for this adapter's project. */
export function createExperimentReporter(context: BraintrustContext): ExperimentReporter {
  return { report: (result) => reportExperiment(context, result) };
}

/** Store the run's dataset and rows, then ask Braintrust for the experiment's URL. */
async function reportExperiment(context: BraintrustContext, result: ExperimentResult): Promise<{ url?: string }> {
  const { http } = context;
  const project_id = await context.projectId();
  const datasetId = await upsertDataset(context, { ...result.dataset, items: result.rows.map(toDatasetItem) });
  const experiment = await http.expect<{ id: string }>("POST", "/v1/experiment", {
    body: {
      project_id,
      name: result.runName,
      dataset_id: datasetId,
      metadata: { ...result.metadata, evaluation: result.name },
      ensure_new: true,
    },
  });
  await http.request("POST", `/v1/experiment/${experiment.id}/insert`, {
    body: { events: result.rows.map((row) => toExperimentEvent(row, datasetId)) },
  });
  const summary = await http.expect<{ experiment_url?: string }>("GET", `/v1/experiment/${experiment.id}/summarize`);
  return summary.experiment_url ? { url: summary.experiment_url } : {};
}

/** The part of an evaluated row that belongs in the dataset. */
function toDatasetItem({ id, input, expected, metadata }: EvalRow): DatasetItem {
  return { id, input, expected, ...(metadata ? { metadata } : {}) };
}

/**
 * An evaluated row as a Braintrust experiment event. Braintrust scores are plain numbers, so score
 * comments and scorer errors go in the row's metadata. `origin` links the row to its dataset row.
 */
function toExperimentEvent(row: EvalRow, datasetId: string): Record<string, unknown> {
  const comments = Object.fromEntries(Object.entries(row.scores).flatMap(([name, s]) => (s.comment ? [[name, s.comment]] : [])));
  return {
    input: row.input,
    output: row.output,
    expected: row.expected,
    scores: Object.fromEntries(Object.entries(row.scores).map(([name, s]) => [name, s.score])),
    ...(row.error ? { error: row.error } : {}),
    metadata: {
      ...row.metadata,
      ...(Object.keys(comments).length ? { score_comments: comments } : {}),
      ...(row.scorerErrors ? { scorer_errors: row.scorerErrors } : {}),
    },
    metrics: { start: row.startTime / 1000, end: row.endTime / 1000 },
    origin: { object_type: "dataset", object_id: datasetId, id: row.id },
  };
}
