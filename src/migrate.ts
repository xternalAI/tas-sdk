import type { PromptRegistry } from "./adapter.ts";
import { inScope } from "./config.ts";
import type { DatasetStore } from "./dataset.ts";
import { hashPrompt } from "./prompt/model.ts";

/**
 * Moving what is stored on one platform to another, platform to platform, without going through
 * files. Prompts keep their labels and, where the source can list versions, their history.
 * Datasets keep their items and ids. Traces and past experiments are not moved: they are records
 * of things that happened on the old platform.
 */

export interface MigrateOptions {
  /** Limit to these names; one ending in "/" means everything under that folder. Default: everything on the source. */
  only?: string[];
  /**
   * Recreate every version, oldest first, instead of only the newest one and the ones labels point
   * at. Needs a source that can list versions; fails for one that cannot.
   */
  history?: boolean;
}

export interface PromptMigration {
  name: string;
  /** "migrated", or "failed" with `error` saying why. One prompt failing does not stop the rest. */
  action: "migrated" | "failed";
  /** Versions this run created on the target. Zero when the target already had them all. */
  versions: number;
  /** Labels that were pointed at their matching version on the target. */
  labels: string[];
  error?: string;
}

/**
 * Copy prompts from `source` to `target`.
 *
 * Without `history`, the versions that matter are copied: each one a label points at, then the
 * newest, so every label and "latest" mean on the target what they meant on the source. With
 * `history`, every version is copied in order.
 *
 * New versions get new ids, dates and authors on the target, and consecutive identical versions
 * collapse into one, since pushing unchanged content creates nothing.
 */
export async function migratePrompts(
  source: PromptRegistry,
  target: PromptRegistry,
  options: MigrateOptions = {},
): Promise<PromptMigration[]> {
  if (options.history && !source.versions)
    throw new Error("the source platform cannot list prompt versions, so history cannot be migrated; run without --history");
  const listed = (await source.list()).filter((p) => inScope(p.name, options.only)).sort((a, b) => (a.name < b.name ? -1 : 1));
  const results: PromptMigration[] = [];

  for (const { name, labels } of listed) {
    try {
      // Which source version each label points at.
      const labelled = new Map<string, string>();
      for (const label of labels) {
        const at = await source.get({ name, label });
        if (at) labelled.set(label, at.version);
      }
      const newest = await source.get({ name });
      if (!newest) throw new Error("listed by the source but could not be fetched");

      // The source versions to recreate, in the order to push them: newest last, so it ends up newest.
      const wanted = options.history
        ? await source.versions!(name)
        : [...new Set([...labelled.values()].filter((v) => v !== newest.version)), newest.version];
      if (!wanted.length) throw new Error("the source listed no versions for it");
      const onTarget = new Map<string, string>(); // source version -> target version
      const existing = await versionsOnTarget(target, name, [...labelled.keys()]);
      let created = 0;
      for (const version of wanted) {
        const from = version === newest.version ? newest : await source.get({ name, version });
        if (!from) continue; // listed but gone: nothing to copy
        const hash = hashPrompt(from.definition);
        // A version the target already holds is reused, so running a migration again creates nothing.
        // The newest is the exception: it must end up newest, so it is pushed unless it already is.
        const reusable =
          version === newest.version ? (existing.newest === hash ? existing.byHash.get(hash) : undefined) : existing.byHash.get(hash);
        if (reusable) {
          onTarget.set(version, reusable);
          continue;
        }
        const pushed = await target.push(from.definition);
        if (hashPrompt(pushed.definition) !== hash) throw new Error(`version ${version} did not survive the move intact`);
        onTarget.set(version, pushed.version);
        existing.byHash.set(hash, pushed.version);
        existing.newest = hash;
        created++;
      }
      // Re-point each label at the version that corresponds to the one it pointed at.
      const moved: string[] = [];
      for (const [label, sourceVersion] of labelled) {
        const targetVersion = onTarget.get(sourceVersion);
        if (!targetVersion) continue;
        await target.setLabels(name, targetVersion, [label]);
        moved.push(label);
      }
      results.push({ name, action: "migrated", versions: created, labels: moved.sort() });
    } catch (error) {
      results.push({ name, action: "failed", versions: 0, labels: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * What the target already has of a prompt, by content: every version where the target can list
 * them, otherwise the newest and the ones the given labels point at.
 */
async function versionsOnTarget(target: PromptRegistry, name: string, labels: string[]) {
  const byHash = new Map<string, string>();
  const newest = await target.get({ name });
  const refs = target.versions
    ? (await target.versions(name)).map((version) => ({ name, version }))
    : labels.map((label) => ({ name, label }));
  for (const ref of refs) {
    const found = await target.get(ref);
    if (found) byHash.set(hashPrompt(found.definition), found.version);
  }
  if (newest) byHash.set(hashPrompt(newest.definition), newest.version);
  return { byHash, newest: newest ? hashPrompt(newest.definition) : undefined };
}

export interface DatasetMigration {
  name: string;
  action: "migrated" | "failed";
  items: number;
  error?: string;
}

/** Copy datasets from `source` to `target`, upserting items by id. */
export async function migrateDatasets(
  source: DatasetStore,
  target: DatasetStore,
  options: Pick<MigrateOptions, "only"> = {},
): Promise<DatasetMigration[]> {
  const names = (await source.list()).filter((name) => inScope(name, options.only)).sort();
  const results: DatasetMigration[] = [];
  for (const name of names) {
    try {
      const dataset = await source.pull(name);
      if (!dataset) throw new Error("listed by the source but could not be fetched");
      await target.push(dataset);
      results.push({ name, action: "migrated", items: dataset.items.length });
    } catch (error) {
      results.push({ name, action: "failed", items: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
