import { isDeepStrictEqual } from "node:util";
import type { PlatformAdapter } from "./adapter.ts";
import { type Dataset, type DatasetItem, itemId } from "./dataset.ts";
import type { Masker } from "./masking.ts";
import type { RunOptions, RunResult } from "./run.ts";
import type { SpanHandle, TraceOptions } from "./trace.ts";

/**
 * Evals: run a task over a dataset, score every output, and report the run as an experiment to
 * whichever platform is configured. The task and the scorers always run here, in your process,
 * so results are the same whichever vendor stores them.
 */

export interface ScorerArgs<Input = unknown, Output = unknown, Expected = unknown> {
  input: Input;
  output: Output;
  expected: Expected | undefined;
  metadata: Record<string, unknown> | undefined;
}
/**
 * A score is a number from 0 to 1 (a boolean counts as 1 or 0), optionally with a comment.
 * Return null or undefined to say "does not apply to this item".
 */
export type ScoreValue = number | boolean | null | undefined | { score: number | boolean; comment?: string };
export type Scorer<Input = any, Output = any, Expected = any> = (
  args: ScorerArgs<Input, Output, Expected>,
) => ScoreValue | Promise<ScoreValue>;

/** 1 when the output deep-equals the expected value. */
export const exactMatch: Scorer = ({ output, expected }) => isDeepStrictEqual(output, expected);

/** 1 when the output, as text, contains the expected value (or the given text). Case-insensitive. */
export const includes =
  (text?: string): Scorer =>
  ({ output, expected }) => {
    const needle = text ?? (typeof expected === "string" ? expected : JSON.stringify(expected));
    const haystack = typeof output === "string" ? output : JSON.stringify(output);
    return needle === undefined ? null : (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
  };

const JUDGE_SCHEMA = {
  type: "object",
  properties: { score: { type: "number", minimum: 0, maximum: 1 }, reason: { type: "string" } },
  required: ["score"],
};
const asVariable = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? null));

/**
 * Score with a model: runs the named prompt with `{{input}}`, `{{output}}` and `{{expected}}`
 * and expects JSON `{ "score": 0..1, "reason": "..." }` back. The judge prompt is an ordinary
 * prompt, so it is versioned, synced and traced like any other.
 */
export function judge(
  client: { run(name: any, options?: any): Promise<RunResult<any>> },
  prompt: string,
  options: Omit<RunOptions, "output" | "variables"> = {},
): Scorer {
  return async ({ input, output, expected }) => {
    const result = await client.run(prompt, {
      ...options,
      variables: { input: asVariable(input), output: asVariable(output), expected: asVariable(expected) },
      output: JUDGE_SCHEMA,
    });
    const verdict = result.output as { score: number; reason?: string };
    return { score: verdict.score, ...(verdict.reason ? { comment: verdict.reason } : {}) };
  };
}

export interface EvalRow {
  id: string;
  input: unknown;
  expected?: unknown;
  metadata?: Record<string, unknown>;
  output?: unknown;
  /** The task threw. Scorers are not run for this row. */
  error?: string;
  scores: Record<string, { score: number; comment?: string }>;
  /** Scorers that threw or returned something outside 0..1, by name. */
  scorerErrors?: Record<string, string>;
  startTime: number;
  endTime: number;
}

export interface ExperimentResult {
  /** The name you gave the evaluation. */
  name: string;
  /** Unique per run: the name plus a timestamp, used as the experiment name on platforms. */
  runName: string;
  dataset: { name: string; description?: string };
  rows: EvalRow[];
  summary: {
    /** Mean of each score over the rows that have it. */
    scores: Record<string, { mean: number; count: number }>;
    /** Rows whose task threw. */
    errors: number;
    durationMs: number;
  };
  metadata?: Record<string, unknown>;
  startTime: number;
  endTime: number;
  /** Thresholds not met, as "name: mean < minimum". Empty when all passed or none were set. */
  failures: string[];
  passed: boolean;
  /** One entry per platform the run was reported to. */
  reports: { platform: string; url?: string; error?: string }[];
}

/** What a platform adapter implements to store a finished run. */
export interface ExperimentReporter {
  report(result: ExperimentResult): Promise<{ url?: string }>;
}

export interface EvaluateOptions<Input = any, Output = any, Expected = any> {
  data: Dataset<Input, Expected> | DatasetItem<Input, Expected>[];
  task: (input: Input, item: DatasetItem<Input, Expected>) => Output | Promise<Output>;
  scorers?: Record<string, Scorer<Input, Output, Expected>>;
  /** Items run at once. Default 5. */
  concurrency?: number;
  /** Minimum mean per score. Any unmet threshold makes `passed` false. */
  thresholds?: Record<string, number>;
  /** Stored with the experiment: model, git commit, anything that identifies this run. */
  metadata?: Record<string, unknown>;
  /** Platforms to report to. Default: the client's `platform`. Pass false to keep the run local. */
  report?: PlatformAdapter[] | false;
}

