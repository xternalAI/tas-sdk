import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PromptRegistry, RemotePrompt } from "./adapter.ts";
import { loadPrompts, promptPath, writePrompt } from "./prompt/file.ts";
import { hashPrompt, type PromptDefinition } from "./prompt/model.ts";
import { findNonPortable } from "./prompt/template.ts";

/**
 * Sync compares three hashes per prompt: the local file, the platform's latest
 * version, and the lockfile's record of the last time the two agreed.
 *
 * The one rule: the canonical side always wins, and the non-canonical side
 * never overwrites the canonical side without `force`.
 *   push (repo -> platform): repo-canonical always writes; platform-canonical
 *     writes only when the platform has not moved since the last sync.
 *   pull (platform -> repo): platform-canonical always writes; repo-canonical
 *     writes only when the file has not moved since the last sync.
 *
 * A prompt that was synced before and is now missing on one side was deleted
 * there. Deletion follows the same rule, with one hard limit: sync never
 * deletes anything on a platform. That takes an explicit `remove`.
 */

export const LOCKFILE = "tas.lock.json";

export type SyncState =
  | "in-sync"
  | "local-changed"
  | "remote-changed"
  | "conflict"
  | "local-only"
  | "remote-only"
  /** Synced before; the file is gone, the platform copy remains. */
  | "deleted-locally"
  /** Synced before; the platform copy is gone, the file remains. */
  | "deleted-remotely";

export interface StatusEntry {
  name: string;
  state: SyncState;
  local?: PromptDefinition;
  remote?: RemotePrompt;
  /** Template syntax outside the portable subset, found on either side. */
  nonPortable?: string[];
}

export interface SyncResult {
  name: string;
  action: "pushed" | "pulled" | "removed" | "unchanged" | "skipped" | "refused";
  /** Set when the canonical side replaced a change made on the other side. */
  overwrote?: "local" | "remote";
  /** Why a prompt was refused or skipped. */
  reason?: "other-side-changed" | "non-portable" | "deleted-locally" | "deleted-remotely";
  /** Template syntax outside the portable subset. Rendering such a prompt throws by default. */
  nonPortable?: string[];
  version?: string;
}

interface LockEntry {
  hash: string;
  version: string;
}
interface Lock {
  version: 1;
  /** One section per sync target (CLI profile), so one repo can mirror to several platforms. */
  targets: Record<string, { platform: string; prompts: Record<string, LockEntry> }>;
}

export interface SyncContext {
  dir: string;
  registry: PromptRegistry;
  platform: string;
  canonical: "repo" | "platform";
  /** Lock section name. Default "default". */
  target?: string;
}

async function readLock(dir: string): Promise<Lock> {
  try {
    return JSON.parse(await readFile(join(dir, LOCKFILE), "utf8")) as Lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, targets: {} };
    throw error;
  }
}

function section(lock: Lock, ctx: SyncContext): Record<string, LockEntry> {
  const key = ctx.target ?? "default";
  const existing = lock.targets[key];
  // A target repointed at another platform starts from a clean slate: old versions mean nothing there.
  if (existing?.platform === ctx.platform) return existing.prompts;
  return (lock.targets[key] = { platform: ctx.platform, prompts: {} }).prompts;
}

