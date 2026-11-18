import type { PlatformAdapter, PromptRegistry, RemotePrompt } from "../adapter.ts";
import type { Dataset, DatasetStore } from "../dataset.ts";
import { hashPrompt, parsePrompt } from "../prompt/model.ts";

/** In-process platform: the reference adapter for tests, local dev and the conformance suite. */
export function memory(): PlatformAdapter {
  const store = new Map<string, RemotePrompt[]>();

  const prompts: PromptRegistry = {
    capabilities: {
      labels: "native",
      textPrompts: "native",
      placeholders: "native",
      modelConfig: "native",
      tools: "native",
      outputSchema: "native",
      tags: "native",
      metadata: "native",
      description: "native",
      nestedNames: "native",
      archived: "native",
    },
    async get(ref) {
      const versions = store.get(ref.name);
      if (!versions) return null;
      const found = ref.version
        ? versions.find((v) => v.version === ref.version)
        : ref.label
          ? versions.find((v) => v.labels.includes(ref.label!))
          : versions.at(-1);
      return found ? structuredClone(found) : null;
    },
    async list() {
      return [...store].map(([name, versions]) => ({
        name,
        labels: [...new Set(versions.flatMap((v) => v.labels))],
      }));
    },
    async push(definition, options) {
      const def = parsePrompt(definition);
      const versions = store.get(def.name) ?? [];
      store.set(def.name, versions);
      let target = versions.at(-1);
      if (!target || hashPrompt(target.definition) !== hashPrompt(def)) {
        target = { definition: structuredClone(def), version: String(versions.length + 1), labels: [] };
        versions.push(target);
      }
      for (const label of options?.labels ?? []) {
        for (const v of versions) v.labels = v.labels.filter((l) => l !== label);
        target.labels.push(label);
      }
      return structuredClone(target);
    },
    async setLabels(name, version, labels) {
      const versions = store.get(name) ?? [];
      const target = versions.find((v) => v.version === version);
      if (!target) throw new Error(`memory: no version ${version} of "${name}"`);
      for (const v of versions) v.labels = v.labels.filter((l) => !labels.includes(l));
      target.labels.push(...labels);
    },
    async versions(name) {
      return (store.get(name) ?? []).map((v) => v.version);
    },
    async delete(name) {
      store.delete(name);
    },
  };

  const stored = new Map<string, Dataset>();
  const datasets: DatasetStore = {
    async list() {
      return [...stored.keys()];
    },
    async pull(name) {
      const dataset = stored.get(name);
      return dataset ? structuredClone(dataset) : null;
    },
    async push(dataset) {
      const existing = stored.get(dataset.name) ?? { name: dataset.name, items: [] };
      const items = new Map(existing.items.map((item) => [item.id, item]));
      for (const item of dataset.items) items.set(item.id, structuredClone(item)); // upsert by id, keep the rest
      stored.set(dataset.name, {
        ...existing,
        ...(dataset.description ? { description: dataset.description } : {}),
        items: [...items.values()],
      });
    },
  };

  return { id: "memory", prompts, datasets };
}