export interface EvalDefinition<Input = any, Output = any, Expected = any> extends EvaluateOptions<Input, Output, Expected> {
  name: string;
}
/** Identity helper for `*.eval.ts` files run by `tas eval`. */
export function defineEval<Input, Output, Expected>(
  definition: EvalDefinition<Input, Output, Expected>,
): EvalDefinition<Input, Output, Expected> {
  return definition;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface EvalHost {
  platform: PlatformAdapter;
  /** The client's masking. Applied to everything a run reports to a platform; what is returned to you is not masked. */
  mask?: Masker;
  trace<T>(name: string, options: TraceOptions, fn: (span: SpanHandle) => T | Promise<T>): Promise<T>;
}

/** A copy of a run with everything that came from data or from the model masked. Ids, scores and timings are kept. */
function masked(result: ExperimentResult, mask: Masker): ExperimentResult {
  return {
    ...result,
    ...(result.metadata ? { metadata: mask(result.metadata) } : {}),
    rows: result.rows.map((row) => ({
      ...row,
      input: mask(row.input),
      ...(row.expected !== undefined ? { expected: mask(row.expected) } : {}),
      ...(row.metadata ? { metadata: mask(row.metadata) } : {}),
      ...(row.output !== undefined ? { output: mask(row.output) } : {}),
      ...(row.error !== undefined ? { error: mask(row.error) } : {}),
      scores: Object.fromEntries(
        Object.entries(row.scores).map(([name, s]) => [name, { score: s.score, ...(s.comment ? { comment: mask(s.comment) } : {}) }]),
      ),
    })),
  };
}

export async function evaluate(host: EvalHost, name: string, options: EvaluateOptions): Promise<ExperimentResult> {
  const dataset: Dataset = Array.isArray(options.data) ? { name, items: options.data } : options.data;
  const items = dataset.items.map((item) => ({ ...item, id: itemId(item) }));
  const duplicate = items.find((item, i) => items.findIndex((other) => other.id === item.id) !== i);
  if (duplicate)
    throw new Error(
      `dataset "${dataset.name}": two items share the id "${duplicate.id}" (ids default to a hash of the input; give them explicit ids)`,
    );

  const startTime = Date.now();
  const runName = `${name}-${startTime.toString(36)}`;
  const rows: EvalRow[] = new Array(items.length);

  async function runItem(index: number): Promise<void> {
    const item = items[index]!;
    const row: EvalRow = {
      id: item.id,
      input: item.input,
      ...(item.expected !== undefined ? { expected: item.expected } : {}),
      ...(item.metadata ? { metadata: item.metadata } : {}),
      scores: {},
      startTime: Date.now(),
      endTime: 0,
    };
    rows[index] = row;
    try {
      // Each item is its own trace, tagged so eval traffic can be told apart from real traffic.
      row.output = await host.trace(
        `eval ${name}`,
        { input: item.input, tags: ["eval"], metadata: { experiment: runName, item: item.id } },
        () => options.task(item.input, item),
      );
    } catch (error) {
      row.error = message(error); // one bad item does not stop the run
    }
    row.endTime = Date.now();
    if (row.error !== undefined) return;
    for (const [scorerName, scorer] of Object.entries(options.scorers ?? {})) {
      try {
        const raw = await scorer({ input: item.input, output: row.output, expected: item.expected, metadata: item.metadata });
        if (raw === null || raw === undefined) continue;
        const { score, comment } = typeof raw === "object" ? raw : { score: raw, comment: undefined };
        const value = typeof score === "boolean" ? Number(score) : score;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
          throw new Error(`returned ${JSON.stringify(score)}; a score must be between 0 and 1`);
        row.scores[scorerName] = { score: value, ...(comment ? { comment } : {}) };
      } catch (error) {
        (row.scorerErrors ??= {})[scorerName] = message(error);
      }
    }
  }

  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 5, items.length)) }, async () => {
    while (next < items.length) await runItem(next++);
  });
  await Promise.all(workers);
  const endTime = Date.now();

  const scores: Record<string, { mean: number; count: number }> = {};
  for (const scorerName of Object.keys(options.scorers ?? {})) {
    const values = rows.flatMap((row) => (row.scores[scorerName] ? [row.scores[scorerName].score] : []));
    if (values.length) scores[scorerName] = { mean: values.reduce((a, b) => a + b, 0) / values.length, count: values.length };
  }
  const failures = Object.entries(options.thresholds ?? {}).flatMap(([scorerName, minimum]) => {
    const mean = scores[scorerName]?.mean;
    if (mean === undefined) return [`${scorerName}: no scores recorded, needs at least ${minimum}`];
    return mean < minimum ? [`${scorerName}: ${mean.toFixed(3)} < ${minimum}`] : [];
  });

  const result: ExperimentResult = {
    name,
    runName,
    dataset: { name: dataset.name, ...(dataset.description ? { description: dataset.description } : {}) },
    rows,
    summary: { scores, errors: rows.filter((row) => row.error !== undefined).length, durationMs: endTime - startTime },
    ...(options.metadata ? { metadata: options.metadata } : {}),
    startTime,
    endTime,
    failures,
    passed: failures.length === 0,
    reports: [],
  };

  const targets = options.report === false ? [] : (options.report ?? [host.platform]).filter((adapter) => adapter.experiments);
  // Masked once for every platform, like traces: the same redacted run goes to each.
  const reported = targets.length && host.mask ? masked(result, host.mask) : result;
  for (const adapter of targets) {
    try {
      result.reports.push({ platform: adapter.id, ...(await adapter.experiments!.report(reported)) });
    } catch (error) {
      result.reports.push({ platform: adapter.id, error: message(error) }); // the results are still returned to you
    }
  }
  return result;
}
