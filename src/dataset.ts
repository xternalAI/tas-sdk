import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Datasets: the items an evaluation runs over. They live in JSONL files in the repo and can be
 * pushed to, or pulled from, the platform, so a dataset curated in a vendor's UI and one kept in
 * git are the same thing.
 */

export interface DatasetItem<Input = unknown, Expected = unknown> {
  /** Stable identity across runs and platforms. Defaults to a hash of `input`. */
  id?: string;
  input: Input;
  expected?: Expected;
  metadata?: Record<string, unknown>;
}

export interface Dataset<Input = unknown, Expected = unknown> {
  name: string;
  description?: string;
  items: DatasetItem<Input, Expected>[];
}

/** What a platform adapter implements to store datasets. */
export interface DatasetStore {
  /** Names of the datasets on the platform. */
  list(): Promise<string[]>;
  /** The dataset with every item, or null if there is none by that name. Items always carry an id. */
  pull(name: string): Promise<Dataset | null>;
  /** Create the dataset if needed and upsert its items by id. Items missing from `dataset` are left alone. */
  push(dataset: Dataset): Promise<void>;
}

export const DATASET_EXTENSION = ".dataset.jsonl";
const ITEM_KEYS = ["id", "input", "expected", "metadata"];

/** An item's id: the one it was given, or a hash of its input so the same input is the same item everywhere. */
export function itemId(item: DatasetItem): string {
  return item.id ?? createHash("sha256").update(JSON.stringify(item.input)).digest("hex").slice(0, 16);
}

export function datasetPath(dir: string, name: string): string {
  return join(dir, ...name.split("/")) + DATASET_EXTENSION;
}

/** Load `<name>.dataset.jsonl`: one JSON object per line with `input`, and optionally `id`, `expected`, `metadata`. */
export async function loadDataset<Input = unknown, Expected = unknown>(path: string): Promise<Dataset<Input, Expected>> {
  const lines = (await readFile(path, "utf8")).split("\n");
  const items: DatasetItem<Input, Expected>[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Error(`${path}:${index + 1}: not valid JSON`);
    }
    if (!item || typeof item !== "object" || !("input" in item)) throw new Error(`${path}:${index + 1}: each line needs an "input"`);
    const unknown = Object.keys(item).filter((k) => !ITEM_KEYS.includes(k));
    if (unknown.length) throw new Error(`${path}:${index + 1}: unknown key "${unknown[0]}"`);
    items.push(item as DatasetItem<Input, Expected>);
  });
  const file = basename(path);
  return { name: file.endsWith(DATASET_EXTENSION) ? file.slice(0, -DATASET_EXTENSION.length) : file.replace(/\.[^.]+$/, ""), items };
}

/** One line per item, keys in a fixed order, so files diff cleanly whoever wrote them. */
export function stringifyDataset(dataset: Dataset): string {
  const line = (item: DatasetItem) => {
    const source = item as unknown as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries(ITEM_KEYS.filter((k) => source[k] !== undefined && source[k] !== null).map((k) => [k, source[k]])));
  };
  return dataset.items.map(line).join("\n") + (dataset.items.length ? "\n" : "");
}

export async function writeDataset(dir: string, dataset: Dataset): Promise<string> {
  const path = datasetPath(dir, dataset.name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyDataset(dataset));
  return path;
}

export interface DatasetSyncResult {
  name: string;
  action: "pulled" | "pushed" | "missing";
  /** Items now in the file (pull) or sent to the platform (push). */
  items: number;
  /** Pull only: items that were not in the file before. */
  added?: number;
  /** Pull only: items whose content changed. */
  updated?: number;
  /** Pull only: items in the file that the platform does not have. They are kept. */
  localOnly?: number;
}

/**
 * Bring a dataset from the platform into its file. The platform's version of an item wins; the
 * file keeps its order, new items are appended, and items only the file has are kept (pull never
 * deletes your rows).
 */
export async function pullDataset(dir: string, store: DatasetStore, name: string): Promise<DatasetSyncResult> {
  const remote = await store.pull(name);
  if (!remote) return { name, action: "missing", items: 0 };
  const local = await loadDataset(datasetPath(dir, name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return { name, items: [] } as Dataset;
    throw error;
  });
  const incoming = new Map(remote.items.map((item) => [itemId(item), item]));
  let updated = 0;
  let localOnly = 0;
  const merged: DatasetItem[] = local.items.map((item) => {
    const id = itemId(item);
    const fromPlatform = incoming.get(id);
    incoming.delete(id);
    if (!fromPlatform) {
      localOnly++;
      return item;
    }
    if (stringifyDataset({ name, items: [{ ...item, id }] }) !== stringifyDataset({ name, items: [fromPlatform] })) updated++;
    // Keep the file's habit of leaving out ids that are just the input's hash.
    if (item.id !== undefined) return fromPlatform;
    const { id: _hashed, ...withoutId } = fromPlatform;
    return withoutId;
  });
  const added = [...incoming.values()];
  await writeDataset(dir, { name, items: [...merged, ...added] });
  return { name, action: "pulled", items: merged.length + added.length, added: added.length, updated, localOnly };
}

/** Send a dataset file to the platform, upserting items by id. Items the platform has and the file lacks are left there. */
export async function pushDataset(dir: string, store: DatasetStore, name: string): Promise<DatasetSyncResult> {
  const dataset = await loadDataset(datasetPath(dir, name));
  const ids = dataset.items.map(itemId);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new Error(`dataset "${name}": two items share the id "${duplicate}" (ids default to a hash of the input; give them explicit ids)`);
  await store.push({ ...dataset, name, items: dataset.items.map((item) => ({ ...item, id: itemId(item) })) });
  return { name, action: "pushed", items: dataset.items.length };
}
