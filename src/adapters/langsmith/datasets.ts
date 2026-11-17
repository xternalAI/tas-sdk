/**
 * The `DatasetStore` for LangSmith: a dataset is a LangSmith dataset and an item is an example.
 * Also the example helpers the experiment reporter needs to bind its runs to the same examples.
 */
import { createHash } from "node:crypto";
import { ENVELOPE_KEY } from "../../adapter.ts";
import type { Dataset, DatasetItem, DatasetStore } from "../../dataset.ts";
import type { LangSmithContext } from "./context.ts";
import { LangSmithError } from "./error.ts";

interface RemoteDataset {
  id: string;
  name: string;
  description?: string | null;
}
interface Example {
  id: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
}

// LangSmith requires example inputs and outputs to be objects, and identifies examples by UUID.
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A value as LangSmith accepts it: objects as they are, anything else wrapped as `{ [key]: value }`. */
export const asObject = (value: unknown, key: string) => (isObject(value) ? value : { [key]: value ?? null });
/** A UUID derived from the dataset and item id, so the same item is the same example on every push. */
export const exampleId = (dataset: string, id: string) =>
  createHash("sha256")
    .update(`${dataset}\n${id}`)
    .digest("hex")
    .slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

/** The dataset with exactly this name, if there is one. */
export async function findDataset(ctx: LangSmithContext, name: string): Promise<RemoteDataset | undefined> {
  return ((await ctx.http.find<RemoteDataset[]>("GET", `/datasets?name=${encodeURIComponent(name)}`)) ?? []).find((d) => d.name === name);
}

/** Every example of a dataset, in the order the API pages them. */
async function listExamples(ctx: LangSmithContext, datasetId: string): Promise<Example[]> {
  const examples: Example[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await ctx.http.find<Example[]>("GET", `/examples?dataset=${datasetId}&limit=100&offset=${offset}`)) ?? [];
    examples.push(...page);
    if (page.length < 100) return examples;
  }
}

/** An example read back as the item that was pushed: its own id, and wrapped values unwrapped. */
function toItem(example: Example): DatasetItem {
  // `__tas` remembers the item's own id and which values were wrapped to satisfy LangSmith;
  // `dataset_split` is added by LangSmith itself. Neither is the user's metadata.
  const { [ENVELOPE_KEY]: ours, dataset_split: _split, ...metadata } = example.metadata ?? {};
  const note = (ours ?? {}) as { id?: string; wrapped?: string[] };
  const unwrap = (value: Record<string, unknown> | null | undefined, key: string) =>
    value && note.wrapped?.includes(key) ? value[key] : value;
  const expected = unwrap(example.outputs, "output");
  return {
    id: note.id ?? example.id,
    input: unwrap(example.inputs, "input"),
    ...(expected !== null && expected !== undefined ? { expected } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}

/** An item as the example to store, with a note in its metadata of what `toItem` has to undo. */
function toExample(datasetName: string, datasetId: string, item: DatasetItem) {
  const wrapped = [
    ...(isObject(item.input) ? [] : ["input"]),
    ...(item.expected === undefined || isObject(item.expected) ? [] : ["output"]),
  ];
  return {
    id: exampleId(datasetName, item.id!),
    dataset_id: datasetId,
    inputs: asObject(item.input, "input"),
    ...(item.expected === undefined ? {} : { outputs: asObject(item.expected, "output") }),
    metadata: { ...item.metadata, [ENVELOPE_KEY]: { id: item.id, ...(wrapped.length ? { wrapped } : {}) } },
  };
}

async function listDatasets(ctx: LangSmithContext): Promise<string[]> {
  const names: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await ctx.http.find<{ name: string }[]>("GET", `/datasets?limit=100&offset=${offset}`)) ?? [];
    names.push(...page.map((d) => d.name));
    if (page.length < 100) return names;
  }
}

async function pullDataset(ctx: LangSmithContext, name: string): Promise<Dataset | null> {
  const dataset = await findDataset(ctx, name);
  if (!dataset) return null;
  const examples = (await listExamples(ctx, dataset.id)).sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  return { name, ...(dataset.description ? { description: dataset.description } : {}), items: examples.map(toItem) };
}

/** The dataset by this name, created first if it does not exist. */
async function findOrCreateDataset(ctx: LangSmithContext, dataset: Dataset): Promise<RemoteDataset> {
  const found = await findDataset(ctx, dataset.name);
  if (found) return found;
  await ctx.http.find("POST", "/datasets", {
    body: { name: dataset.name, ...(dataset.description ? { description: dataset.description } : {}) },
  });
  const created = await findDataset(ctx, dataset.name);
  if (!created) throw new LangSmithError(`langsmith: dataset "${dataset.name}" could not be created`);
  return created;
}

async function pushDataset(ctx: LangSmithContext, dataset: Dataset): Promise<void> {
  const found = await findOrCreateDataset(ctx, dataset);
  const existing = new Set((await listExamples(ctx, found.id)).map((example) => example.id));
  const examples = dataset.items.map((item) => toExample(dataset.name, found.id, item));
  // Creating an example that exists does not update it, so new and existing ones take different calls.
  const fresh = examples.filter((example) => !existing.has(example.id));
  const known = examples.filter((example) => existing.has(example.id));
  if (fresh.length) await ctx.http.find("POST", "/examples/bulk", { body: fresh });
  if (known.length) await ctx.http.find("PATCH", "/examples/bulk", { body: known });
}

/** The dataset store of one adapter instance. */
export function createDatasets(ctx: LangSmithContext): DatasetStore {
  return {
    list: () => listDatasets(ctx),
    pull: (name) => pullDataset(ctx, name),
    push: (dataset) => pushDataset(ctx, dataset),
  };
}
