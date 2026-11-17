/**
 * The `ExperimentReporter` for LangSmith: stores a finished evaluation run as an experiment, the
 * way LangSmith's own SDK records one.
 */
import { randomUUID } from "node:crypto";
import type { DatasetStore } from "../../dataset.ts";
import type { EvalRow, ExperimentReporter, ExperimentResult } from "../../eval.ts";
import type { LangSmithContext } from "./context.ts";
import { asObject, exampleId, findDataset } from "./datasets.ts";
import { LangSmithError } from "./index.ts";

const iso = (ms: number) => new Date(ms).toISOString();

/** Create the experiment: a session bound to the dataset. Returns its id. */
async function createSession(ctx: LangSmithContext, result: ExperimentResult, datasetId: string): Promise<string> {
  const session = await ctx.http.find<{ id: string }>("POST", "/sessions", {
    body: {
      name: result.runName,
      reference_dataset_id: datasetId,
      start_time: iso(result.startTime),
      extra: { metadata: { ...result.metadata, evaluation: result.name } },
    },
  });
  if (!session) throw new LangSmithError("langsmith: could not create the experiment");
  return session.id;
}

/** Record one row: a run bound to the row's example, then feedback for each of its scores. */
async function reportRow(ctx: LangSmithContext, result: ExperimentResult, sessionId: string, row: EvalRow): Promise<void> {
  const runId = randomUUID();
  // LangSmith orders runs by this: the start time to the microsecond, then the run id.
  const dottedOrder = `${iso(row.startTime).replace(/[-:.]/g, "").replace("Z", "000Z")}${runId}`;
  await ctx.http.find("POST", "/runs", {
    body: {
      id: runId,
      trace_id: runId,
      dotted_order: dottedOrder,
      name: result.name,
      run_type: "chain",
      session_id: sessionId,
      reference_example_id: exampleId(result.dataset.name, row.id),
      inputs: asObject(row.input, "input"),
      ...(row.error ? { error: row.error } : { outputs: asObject(row.output, "output") }),
      start_time: iso(row.startTime),
      end_time: iso(Math.max(row.endTime, row.startTime + 1)), // a run must end after it starts
      extra: { metadata: { ...row.metadata, item: row.id } },
    },
  });
  for (const [key, score] of Object.entries(row.scores)) {
    await ctx.http.find("POST", "/feedback", {
      body: { run_id: runId, trace_id: runId, key, score: score.score, ...(score.comment ? { comment: score.comment } : {}) },
    });
  }
}

async function report(ctx: LangSmithContext, datasets: DatasetStore, result: ExperimentResult): Promise<{ url?: string }> {
  // LangSmith's one-call experiment upload only accepts datasets it created itself, which could then
  // not be pushed to or edited like any other. So the dataset is an ordinary one, and the experiment
  // is recorded the way LangSmith's own SDK does it: a session bound to the dataset, one run per row
  // bound to its example, and feedback for each score.
  const items = result.rows.map(({ id, input, expected, metadata }) => ({ id, input, expected, ...(metadata ? { metadata } : {}) }));
  await datasets.push({ ...result.dataset, items });
  const dataset = (await findDataset(ctx, result.dataset.name))!;
  const sessionId = await createSession(ctx, result, dataset.id);
  for (const row of result.rows) await reportRow(ctx, result, sessionId, row);
  await ctx.http.find("PATCH", `/sessions/${sessionId}`, { body: { end_time: iso(Math.max(result.endTime, result.startTime + 1)) } });
  return {};
}

/** The experiment reporter of one adapter instance. `datasets` is the same instance's store: a report pushes the rows to it first. */
export function createExperiments(ctx: LangSmithContext, datasets: DatasetStore): ExperimentReporter {
  return { report: (result) => report(ctx, datasets, result) };
}
