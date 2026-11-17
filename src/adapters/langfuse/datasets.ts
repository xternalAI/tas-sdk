/**
 * Datasets on Langfuse: listing, pulling and pushing them, and the mapping between our item ids
 * and Langfuse's. `upsertDataset` and `remoteItemId` are also what experiments use to store the
 * dataset a run was made on.
 */
import type { Dataset, DatasetItem, DatasetStore } from "../../dataset.ts";
import type { Http } from "../shared.ts";
import { allPages, type LangfuseContext } from "./context.ts";

/** A dataset item as the public API returns it. */
interface ItemRow {
  id: string;
  input: unknown;
  expectedOutput?: unknown;
  metadata?: Record<string, unknown> | null;
  status?: string;
  createdAt?: string;
}

export function datasetStore({ http }: LangfuseContext): DatasetStore {
  return {
    list: async () => (await allPages<{ name: string }>(http, "/v2/datasets")).map((d) => d.name),
    pull: (name) => pullDataset(http, name),
    async push(dataset) {
      await upsertDataset(http, dataset);
    },
  };
}

/** Langfuse item ids are unique across a whole project, so ours are prefixed with the dataset's name. */
export const remoteItemId = (dataset: string, id: string) => `${dataset}--${id}`;

/** Create the dataset if needed and upsert its items by id. Returns Langfuse's id for it. */
export async function upsertDataset(http: Http, dataset: Dataset): Promise<string> {
  // Creating a dataset that exists returns the existing one.
  const created = await http.request<{ id: string }>("POST", "/v2/datasets", {
    body: { name: dataset.name, ...(dataset.description ? { description: dataset.description } : {}) },
  });
  for (const item of dataset.items) {
    const id = remoteItemId(dataset.name, item.id!);
    await http.request("POST", "/dataset-items", {
      body: { datasetName: dataset.name, id, input: item.input, expectedOutput: item.expected, metadata: item.metadata },
    });
  }
  return created.id;
}

/** The dataset with its live items, oldest first, or null if Langfuse has none by that name. */
async function pullDataset(http: Http, name: string): Promise<Dataset | null> {
  const dataset = await http.find<{ description?: string | null }>("GET", `/v2/datasets/${encodeURIComponent(name)}`);
  if (!dataset) return null;
  const rows = await allPages<ItemRow>(http, "/dataset-items", { datasetName: name });
  const items = rows
    .filter((row) => row.status !== "ARCHIVED") // archived in the Langfuse UI: no longer part of the dataset
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
    .map((row) => toDatasetItem(name, row));
  return { name, ...(dataset.description ? { description: dataset.description } : {}), items };
}

/** Our view of a Langfuse item: the dataset prefix is removed from ids we wrote; ids made in the Langfuse UI are kept. */
function toDatasetItem(dataset: string, row: ItemRow): DatasetItem {
  const prefix = remoteItemId(dataset, "");
  return {
    id: row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id,
    input: row.input,
    ...(row.expectedOutput !== null && row.expectedOutput !== undefined ? { expected: row.expectedOutput } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
  };
}
