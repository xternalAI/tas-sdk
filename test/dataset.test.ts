/**
 * Dataset files and the pull/push between them and a platform. Also pins the dataset decisions in
 * docs/decisions.md: pull never deletes rows from a file, push never deletes rows on a platform,
 * the platform's version of an item wins on pull, and hashed ids stay out of the file.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  braintrust,
  type DatasetStore,
  datasetPath,
  itemId,
  langfuse,
  langsmith,
  loadDataset,
  memory,
  pullDataset,
  pushDataset,
  stringifyDataset,
  writeDataset,
} from "../src/index.ts";
import { cli, SDK } from "./cli.ts";
import { datasetConformance, datasetItems } from "./conformance.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tas-ds-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("dataset files", () => {
  it("writes one item per line with keys in a fixed order, and reads them back", async () => {
    const path = await writeDataset(dir, {
      name: "team/qa",
      items: [{ metadata: { a: 1 }, expected: "x", input: { q: 1 }, id: "one" }, { input: "bare" }],
    });
    expect(path).toBe(datasetPath(dir, "team/qa"));
    expect(await readFile(path, "utf8")).toBe('{"id":"one","input":{"q":1},"expected":"x","metadata":{"a":1}}\n{"input":"bare"}\n');
    expect(await loadDataset(path)).toEqual({
      name: "qa",
      items: [{ id: "one", input: { q: 1 }, expected: "x", metadata: { a: 1 } }, { input: "bare" }],
    });
    expect(stringifyDataset({ name: "empty", items: [] })).toBe("");
  });

  it("an item's id is the one given, or a stable hash of its input", () => {
    expect(itemId({ id: "mine", input: 1 })).toBe("mine");
    expect(itemId({ input: { q: "a" } })).toBe(itemId({ input: { q: "a" } }));
    expect(itemId({ input: { q: "a" } })).not.toBe(itemId({ input: { q: "b" } }));
  });
});

describe("memory dataset store", () => datasetConformance(() => memory().datasets!));

describe("pull and push", () => {
  let store: DatasetStore;
  beforeEach(() => {
    store = memory().datasets!;
  });
  const fileItems = async () => (await loadDataset(datasetPath(dir, "qa"))).items;

  it("push sends the file, filling in hashed ids, and refuses duplicates", async () => {
    await writeDataset(dir, { name: "qa", items: [{ id: "a", input: 1 }, { input: { q: "no id" } }] });
    expect(await pushDataset(dir, store, "qa")).toEqual({ name: "qa", action: "pushed", items: 2 });
    expect((await store.pull("qa"))!.items).toEqual([
      { id: "a", input: 1 },
      { id: itemId({ input: { q: "no id" } }), input: { q: "no id" } },
    ]);
    await writeDataset(dir, { name: "dup", items: [{ input: "same" }, { input: "same" }] });
    await expect(pushDataset(dir, store, "dup")).rejects.toThrow(/two items share the id/);
  });

  it("pull creates the file when there is none, and reports a dataset the platform does not have", async () => {
    await store.push({ name: "qa", items: datasetItems });
    expect(await pullDataset(dir, store, "qa")).toEqual({ name: "qa", action: "pulled", items: 4, added: 4, updated: 0, localOnly: 0 });
    expect(await fileItems()).toEqual(datasetItems);
    expect(await pullDataset(dir, store, "nope")).toEqual({ name: "nope", action: "missing", items: 0 });
  });

  it("on pull the platform's version wins, the file keeps its order, new rows are appended, local rows are kept", async () => {
    await writeDataset(dir, {
      name: "qa",
      items: [
        { id: "local-only", input: "mine" },
        { id: "b", input: 2, expected: "old" },
        { id: "a", input: 1 },
      ],
    });
    await store.push({
      name: "qa",
      items: [
        { id: "a", input: 1 },
        { id: "b", input: 2, expected: "edited in the UI" },
        { id: "new", input: 3 },
      ],
    });
    expect(await pullDataset(dir, store, "qa")).toEqual({ name: "qa", action: "pulled", items: 4, added: 1, updated: 1, localOnly: 1 });
    expect(await fileItems()).toEqual([
      { id: "local-only", input: "mine" },
      { id: "b", input: 2, expected: "edited in the UI" },
      { id: "a", input: 1 },
      { id: "new", input: 3 },
    ]);
  });

  it("an id that is just the input's hash stays out of the file across a push and pull", async () => {
    await writeFile(datasetPath(dir, "qa"), '{"input":{"q":"a"},"expected":1}\n');
    await pushDataset(dir, store, "qa");
    await store.push({ name: "qa", items: [{ id: itemId({ input: { q: "a" } }), input: { q: "a" }, expected: 2 }] });
    await pullDataset(dir, store, "qa");
    expect(await readFile(datasetPath(dir, "qa"), "utf8")).toBe('{"input":{"q":"a"},"expected":2}\n');
  });

  it("push never deletes on the platform: a row removed from the file stays there", async () => {
    await writeDataset(dir, {
      name: "qa",
      items: [
        { id: "a", input: 1 },
        { id: "b", input: 2 },
      ],
    });
    await pushDataset(dir, store, "qa");
    await writeDataset(dir, { name: "qa", items: [{ id: "a", input: 1 }] });
    await pushDataset(dir, store, "qa");
    expect((await store.pull("qa"))!.items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("how each platform's rows are read", () => {
  const answering = (routes: (path: string, method: string, body: any) => unknown) =>
    (async (url: URL | RequestInfo, init?: RequestInit) => {
      const u = new URL(String(url));
      const reply = routes(u.pathname + u.search, init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined);
      return reply === undefined
        ? new Response(JSON.stringify({ message: "not found" }), { status: 404 })
        : new Response(JSON.stringify(reply));
    }) as typeof fetch;

  it("Braintrust: oldest first, nulls dropped, pages followed", async () => {
    const pages: any[] = [
      { events: [{ id: "b", input: 2, expected: null, metadata: null, created: "2026-01-02" }], cursor: "next" },
      { events: [{ id: "a", input: "one", expected: 1, metadata: { k: 1 }, created: "2026-01-01" }], cursor: null },
    ];
    const store = braintrust({
      apiKey: "k",
      projectId: "p",
      fetch: answering((path) =>
        path.startsWith("/v1/dataset?")
          ? { objects: path.includes("dataset_name=qa") ? [{ id: "ds", description: "QA set" }] : [] }
          : path.endsWith("/fetch")
            ? pages.shift()
            : {},
      ),
    }).datasets!;
    expect(await store.pull("qa")).toEqual({
      name: "qa",
      description: "QA set",
      items: [
        { id: "a", input: "one", expected: 1, metadata: { k: 1 } },
        { id: "b", input: 2 },
      ],
    });
    expect(await store.pull("other")).toBeNull();
  });

  it("Langfuse: our id prefix is removed, UI-created ids are kept, archived items are left out", async () => {
    const rows = [
      { id: "qa--a", input: "one", expectedOutput: 1, metadata: null, status: "ACTIVE", createdAt: "2026-01-01" },
      { id: "made-in-ui", input: { q: 2 }, expectedOutput: null, metadata: { k: 1 }, status: "ACTIVE", createdAt: "2026-01-02" },
      { id: "qa--gone", input: 3, status: "ARCHIVED", createdAt: "2026-01-03" },
    ];
    const store = langfuse({
      publicKey: "pk",
      secretKey: "sk",
      fetch: answering((path) =>
        path.includes("/v2/datasets/qa")
          ? { description: null }
          : path.includes("/dataset-items")
            ? { data: rows, meta: { totalPages: 1 } }
            : undefined,
      ),
    }).datasets!;
    expect(await store.pull("qa")).toEqual({
      name: "qa",
      items: [
        { id: "a", input: "one", expected: 1 },
        { id: "made-in-ui", input: { q: 2 }, metadata: { k: 1 } },
      ],
    });
    expect(await store.pull("missing")).toBeNull();
  });

  it("LangSmith: wrapped values are unwrapped, our bookkeeping and LangSmith's own are removed from metadata", async () => {
    const examples = [
      {
        id: "uuid-1",
        inputs: { input: "bare" },
        outputs: { output: 4 },
        metadata: { k: 1, __tas: { id: "a", wrapped: ["input", "output"] }, dataset_split: ["base"] },
        created_at: "2026-01-01",
      },
      {
        id: "uuid-2",
        inputs: { input: "really an object with this key" },
        outputs: null,
        metadata: { __tas: { id: "b" } },
        created_at: "2026-01-02",
      },
      { id: "uuid-3", inputs: { q: "made in the UI" }, outputs: { a: 1 }, metadata: null, created_at: "2026-01-03" },
    ];
    const store = langsmith({
      apiKey: "k",
      fetch: answering((path) =>
        path.includes("/datasets?name=qa")
          ? [{ id: "ds", name: "qa", description: "QA" }]
          : path.includes("/datasets?name=")
            ? []
            : path.includes("/examples?")
              ? examples
              : {},
      ),
    }).datasets!;
    expect(await store.pull("qa")).toEqual({
      name: "qa",
      description: "QA",
      items: [
        { id: "a", input: "bare", expected: 4, metadata: { k: 1 } },
        { id: "b", input: { input: "really an object with this key" } },
        { id: "uuid-3", input: { q: "made in the UI" }, expected: { a: 1 } },
      ],
    });
    expect(await store.pull("missing")).toBeNull();
  });
});

describe("listing datasets on each platform", () => {
  const paged = (pages: unknown[]) => (async () => new Response(JSON.stringify(pages.shift() ?? []))) as typeof fetch;
  const names = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ name: `d${from + i}` }));

  it("Braintrust lists the project's datasets", async () => {
    const store = braintrust({ apiKey: "k", projectId: "p", fetch: paged([{ objects: names(0, 2) }]) }).datasets!;
    expect(await store.list()).toEqual(["d0", "d1"]);
  });

  it("Langfuse follows pages until the last", async () => {
    const store = langfuse({
      publicKey: "pk",
      secretKey: "sk",
      fetch: paged([
        { data: names(0, 2), meta: { totalPages: 2 } },
        { data: names(2, 1), meta: { totalPages: 2 } },
      ]),
    }).datasets!;
    expect(await store.list()).toEqual(["d0", "d1", "d2"]);
  });

  it("LangSmith follows pages until a short one", async () => {
    const store = langsmith({ apiKey: "k", fetch: paged([names(0, 100), names(100, 3)]) }).datasets!;
    expect(await store.list()).toHaveLength(103);
  });
});

describe("tas datasets", () => {
  const run = (args: string[]) => cli(args, dir);

  it("lists, pushes every dataset file, and reports a dataset the platform does not have", async () => {
    await writeFile(
      join(dir, "tas.config.ts"),
      `import { defineConfig, memory } from ${SDK};\nexport default defineConfig({ platform: memory(), datasetsDir: "d" });\n`,
    );
    expect(await run(["datasets", "list"])).toEqual({ code: 0, out: "no datasets\n" });
    expect(await run(["datasets", "push"])).toEqual({ code: 0, out: "no dataset files\n" });
    await writeDataset(join(dir, "d"), { name: "team/qa", items: [{ input: 1 }, { input: 2 }] });
    await writeDataset(join(dir, "d"), { name: "smoke", items: [{ input: 1 }] });
    expect(await run(["datasets", "push"])).toEqual({ code: 0, out: "pushed     smoke  1 items\npushed     team/qa  2 items\n" });
    expect(await run(["datasets", "pull", "nope"])).toEqual({ code: 1, out: "missing    nope  (not on the platform)\n" });
    expect((await run(["datasets"])).code).toBe(2);
  });
});