async function writeLock(dir: string, lock: Lock): Promise<void> {
  for (const target of Object.values(lock.targets)) {
    target.prompts = Object.fromEntries(Object.entries(target.prompts).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  await writeFile(join(dir, LOCKFILE), JSON.stringify(lock, null, 2) + "\n");
}

function classify(local: string | undefined, remote: string | undefined, locked: string | undefined): SyncState {
  if (local && !remote) return locked ? "deleted-remotely" : "local-only";
  if (!local && remote) return locked ? "deleted-locally" : "remote-only";
  if (local === remote) return "in-sync";
  if (locked === local) return "remote-changed";
  if (locked === remote) return "local-changed";
  return "conflict";
}

async function gather(ctx: SyncContext) {
  const [locals, remoteList, lock] = await Promise.all([loadPrompts(ctx.dir), ctx.registry.list(), readLock(ctx.dir)]);
  const locked = section(lock, ctx);
  const local = new Map(locals.map((d) => [d.name, d]));
  const names = [...new Set([...local.keys(), ...remoteList.map((r) => r.name)])].sort();
  // Gone from both sides: nothing left to remember.
  for (const name of Object.keys(locked)) if (!names.includes(name)) delete locked[name];
  const entries = await Promise.all(
    names.map(async (name): Promise<StatusEntry> => {
      const l = local.get(name);
      const r = (await ctx.registry.get({ name })) ?? undefined;
      const state = classify(l && hashPrompt(l), r && hashPrompt(r.definition), locked[name]?.hash);
      const nonPortable = [...new Set([...(l ? findNonPortable(l) : []), ...(r ? findNonPortable(r.definition) : [])])];
      return { name, state, ...(l ? { local: l } : {}), ...(r ? { remote: r } : {}), ...(nonPortable.length ? { nonPortable } : {}) };
    }),
  );
  return { entries, lock, locked };
}

export async function status(ctx: SyncContext): Promise<StatusEntry[]> {
  return (await gather(ctx)).entries;
}

export interface SyncOptions {
  force?: boolean;
  /** Push only: labels to point at the pushed version. */
  labels?: string[];
  /** Limit to these prompt names. */
  only?: string[];
}

export async function push(ctx: SyncContext, options: SyncOptions = {}): Promise<SyncResult[]> {
  const { entries, lock, locked } = await gather(ctx);
  const results: SyncResult[] = [];
  for (const entry of entries) {
    if (options.only && !options.only.includes(entry.name)) continue;
    const { name, state, local, remote } = entry;
    if (!local) {
      // Deleted here but still on the platform: push never deletes there. `remove` does.
      results.push({ name, action: "skipped", ...(state === "deleted-locally" ? { reason: "deleted-locally" as const } : {}) });
      continue;
    }
    const remoteMoved = state === "remote-changed" || state === "conflict";
    if (remoteMoved && ctx.canonical === "platform" && !options.force) {
      results.push({ name, action: "refused", reason: "other-side-changed" });
      continue;
    }
    // Deleted on the platform, which is the truth: do not bring it back from the file.
    if (state === "deleted-remotely" && ctx.canonical === "platform" && !options.force) {
      results.push({ name, action: "refused", reason: "deleted-remotely" });
      continue;
    }
    // Syntax only one platform understands must not spread to another by accident.
    const nonPortable = findNonPortable(local);
    if (nonPortable.length && state !== "in-sync" && !options.force) {
      results.push({ name, action: "refused", reason: "non-portable", nonPortable });
      continue;
    }
    if (state === "in-sync" && !options.labels?.length) {
      locked[name] = { hash: hashPrompt(local), version: remote!.version };
      results.push({ name, action: "unchanged", version: remote!.version });
      continue;
    }
    const pushed = await ctx.registry.push(local, {
      ...(options.labels ? { labels: options.labels } : {}),
      ...(options.force ? { force: true } : {}),
    });
    locked[name] = { hash: hashPrompt(local), version: pushed.version };
    results.push({
      name,
      action: state === "in-sync" ? "unchanged" : "pushed",
      version: pushed.version,
      ...(remoteMoved || state === "deleted-remotely" ? { overwrote: "remote" as const } : {}),
      ...(nonPortable.length ? { nonPortable } : {}),
    });
  }
  await writeLock(ctx.dir, lock);
  return results;
}

export async function pull(ctx: SyncContext, options: SyncOptions = {}): Promise<SyncResult[]> {
  const { entries, lock, locked } = await gather(ctx);
  const results: SyncResult[] = [];
  for (const entry of entries) {
    if (options.only && !options.only.includes(entry.name)) continue;
    const { name, state, remote } = entry;
    if (!remote) {
      // Deleted on the platform. If the platform is the truth the file goes too (git still has it).
      if (state === "deleted-remotely" && (ctx.canonical === "platform" || options.force)) {
        await rm(promptPath(ctx.dir, name), { force: true });
        delete locked[name];
        results.push({ name, action: "removed", overwrote: "local" });
      } else {
        results.push({ name, action: "skipped", ...(state === "deleted-remotely" ? { reason: "deleted-remotely" as const } : {}) });
      }
      continue;
    }
    // Deleted here, and the repo is the truth: do not bring it back from the platform.
    if (state === "deleted-locally" && ctx.canonical === "repo" && !options.force) {
      results.push({ name, action: "skipped", reason: "deleted-locally" });
      continue;
    }
    const localMoved = state === "local-changed" || state === "conflict";
    if (localMoved && ctx.canonical === "repo" && !options.force) {
      results.push({ name, action: "refused", reason: "other-side-changed" });
      continue;
    }
    const nonPortable = findNonPortable(remote.definition); // pulled anyway: the file should show what is really there
    if (state !== "in-sync") await writePrompt(ctx.dir, remote.definition);
    locked[name] = { hash: hashPrompt(remote.definition), version: remote.version };
    results.push({
      name,
      action: state === "in-sync" ? "unchanged" : "pulled",
      version: remote.version,
      ...(localMoved || state === "deleted-locally" ? { overwrote: "local" as const } : {}),
      ...(nonPortable.length ? { nonPortable } : {}),
    });
  }
  await writeLock(ctx.dir, lock);
  return results;
}

/**
 * Permanently delete prompts: every version on the platform, the local file and the lock entry.
 * This is the only code path that deletes on a platform, and it cannot be undone there.
 */
export async function remove(ctx: SyncContext, names: string[]): Promise<SyncResult[]> {
  const lock = await readLock(ctx.dir);
  const locked = section(lock, ctx);
  const results: SyncResult[] = [];
  for (const name of names) {
    await ctx.registry.delete(name);
    await rm(promptPath(ctx.dir, name), { force: true });
    delete locked[name];
    results.push({ name, action: "removed" });
  }
  await writeLock(ctx.dir, lock);
  return results;
}
