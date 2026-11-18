/**
 * Braintrust datasets: the `DatasetStore` (list, pull, push) and `upsertDataset`, the write that
 * the experiment reporter reuses to make sure an experiment's dataset exists.
 */
import type { Dataset, DatasetItem, DatasetStore } from "../../dataset.ts";
import type { Http } from "../shared.ts";
import type { BraintrustContext } from "./context.ts";

/** A dataset row as Braintrust's fetch endpoint returns it. */
interface DatasetRow {
  id: string;
  input: unknown;
  expected?: unknown;
  metadata?: Record<string, unknown> | null;
  created?: string;
}

/** The `DatasetStore` for this adapter's project. */
export function createDatasetStore(context: BraintrustContext): DatasetStore {
  return {
    list: () => listDatasets(context),
    pull: (name) => pullDataset(context, name),
    async push(dataset) {
      await upsertDataset(context, dataset);
    },
  };
}

/** Create the dataset if needed and upsert its rows by id. Returns Braintrust's id for it. */
export async function upsertDataset({ http, projectId }: BraintrustContext, dataset: Dataset): Promise<string> {
  // Creating a dataset that exists returns the existing one.
  const created = await http.expect<{ id: string }>("POST", "/v1/dataset", {
    body: { project_id: await projectId(), name: dataset.name, ...(dataset.description ? { description: dataset.description } : {}) },
  });
  if (dataset.items.length) {
    await http.request("POST", `/v1/dataset/${created.id}/insert`, {
      body: { events: dataset.items.map((item) => ({ id: item.id, input: item.input, expected: item.expected, metadata: item.metadata })) },
    });
  }
  return created.id;
}

/** Names of the project's datasets. */
async function listDatasets({ http, projectId }: BraintrustContext): Promise<string[]> {
  const found = await http.expect<{ objects: { name: string }[] }>("GET", "/v1/dataset", {
    query: { project_id: await projectId(), limit: "1000" },
  });
  return found.objects.map((d) => d.name);
}

/** The named dataset with every row, or null if the project has none by that name. */
async function pullDataset({ http, projectId }: BraintrustContext, name: string): Promise<Dataset | null> {
  const found = await http.expect<{ objects: { id: string; description?: string | null }[] }>("GET", "/v1/dataset", {
    query: { project_id: await projectId(), dataset_name: name },
  });
  const dataset = found.objects[0];
  if (!dataset) return null;
  const rows = await fetchRows(http, dataset.id);
  // Braintrust returns newest first; oldest first reads better in a file and stays stable as rows are added.
  rows.sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
  return { name, ...(dataset.description ? { description: dataset.description } : {}), items: rows.map(toItem) };
}

/** Every row of a dataset, following the cursor until a page comes back empty or without one. */
async function fetchRows(http: Http, datasetId: string): Promise<DatasetRow[]> {
  const rows: DatasetRow[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await http.expect<{ events: DatasetRow[]; cursor?: string | null }>("POST", `/v1/dataset/${datasetId}/fetch`, {
      body: { limit: 1000, ...(cursor ? { cursor } : {}) },
    });
    rows.push(...page.events);
    if (!page.cursor || !page.events.length) return rows;
    cursor = page.cursor;
  }
}

/** A Braintrust row as our item. A null or missing `expected` or `metadata` is left out. */
function toItem(row: DatasetRow): DatasetItem {
  return {
    id: row.id,
    input: row.input,
    ...(row.expected !== null && row.expected !== undefined ? { expected: row.expected } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
  };
}
