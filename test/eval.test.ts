/**
 * Evals: datasets, scorers, the runner and experiment reporting. Also pins the eval decisions in
 * docs/decisions.md: scores are 0..1, one failing item or scorer never stops a run, reporting
 * failures never lose results, and item ids default to a hash of the input.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  braintrust,
  createClient,
  type ExperimentResult,
  exactMatch,
  includes,
  judge,
  langfuse,
  langsmith,
  loadDataset,
  memory,
  type PlatformAdapter,
  type SpanRecord,
} from "../src/index.ts";
import { cli, SDK } from "./cli.ts";

const capitals = [
  { id: "lv", input: { country: "Latvia" }, expected: "Riga" },
  { id: "ee", input: { country: "Estonia" }, expected: "Tallinn" },
  { id: "lt", input: { country: "Lithuania" }, expected: "Vilnius" },
];
const answers: Record<string, string> = { Latvia: "Riga", Estonia: "Tallinn", Lithuania: "Kaunas" };
const task = (input: { country: string }) => answers[input.country]!;

/** A platform that records the experiments reported to it. */
function recorder(id = "recorder", fail = false) {
  const reported: ExperimentResult[] = [];
  const adapter: PlatformAdapter = {
    id,
    experiments: {
      async report(result) {
        if (fail) throw new Error("platform unavailable");
        reported.push(structuredClone(result));
        return { url: `https://${id}.test/experiments/${result.runName}` };
      },
    },
  };
  return { adapter, reported };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tas-eval-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("datasets", () => {
  it("loads a .dataset.jsonl file, naming the dataset after the file", async () => {
    const path = join(dir, "capitals.dataset.jsonl");
    await writeFile(path, `${capitals.map((c) => JSON.stringify(c)).join("\n")}\n\n{"input":"no id or expected"}\n`);
    const dataset = await loadDataset(path);
    expect(dataset.name).toBe("capitals");
    expect(dataset.items).toEqual([...capitals, { input: "no id or expected" }]);
  });

  it("points at the line that is wrong", async () => {
    const path = join(dir, "bad.dataset.jsonl");
    await writeFile(path, '{"input":1}\nnot json\n');
    await expect(loadDataset(path)).rejects.toThrow(/bad\.dataset\.jsonl:2: not valid JSON/);
    await writeFile(path, '{"input":1}\n{"expected":2}\n');
    await expect(loadDataset(path)).rejects.toThrow(/:2: each line needs an "input"/);
    await writeFile(path, '{"input":1,"expectd":2}\n');
    await expect(loadDataset(path)).rejects.toThrow(/:1: unknown key "expectd"/);
  });
});

describe("evaluate", () => {
  it("runs the task over every item, scores it, summarises and reports to the platform", async () => {
    const platform = recorder();
    const client = createClient({ platform: platform.adapter });
    const result = await client.evaluate("capitals", {
      data: { name: "baltic-capitals", description: "Three capitals", items: capitals },
      task,
      scorers: {
        exact: exactMatch,
        startsRight: ({ output, expected }) => ({ score: output[0] === expected![0], comment: "first letter" }),
      },
      metadata: { model: "gpt-5" },
    });

    expect(result.rows.map((r) => [r.id, r.output, r.scores.exact!.score])).toEqual([
      ["lv", "Riga", 1],
      ["ee", "Tallinn", 1],
      ["lt", "Kaunas", 0],
    ]);
    expect(result.rows[2]!.scores.startsRight).toEqual({ score: 0, comment: "first letter" });
    expect(result.summary.scores.exact).toEqual({ mean: 2 / 3, count: 3 });
    expect(result).toMatchObject({
      name: "capitals",
      dataset: { name: "baltic-capitals", description: "Three capitals" },
      metadata: { model: "gpt-5" },
      passed: true,
      failures: [],
      summary: { errors: 0 },
    });
    expect(result.runName).toMatch(/^capitals-[0-9a-z]+$/);
    expect(result.reports).toEqual([{ platform: "recorder", url: `https://recorder.test/experiments/${result.runName}` }]);
    expect(platform.reported[0]!.rows).toHaveLength(3);
  });

  it("accepts a bare list of items, naming the dataset after the evaluation", async () => {
    const result = await createClient({ platform: memory() }).evaluate("quick", {
      data: [{ input: 1 }, { input: 2 }],
      task: (n: number) => n * 2,
    });
    expect(result.dataset.name).toBe("quick");
    expect(result.rows.map((r) => r.output)).toEqual([2, 4]);
    expect(result.summary.scores).toEqual({});
    expect(result.reports).toEqual([]); // the in-memory platform stores no experiments
  });

  it("runs at most `concurrency` items at once, and keeps rows in dataset order", async () => {
    let running = 0,
      peak = 0;
    const result = await createClient({ platform: memory() }).evaluate("slow", {
      data: Array.from({ length: 9 }, (_, i) => ({ input: i })),
      concurrency: 3,
      task: async (n: number) => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 10 - n));
        running--;
        return n;
      },
    });
    expect(peak).toBe(3);
    expect(result.rows.map((r) => r.output)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("thresholds decide `passed`, including when a score was never recorded", async () => {
    const client = createClient({ platform: memory() });
    const run = (thresholds: Record<string, number>) =>
      client.evaluate("capitals", { data: capitals, task, scorers: { exact: exactMatch }, thresholds });
    expect(await run({ exact: 0.6 })).toMatchObject({ passed: true, failures: [] });
    expect(await run({ exact: 0.9 })).toMatchObject({ passed: false, failures: ["exact: 0.667 < 0.9"] });
    expect(await run({ fluency: 0.5 })).toMatchObject({ passed: false, failures: ["fluency: no scores recorded, needs at least 0.5"] });
  });

  it("traces each item, tagged as eval traffic", async () => {
    const spans: SpanRecord[] = [];
    const tracing: PlatformAdapter = {
      id: "t",
      tracing: {
        url: "https://t.test",
        headers: {},
        attributes: (s) => (spans.push(s), {}),
        fetch: (async () => new Response("{}")) as typeof fetch,
      },
    };
    const client = createClient({ platform: memory(), tracing: [tracing] });
    const result = await client.evaluate("capitals", { data: capitals, task });
    await client.flush();
    expect(spans.map((s) => [s.name, s.tags, s.metadata, s.output])).toEqual(
      capitals.map((c) => ["eval capitals", ["eval"], { experiment: result.runName, item: c.id }, answers[c.input.country]]),
    );
  });
});

describe("decisions: evals", () => {
  const client = () => createClient({ platform: memory() });

  it("a score is a number from 0 to 1: booleans count as 1 or 0, null means not applicable", async () => {
    const result = await client().evaluate("s", {
      data: [{ input: "x" }],
      task: () => "out",
      scorers: {
        yes: () => true,
        no: () => false,
        half: () => 0.5,
        skipped: () => null,
        alsoSkipped: () => undefined,
        withComment: () => ({ score: true, comment: "ok" }),
      },
    });
    expect(result.rows[0]!.scores).toEqual({
      yes: { score: 1 },
      no: { score: 0 },
      half: { score: 0.5 },
      withComment: { score: 1, comment: "ok" },
    });
    expect(Object.keys(result.summary.scores)).toEqual(["yes", "no", "half", "withComment"]);
  });

  it.each([[5], [-0.1], [Number.NaN], ["high"]])("a score of %j is an error for that scorer, not a result", async (bad) => {
    const result = await client().evaluate("s", {
      data: [{ input: "x" }],
      task: () => "out",
      scorers: { bad: () => bad as number, good: () => 1 },
    });
    expect(result.rows[0]!.scores).toEqual({ good: { score: 1 } });
    expect(result.rows[0]!.scorerErrors!.bad).toMatch(/a score must be between 0 and 1/);
    expect(result.summary.scores.bad).toBeUndefined();
  });

  it("a task that throws marks that item as errored and skips its scorers; the run continues", async () => {
    let scored = 0;
    const result = await client().evaluate("s", {
      data: [{ input: 1 }, { input: 2 }, { input: 3 }],
      task: (n: number) => {
        if (n === 2) throw new Error("model timeout");
        return n;
      },
      scorers: { any: () => (scored++, 1) },
    });
    expect(result.rows.map((r) => [r.output, r.error])).toEqual([
      [1, undefined],
      [undefined, "model timeout"],
      [3, undefined],
    ]);
    expect(result.rows[1]!.scores).toEqual({});
    expect(scored).toBe(2);
    expect(result.summary).toMatchObject({ errors: 1, scores: { any: { mean: 1, count: 2 } } });
    expect(result.passed).toBe(true); // errors are reported, but only thresholds fail a run
  });

  it("a scorer that throws loses only its own score for that item", async () => {
    const result = await client().evaluate("s", {
      data: [{ input: 1 }],
      task: () => "out",
      scorers: {
        broken: () => {
          throw new Error("judge down");
        },
        fine: () => 1,
      },
    });
    expect(result.rows[0]).toMatchObject({ scores: { fine: { score: 1 } }, scorerErrors: { broken: "judge down" } });
  });

  it("item ids default to a hash of the input, so they are stable across runs; duplicates are refused", async () => {
    const run = () => client().evaluate("s", { data: [{ input: { q: "a" } }, { input: { q: "b" } }], task: () => 1 });
    const [first, second] = [await run(), await run()];
    expect(first.rows.map((r) => r.id)).toEqual(second.rows.map((r) => r.id));
    expect(first.rows[0]!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(first.rows[0]!.id).not.toBe(first.rows[1]!.id);
    await expect(client().evaluate("s", { data: [{ input: "same" }, { input: "same" }], task: () => 1 })).rejects.toThrow(
      /two items share the id/,
    );
  });

  it("every run gets a unique name, so re-running never overwrites an earlier experiment", async () => {
    const a = await client().evaluate("s", { data: [{ input: 1 }], task: () => 1 });
    await new Promise((r) => setTimeout(r, 2));
    const b = await client().evaluate("s", { data: [{ input: 1 }], task: () => 1 });
    expect(a.runName).not.toBe(b.runName);
  });

  it("a platform that cannot store the experiment does not lose the results", async () => {
    const down = recorder("down", true),
      up = recorder("up");
    const result = await createClient({ platform: memory() }).evaluate("capitals", {
      data: capitals,
      task,
      scorers: { exact: exactMatch },
      report: [down.adapter, up.adapter],
    });
    expect(result.rows).toHaveLength(3);
    expect(result.reports).toEqual([
      { platform: "down", error: "platform unavailable" },
      { platform: "up", url: expect.any(String) },
    ]);
  });

  it("`report: false` keeps a run local", async () => {
    const platform = recorder();
    const result = await createClient({ platform: platform.adapter }).evaluate("s", { data: [{ input: 1 }], task: () => 1, report: false });
    expect(result.reports).toEqual([]);
    expect(platform.reported).toEqual([]);
  });
});

describe("scorers", () => {
  it("exactMatch compares deeply; includes ignores case and falls back to the expected value", () => {
    const args = (output: unknown, expected?: unknown) => ({ input: null, output, expected, metadata: undefined });
    expect(exactMatch(args({ a: [1, 2] }, { a: [1, 2] }))).toBe(true);
    expect(exactMatch(args({ a: [1, 2] }, { a: [2, 1] }))).toBe(false);
    expect(includes()(args("The capital is RIGA.", "Riga"))).toBe(true);
    expect(includes("vilnius")(args("The capital is Riga."))).toBe(false);
    expect(includes()(args({ city: "Riga" }, "riga"))).toBe(true);
    expect(includes()(args("anything"))).toBeNull(); // nothing to look for: not applicable
  });

  it("judge runs a prompt with input, output and expected, and uses its score and reason", async () => {
    let sent: any;
    const gateway = {
      baseURL: "https://gw.test/v1",
      fetch: (async (_u: unknown, init?: RequestInit) => (
        (sent = JSON.parse(String(init!.body))),
        new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"score":0.75,"reason":"mostly right"}' } }] }))
      )) as typeof fetch,
    };
    const client = createClient({
      platform: memory(),
      gateway,
      prompts: [
        {
          type: "chat",
          name: "judges/correctness",
          model: { id: "gpt-5" },
          messages: [{ role: "user", content: "Q: {{input}}\nA: {{output}}\nExpected: {{expected}}" }],
        },
      ],
    });
    const result = await client.evaluate("judged", {
      data: [{ input: { q: "capital?" }, expected: "Riga" }],
      task: () => "Riga, I think",
      scorers: { correct: judge(client, "judges/correctness") },
    });
    expect(result.rows[0]!.scores.correct).toEqual({ score: 0.75, comment: "mostly right" });
    expect(sent.messages[0].content).toBe('Q: {"q":"capital?"}\nA: Riga, I think\nExpected: Riga');
    expect(sent.response_format.json_schema.schema.properties.score).toEqual({ type: "number", minimum: 0, maximum: 1 });
  });
});

describe("experiment reporting", () => {
  /** A fetch that answers every call with `reply(url)` and records what it was sent. */
  function recording(reply: (path: string, method: string) => unknown) {
    const calls: { method: string; path: string; body: any }[] = [];
    const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? "GET";
      calls.push({ method, path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(reply(u.pathname, method) ?? {}));
    }) as typeof fetch;
    return { fetch: fetchImpl, calls };
  }
  const run = (adapter: PlatformAdapter) =>
    createClient({ platform: adapter, tracing: false }).evaluate("capitals", {
      data: { name: "baltic-capitals", items: [...capitals.slice(0, 2), { id: "err", input: { country: "Atlantis" }, expected: "?" }] },
      task: (input: { country: string }) => {
        if (!answers[input.country]) throw new Error("unknown country");
        return answers[input.country]!;
      },
      scorers: { exact: ({ output, expected }) => ({ score: output === expected, comment: "compared" }) },
      metadata: { model: "gpt-5" },
    });

  it("Braintrust: dataset rows upserted by id, then an experiment linked to them", async () => {
    const http = recording((path) =>
      path === "/v1/project"
        ? { objects: [{ id: "proj-1" }] }
        : path === "/v1/dataset"
          ? { id: "ds-1" }
          : path === "/v1/experiment"
            ? { id: "exp-1" }
            : path.endsWith("/summarize")
              ? { experiment_url: "https://bt.test/exp-1" }
              : {},
    );
    const result = await run(braintrust({ apiKey: "k", projectName: "demo", fetch: http.fetch }));
    expect(result.reports).toEqual([{ platform: "braintrust", url: "https://bt.test/exp-1" }]);
    expect(http.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([
      "GET /v1/project",
      "POST /v1/dataset",
      "POST /v1/dataset/ds-1/insert",
      "POST /v1/experiment",
      "POST /v1/experiment/exp-1/insert",
      "GET /v1/experiment/exp-1/summarize",
    ]);
    expect(http.calls[1]!.body).toEqual({ project_id: "proj-1", name: "baltic-capitals" });
    expect(http.calls[2]!.body.events[0]).toEqual({ id: "lv", input: { country: "Latvia" }, expected: "Riga" });
    expect(http.calls[3]!.body).toEqual({
      project_id: "proj-1",
      name: result.runName,
      dataset_id: "ds-1",
      metadata: { model: "gpt-5", evaluation: "capitals" },
      ensure_new: true,
    });
    const [ok, , errored] = http.calls[4]!.body.events;
    expect(ok).toMatchObject({
      input: { country: "Latvia" },
      output: "Riga",
      expected: "Riga",
      scores: { exact: 1 },
      metadata: { score_comments: { exact: "compared" } },
      origin: { object_type: "dataset", object_id: "ds-1", id: "lv" },
    });
    expect(ok.metrics.end).toBeGreaterThanOrEqual(ok.metrics.start);
    expect(errored).toMatchObject({ error: "unknown country", scores: {} });
  });

  it("Langfuse: dataset and items, one experiment trace per item, then scores on those traces", async () => {
    const http = recording((path) => (path.endsWith("/v2/datasets") ? { id: "ds-1" } : { id: "x" }));
    const result = await run(langfuse({ publicKey: "pk", secretKey: "sk", fetch: http.fetch }));
    expect(result.reports).toEqual([{ platform: "langfuse" }]);
    const paths = http.calls.map((c) => c.path.replace("/api/public", ""));
    expect(paths).toEqual(["/v2/datasets", "/dataset-items", "/dataset-items", "/dataset-items", "/otel/v1/traces", "/scores", "/scores"]);
    expect(http.calls[1]!.body).toEqual({
      datasetName: "baltic-capitals",
      id: "baltic-capitals--lv",
      input: { country: "Latvia" },
      expectedOutput: "Riga",
    });
    const spans = http.calls[4]!.body.resourceSpans[0].scopeSpans[0].spans;
    const attrs = (s: any) => Object.fromEntries(s.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
    const first = attrs(spans[0]);
    expect(spans).toHaveLength(3);
    expect(first).toMatchObject({
      "langfuse.experiment.name": result.runName,
      "langfuse.experiment.dataset.id": "ds-1",
      "langfuse.experiment.item.id": "baltic-capitals--lv",
      "langfuse.experiment.item.root_observation_id": spans[0].spanId,
      "langfuse.experiment.item.expected_output": '"Riga"',
      "langfuse.experiment.metadata.model": "gpt-5",
      "langfuse.observation.output": "Riga",
    });
    expect(new Set(spans.map((s: any) => attrs(s)["langfuse.experiment.id"])).size).toBe(1);
    expect(spans[2].status).toEqual({ code: 2, message: "unknown country" });
    expect(http.calls[5]!.body).toMatchObject({
      traceId: spans[0].traceId,
      observationId: spans[0].spanId,
      name: "exact",
      value: 1,
      dataType: "NUMERIC",
      comment: "compared",
    });
  });

  it("LangSmith: an ordinary dataset, a session bound to it, one run per row bound to its example, feedback per score", async () => {
    const created: any[] = [];
    const http = recording((path, method) => {
      if (path === "/api/v1/datasets" && method === "GET") return created.length ? [{ id: "ds-1", name: "baltic-capitals" }] : [];
      if (path === "/api/v1/datasets" && method === "POST") return (created.push(1), {});
      if (path === "/api/v1/examples") return created.length > 1 ? created.slice(1) : [];
      if (path === "/api/v1/sessions") return { id: "session-1" };
      return {};
    });
    const adapter = langsmith({ apiKey: "k", fetch: http.fetch });
    const first = await run(adapter);
    const calls = http.calls.splice(0);
    created.push(...calls.find((c) => c.path === "/api/v1/examples/bulk")!.body);
    await run(adapter);

    expect(first.reports).toEqual([{ platform: "langsmith" }]);
    const sequence = (list: typeof calls) => list.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    expect(sequence(calls)).toEqual([
      "GET /api/v1/datasets",
      "POST /api/v1/datasets",
      "GET /api/v1/datasets",
      "GET /api/v1/examples",
      "POST /api/v1/examples/bulk",
      "GET /api/v1/datasets",
      "POST /api/v1/sessions",
      "POST /api/v1/runs",
      "POST /api/v1/feedback",
      "POST /api/v1/runs",
      "POST /api/v1/feedback",
      "POST /api/v1/runs",
      "PATCH /api/v1/sessions/session-1",
    ]);
    const examples = calls[4]!.body;
    // Inputs and outputs must be objects in LangSmith: other values are wrapped, and the wrapping is remembered.
    expect(examples[0]).toMatchObject({
      dataset_id: "ds-1",
      inputs: { country: "Latvia" },
      outputs: { output: "Riga" },
      metadata: { __tas: { id: "lv", wrapped: ["output"] } },
    });
    expect(examples[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(calls[6]!.body).toMatchObject({
      name: first.runName,
      reference_dataset_id: "ds-1",
      extra: { metadata: { model: "gpt-5", evaluation: "capitals" } },
    });

    const [okRun, feedback] = [calls[7]!.body, calls[8]!.body];
    expect(okRun).toMatchObject({
      name: "capitals",
      run_type: "chain",
      session_id: "session-1",
      reference_example_id: examples[0].id,
      inputs: { country: "Latvia" },
      outputs: { output: "Riga" },
      extra: { metadata: { item: "lv" } },
    });
    expect(okRun.trace_id).toBe(okRun.id);
    expect(okRun.dotted_order).toMatch(new RegExp(`^\\d{8}T\\d{12}Z${okRun.id}$`));
    expect(new Date(okRun.end_time).getTime()).toBeGreaterThan(new Date(okRun.start_time).getTime()); // an instant task still ends after it starts
    expect(feedback).toEqual({ run_id: okRun.id, trace_id: okRun.id, key: "exact", score: 1, comment: "compared" });
    const errored = calls[11]!.body;
    expect(errored).toMatchObject({ error: "unknown country" });
    expect(errored.outputs).toBeUndefined();

    // A re-run updates the same examples instead of creating new ones.
    expect(sequence(http.calls).slice(0, 3)).toEqual(["GET /api/v1/datasets", "GET /api/v1/examples", "PATCH /api/v1/examples/bulk"]);
    expect(http.calls[2]!.body.map((e: any) => e.id)).toEqual(examples.map((e: any) => e.id));
  });
});

describe("tas eval", () => {
  const run = (args: string[]) => cli(args, dir);

  it("runs eval files against the configured client and exits 1 when a threshold is missed", async () => {
    await writeFile(
      join(dir, "tas.config.ts"),
      `import { defineConfig, memory } from ${SDK};\nexport default defineConfig({ platform: memory() });\n`,
    );
    await writeFile(join(dir, "data.dataset.jsonl"), '{"input":2,"expected":4}\n{"input":3,"expected":9}\n');
    const evalFile = (threshold: number) =>
      `import { defineEval, exactMatch, loadDataset } from ${SDK};\n` +
      `export default async (tas) => [defineEval({ name: "squares", data: await loadDataset(${JSON.stringify(join(dir, "data.dataset.jsonl"))}), task: (n) => (n === 3 ? 10 : n * n), scorers: { exact: exactMatch }, thresholds: { exact: ${threshold} } })];\n`;

    await writeFile(join(dir, "ok.eval.ts"), evalFile(0.5));
    expect(await run(["eval", "ok.eval.ts"])).toEqual({ code: 0, out: "pass  squares  2 items  exact 0.500\n" });
    await writeFile(join(dir, "strict.eval.ts"), evalFile(0.9));
    expect(await run(["eval", "strict.eval.ts"])).toEqual({
      code: 1,
      out: "FAIL  squares  2 items  exact 0.500\n      below threshold: exact: 0.500 < 0.9\n",
    });
    expect((await run(["eval"])).out).toMatch(/eval needs at least one file/);
  });
});

describe("decisions: an experiment is masked like a trace", () => {
  it("masks inputs, expected values, outputs, metadata, errors and comments in what is reported; your own result is untouched", async () => {
    const reported: ExperimentResult[] = [];
    const platform = { id: "spy", experiments: { report: async (result: ExperimentResult) => (reported.push(result), {}) } };
    const client = createClient({
      platform,
      tracing: false,
      masking: { keys: ["secret"], patterns: [/[a-z]+@[a-z.]+/g] },
    });
    const result = await client.evaluate<unknown, unknown, unknown>("masked", {
      data: [
        {
          id: "a",
          input: { body: "mail ann@example.com", secret: "x" },
          expected: "ann@example.com",
          metadata: { owner: "bob@example.com" },
        },
        { id: "b", input: "boom" },
      ],
      task: (input) => {
        if (input === "boom") throw new Error("failed for cat@example.com");
        return { reply: "to ann@example.com" };
      },
      scorers: { judge: () => ({ score: 1, comment: "mentions ann@example.com" }) },
      metadata: { runBy: "dev@example.com" },
    });

    expect(reported).toHaveLength(1);
    const sent = reported[0]!;
    expect(sent.metadata).toEqual({ runBy: "[REDACTED]" });
    expect(sent.rows[0]).toMatchObject({
      id: "a",
      input: { body: "mail [REDACTED]", secret: "[REDACTED]" },
      expected: "[REDACTED]",
      metadata: { owner: "[REDACTED]" },
      output: { reply: "to [REDACTED]" },
      scores: { judge: { score: 1, comment: "mentions [REDACTED]" } },
    });
    expect(sent.rows[1]).toMatchObject({ id: "b", input: "boom", error: "failed for [REDACTED]" });
    expect(JSON.stringify(sent)).not.toContain("example.com");
    // Scores, ids and the summary are what they were.
    expect(sent.summary).toEqual(result.summary);

    // What comes back to the caller is the real data.
    expect(result.rows[0]).toMatchObject({ input: { body: "mail ann@example.com", secret: "x" }, output: { reply: "to ann@example.com" } });
    expect(result.rows[1]!.error).toBe("failed for cat@example.com");
  });

  it("without masking rules the run is reported as it is", async () => {
    const reported: ExperimentResult[] = [];
    const platform = { id: "spy", experiments: { report: async (result: ExperimentResult) => (reported.push(result), {}) } };
    const result = await createClient({ platform, tracing: false }).evaluate("plain", { data: [{ input: "a@b.c" }], task: (x) => x });
    expect(reported[0]!.rows[0]).toMatchObject({ input: "a@b.c", output: "a@b.c" });
    expect(result.reports).toEqual([{ platform: "spy" }]);
  });
});
