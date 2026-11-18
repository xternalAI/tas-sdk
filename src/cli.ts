import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "./client.ts";
import { inScope, resolveProfile, type TasConfig, type TasProfiles } from "./config.ts";
import { DATASET_EXTENSION, pullDataset, pushDataset } from "./dataset.ts";
import type { EvalDefinition } from "./eval.ts";
import { migrateDatasets, migratePrompts } from "./migrate.ts";
import { checkPortability } from "./portability.ts";
import { loadPrompts, writePromptSchema } from "./prompt/file.ts";
import { generatePromptTypes } from "./prompt/types.ts";
import { startStudio } from "./studio/server.ts";
import { pull, push, remove, type SyncContext, type SyncResult, selected, status } from "./sync.ts";

/**
 * The `tas` command line. `runCli` is the whole program as a function: it takes arguments and
 * somewhere to write, and returns an exit code, so it can be tested without starting a process.
 * `bin.ts` is the thin executable around it.
 *
 * Each command is one entry in `COMMANDS`. To add a command, add an entry and a line to `USAGE`.
 */

export const USAGE = `tas prompts <status|check|pull|push|delete|migrate|schema|types> [names...]

  A name ending in "/" means every prompt under that folder: tas prompts push support/
  With "scope" set in the config, commands only see prompts and datasets inside it.

  status   compare prompt files with the platform
  check    say what each prompt would not store natively on Braintrust, Langfuse and
           LangSmith, without contacting any of them. Exits 1 if a prompt cannot be
           stored somewhere at all.
  pull     platform -> files. Add --dry-run to see what it would write.
  push     files -> platform. Add --dry-run to see what it would send.
           With --label and no names it refuses, unless --all says every prompt is meant.
  delete   permanently delete the named prompts: every version on the platform,
           plus the local file. To retire a prompt reversibly, set
           "archived: true" in its file and push instead.
  migrate  copy prompts straight from one platform to another:
             tas prompts migrate --from <profile> --to <profile> [--history] [names...]
           Labels are kept. Without --history the newest version and every labelled
           version are copied; with it, every version, oldest first.
  schema   write prompt.schema.json into the prompts directory, for editor
           validation and autocomplete of *.prompt.yaml files
  types    write prompts.ts into the prompts directory: a TypeScript interface of
           every prompt's variables, placeholders and output, for createClient<Prompts>()

tas datasets <list|pull|push|migrate> [names...]

  list     datasets on the platform
  pull     platform -> <name>.dataset.jsonl. The platform's version of an item wins;
           rows only your file has are kept. No names: every dataset on the platform.
  push     file -> platform, upserting items by id. No names: every dataset file.
  migrate  copy datasets straight from one platform to another:
             tas datasets migrate --from <profile> --to <profile> [names...]

tas studio

  Open a local web page for browsing and editing the prompt files, with live validation,
  per-platform portability notes, sync and a way to try a prompt. Serves on this machine only.

tas eval <files...>

  Run evaluations. Each file's default export is defineEval({...}), an array of them, or a
  function taking the client and returning either. Exits 1 if any threshold is not met.

Options
  --config <path>    config file (default: tas.config.ts)
  --profile <name>   which profile of a multi-profile config to use
  --label <label>    push: point this label at the pushed version (repeatable)
  --all              push: with --label and no names, label every prompt in scope
  --dry-run          push, pull: report what would happen and change nothing
  --force            let the non-canonical side overwrite the canonical one, and push
                     prompts that use non-portable template syntax
  --yes              delete: confirm. Without it, delete only lists what it would remove
  --port <number>    studio: port to serve on (default 4983)
  --from, --to       migrate: the profiles to copy from and to
  --history          migrate: copy every version of each prompt, not only the ones in use
`;

export interface CliIO {
  /** Directory relative paths are resolved against. Default: the process's. */
  cwd: string;
  /** Receives each line of normal output. Default: console.log. */
  log: (line: string) => void;
  /** Receives error lines. Default: console.error. */
  error: (line: string) => void;
  /** Stops a long-running command (the studio). Default: Ctrl-C. */
  signal?: AbortSignal;
}

interface Flags {
  config: string | undefined;
  profile: string | undefined;
  label: string[] | undefined;
  all: boolean;
  dryRun: boolean;
  force: boolean;
  yes: boolean;
  port: string | undefined;
  from: string | undefined;
  to: string | undefined;
  history: boolean;
}

/** Everything a command needs. */
interface Invocation {
  /** Arguments after the command, e.g. prompt names. */
  args: string[];
  flags: Flags;
  io: CliIO;
  config: TasConfig;
  /** The profile in use, which is also the lockfile section. */
  target: string;
  /** Resolve a path against the working directory. */
  path: (...parts: string[]) => string;
  /** Load another profile of the same config file, for commands that work across two platforms. */
  profile: (name: string) => Promise<TasConfig>;
}
type Command = (inv: Invocation) => Promise<number>;

/** A message for the user, as opposed to a bug: printed without a stack trace. */
class UsageError extends Error {}

const CONFIG_NAMES = ["tas.config.ts", "tas.config.mts", "tas.config.js", "tas.config.mjs"];

async function loadConfig(
  cwd: string,
  path: string | undefined,
  profile: string | undefined,
): Promise<{ config: TasConfig; target: string }> {
  const file = path ? resolve(cwd, path) : CONFIG_NAMES.map((name) => resolve(cwd, name)).find(existsSync);
  if (!file || !existsSync(file)) throw new UsageError(`no config found (looked for ${path ?? CONFIG_NAMES.join(", ")})`);
  const loaded = ((await import(pathToFileURL(file).href)) as { default?: TasConfig | TasProfiles }).default;
  if (!loaded) throw new UsageError(`${file} has no default export`);
  if (profile && !("profiles" in loaded)) throw new UsageError(`--profile given but ${file} defines a single config`);
  try {
    const resolved = resolveProfile(loaded, profile);
    return { config: resolved.config, target: resolved.name };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------------------------

const promptsDir = (inv: Invocation) => inv.path(inv.config.promptsDir ?? "prompts");

function syncContext(inv: Invocation): SyncContext {
  const registry = inv.config.platform.prompts;
  if (!registry) throw new UsageError(`platform "${inv.config.platform.id}" has no prompt registry`);
  return {
    dir: promptsDir(inv),
    registry,
    platform: inv.config.platform.id,
    canonical: inv.config.canonical ?? "repo",
    target: inv.target,
    ...(inv.config.scope !== undefined ? { scope: inv.config.scope } : {}),
  };
}

const REASONS: Record<NonNullable<SyncResult["reason"]>, (r: SyncResult) => string> = {
  "other-side-changed": () => "other side changed; use --force",
  "non-portable": () => "non-portable template syntax; use --force",
  "deleted-locally": () => "deleted here, still on the platform; `tas prompts delete` removes it there",
  "deleted-remotely": () => "deleted on the platform; use --force to act anyway",
  unreadable: (r) => `cannot be read from the platform: ${r.error}`,
};

const WOULD: Partial<Record<SyncResult["action"], string>> = { pushed: "would push", pulled: "would pull", removed: "would remove" };

/**
 * Print what a sync did and return the exit code: 1 if anything was refused.
 *
 * Prompts that needed nothing (unchanged, or only on the other side) are counted, not listed, so a
 * change cannot hide in a long list. Naming prompts on the command line lists every one of them.
 */
function reportSync(results: SyncResult[], inv: Invocation, otherSide: string): number {
  const { io } = inv;
  let unchanged = 0;
  let elsewhere = 0;
  for (const r of results) {
    // Listed anyway: anything with something to say, and everything when a label was applied, since that changed it.
    const quiet = !inv.args.length && !inv.flags.label && !r.reason && !r.nonPortable;
    if (quiet && r.action === "unchanged") unchanged++;
    else if (quiet && r.action === "skipped") elsewhere++;
    else {
      const note = r.reason ? REASONS[r.reason](r) : r.overwrote ? `overwrote ${r.overwrote} change` : "";
      const action = (inv.flags.dryRun && WOULD[r.action]) || r.action;
      io.log(`${action.padEnd(10)} ${r.name}${r.version ? `  @${r.version}` : ""}${note ? `  (${note})` : ""}`);
      if (r.nonPortable) io.log(`           not portable: ${r.nonPortable.join("  ")}`);
    }
  }
  if (unchanged) io.log(`${unchanged} unchanged`);
  if (elsewhere) io.log(`${elsewhere} only ${otherSide}, left alone`);
  if (!results.length) io.log("no prompts");
  if (inv.flags.dryRun) io.log("Dry run: nothing was changed.");
  return results.some((r) => r.action === "refused") ? 1 : 0;
}

/** What a command is limited to: the names given, or else the config's scope. Both use the same "folder/" notation. */
function only(inv: Invocation, config: TasConfig = inv.config): { only?: string[] } {
  if (inv.args.length) return { only: inv.args };
  return config.scope !== undefined ? { only: [config.scope].flat() } : {};
}

/** Of `candidates`, the names a command applies to. Names given exactly are kept even if not among the candidates, so a typo is reported. */
function chosen(candidates: string[], inv: Invocation): string[] {
  if (!inv.args.length) return candidates.filter((name) => inScope(name, inv.config.scope));
  return [...new Set(inv.args.flatMap((arg) => (arg.endsWith("/") ? candidates.filter((name) => name.startsWith(arg)) : [arg])))];
}

/** The two configs a migration runs between, from --from and --to. */
async function migrationEnds(inv: Invocation): Promise<{ from: TasConfig; to: TasConfig }> {
  if (!inv.flags.from || !inv.flags.to) throw new UsageError("migrate needs --from <profile> and --to <profile>");
  if (inv.flags.from === inv.flags.to) throw new UsageError("--from and --to are the same profile");
  return { from: await inv.profile(inv.flags.from), to: await inv.profile(inv.flags.to) };
}

const promptCommands: Record<string, Command> = {
  async status(inv) {
    const entries = (await status(syncContext(inv))).filter((entry) => selected(entry.name, inv.args.length ? inv.args : undefined));
    for (const entry of entries) {
      inv.io.log(`${entry.state.padEnd(15)} ${entry.name}`);
      if (entry.nonPortable) inv.io.log(`                not portable: ${entry.nonPortable.join("  ")}`);
      if (entry.error) inv.io.log(`                ${entry.error}`);
    }
    if (!entries.length) inv.io.log("no prompts");
    return 0;
  },

  async check(inv) {
    const definitions = (await loadPrompts(promptsDir(inv))).filter((def) => selected(def.name, only(inv).only));
    let blocked = false;
    for (const def of definitions) {
      const notes = checkPortability(def);
      inv.io.log(
        `${notes.some((n) => n.level === "error") ? "error  " : notes.some((n) => n.level === "warning") ? "warning" : "ok     "} ${def.name}`,
      );
      for (const note of notes)
        inv.io.log(`        ${note.level.padEnd(7)} ${note.platform === "all" ? "every platform" : note.platform}: ${note.message}`);
      blocked ||= notes.some((n) => n.level === "error");
    }
    if (!definitions.length) inv.io.log("no prompts");
    return blocked ? 1 : 0;
  },

  async pull(inv) {
    const options = { force: inv.flags.force, dryRun: inv.flags.dryRun, ...(inv.args.length ? { only: inv.args } : {}) };
    return reportSync(await pull(syncContext(inv), options), inv, "in your files");
  },

  async push(inv) {
    // A label moves what production serves. Applying one to every prompt has to be said, not implied by leaving names out.
    if (inv.flags.label && !inv.args.length && !inv.flags.all) {
      throw new UsageError(
        `--label with no prompt names would point "${inv.flags.label.join('", "')}" at every prompt. ` +
          `Name the prompts (a folder such as "support/" works), or pass --all if every prompt is what you mean.`,
      );
    }
    const labels = inv.flags.label ? { labels: inv.flags.label } : {};
    const options = { force: inv.flags.force, dryRun: inv.flags.dryRun, ...labels, ...(inv.args.length ? { only: inv.args } : {}) };
    return reportSync(await push(syncContext(inv), options), inv, "on the platform");
  },

  async delete(inv) {
    if (!inv.args.length) throw new UsageError("delete needs at least one prompt name");
    if (!inv.flags.yes) {
      for (const name of inv.args) inv.io.log(`would delete ${name} from ${inv.config.platform.id} (all versions) and its local file`);
      inv.io.log("Nothing deleted. This cannot be undone on the platform; re-run with --yes to confirm.");
      return 1;
    }
    return reportSync(await remove(syncContext(inv), inv.args), inv, "on the platform");
  },

  async migrate(inv) {
    const { from, to } = await migrationEnds(inv);
    if (!from.platform.prompts || !to.platform.prompts) throw new UsageError("both platforms must have a prompt registry");
    const results = await migratePrompts(from.platform.prompts, to.platform.prompts, { history: inv.flags.history, ...only(inv, from) });
    for (const r of results) {
      const detail =
        r.action === "failed"
          ? `(${r.error})`
          : `${r.versions} version${r.versions === 1 ? "" : "s"}${r.labels.length ? `, labels: ${r.labels.join(", ")}` : ""}`;
      inv.io.log(`${r.action.padEnd(10)} ${r.name}  ${detail}`);
    }
    if (!results.length) inv.io.log("no prompts on the source platform");
    return results.some((r) => r.action === "failed") ? 1 : 0;
  },

  async schema(inv) {
    const written = await writePromptSchema(promptsDir(inv));
    inv.io.log(`wrote ${written}`);
    inv.io.log(`Files written by "tas prompts pull" reference it on their first line. For files you write by hand, add that line`);
    inv.io.log(`or map it in your editor, e.g. VS Code settings: "yaml.schemas": { "${written}": "*.prompt.yaml" }`);
    return 0;
  },

  async types(inv) {
    const definitions = await loadPrompts(promptsDir(inv));
    const file = resolve(promptsDir(inv), "prompts.ts");
    await writeFile(file, generatePromptTypes(definitions));
    inv.io.log(`wrote ${file} (${definitions.length} prompts)`);
    return 0;
  },
};

// ---------------------------------------------------------------------------------------------
// datasets
// ---------------------------------------------------------------------------------------------

const datasetsDir = (inv: Invocation) => inv.path(inv.config.datasetsDir ?? "datasets");

function datasetStore(inv: Invocation) {
  const store = inv.config.platform.datasets;
  if (!store) throw new UsageError(`platform "${inv.config.platform.id}" does not store datasets`);
  return store;
}

/** Names of the dataset files under a directory, e.g. "team/qa" for team/qa.dataset.jsonl. */
async function datasetFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries
    .filter((file) => file.endsWith(DATASET_EXTENSION))
    .map((file) => file.slice(0, -DATASET_EXTENSION.length).split(sep).join("/"))
    .sort();
}

const datasetCommands: Record<string, Command> = {
  async migrate(inv) {
    const { from, to } = await migrationEnds(inv);
    if (!from.platform.datasets || !to.platform.datasets) throw new UsageError("both platforms must store datasets");
    const results = await migrateDatasets(from.platform.datasets, to.platform.datasets, only(inv, from));
    for (const r of results) inv.io.log(`${r.action.padEnd(10)} ${r.name}  ${r.action === "failed" ? `(${r.error})` : `${r.items} items`}`);
    if (!results.length) inv.io.log("no datasets on the source platform");
    return results.some((r) => r.action === "failed") ? 1 : 0;
  },

  async list(inv) {
    const names = chosen(await datasetStore(inv).list(), inv);
    inv.io.log(names.length ? names.sort().join("\n") : "no datasets");
    return 0;
  },

  async pull(inv) {
    const store = datasetStore(inv);
    let missing = false;
    // Listing is only needed to expand a folder or apply the scope; exact names go straight through.
    const needsList = !inv.args.length || inv.args.some((arg) => arg.endsWith("/"));
    for (const name of chosen(needsList ? await store.list() : [], inv)) {
      const r = await pullDataset(datasetsDir(inv), store, name);
      missing ||= r.action === "missing";
      inv.io.log(
        r.action === "missing"
          ? `missing    ${name}  (not on the platform)`
          : `pulled     ${name}  ${r.items} items  (${r.added} new, ${r.updated} changed, ${r.localOnly} only in the file)`,
      );
    }
    return missing ? 1 : 0;
  },

  async push(inv) {
    const store = datasetStore(inv);
    const names = chosen(await datasetFiles(datasetsDir(inv)), inv);
    for (const name of names) {
      const r = await pushDataset(datasetsDir(inv), store, name);
      inv.io.log(`pushed     ${name}  ${r.items} items`);
    }
    if (!names.length) inv.io.log("no dataset files");
    return 0;
  },
};

// ---------------------------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------------------------

async function runEvals(inv: Invocation): Promise<number> {
  if (!inv.args.length) throw new UsageError("eval needs at least one file");
  const client = createClient({ ...inv.config, prompts: inv.config.prompts ?? (await loadPrompts(promptsDir(inv))) });
  let failed = false;
  try {
    for (const file of inv.args) {
      const exported = ((await import(pathToFileURL(inv.path(file)).href)) as { default?: unknown }).default;
      const resolved = typeof exported === "function" ? await exported(client) : exported;
      const definitions = (Array.isArray(resolved) ? resolved : [resolved]) as EvalDefinition[];
      if (!definitions[0]?.name)
        throw new UsageError(`${file}: default export must be defineEval({...}), an array of them, or a function returning either`);
      for (const { name, ...options } of definitions) {
        const result = await client.evaluate(name, options);
        const scores =
          Object.entries(result.summary.scores)
            .map(([key, value]) => `${key} ${value.mean.toFixed(3)}`)
            .join("  ") || "(no scores)";
        const errored = result.summary.errors ? `  ${result.summary.errors} errored` : "";
        inv.io.log(`${result.passed ? "pass" : "FAIL"}  ${name}  ${result.rows.length} items  ${scores}${errored}`);
        for (const failure of result.failures) inv.io.log(`      below threshold: ${failure}`);
        for (const report of result.reports)
          inv.io.log(
            `      ${report.platform}: ${report.error ? `not reported (${report.error})` : (report.url ?? `reported as ${result.runName}`)}`,
          );
        failed ||= !result.passed;
      }
    }
  } finally {
    await client.close();
  }
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// studio
// ---------------------------------------------------------------------------------------------

/** Serve the studio until the command is stopped. */
async function runStudio(inv: Invocation): Promise<number> {
  const port = inv.flags.port === undefined ? undefined : Number(inv.flags.port);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536))
    throw new UsageError(`--port must be a port number, got "${inv.flags.port}"`);
  const studio = await startStudio({ config: inv.config, dir: promptsDir(inv), target: inv.target }, port === undefined ? {} : { port });
  inv.io.log(`Studio is running at ${studio.url}`);
  inv.io.log(`Editing ${promptsDir(inv)} (platform: ${inv.config.platform.id}). Press Ctrl-C to stop.`);
  await new Promise<void>((resolve) => {
    if (inv.io.signal) inv.io.signal.addEventListener("abort", () => resolve(), { once: true });
    else process.once("SIGINT", () => resolve());
  });
  await studio.close();
  return 0;
}

// ---------------------------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------------------------

/** `tas <group> <command>`, or `tas <group>` for groups that are a command themselves. */
const GROUPS: Record<string, Record<string, Command> | Command> = {
  prompts: promptCommands,
  datasets: datasetCommands,
  eval: runEvals,
  studio: runStudio,
};

/** Run the CLI. Returns the exit code: 0 ok, 1 failed or refused, 2 not a valid command. */
export async function runCli(argv: string[], io: Partial<CliIO> = {}): Promise<number> {
  const out: CliIO = {
    cwd: io.cwd ?? process.cwd(),
    log: io.log ?? ((line) => console.log(line)),
    error: io.error ?? ((line) => console.error(line)),
    ...(io.signal ? { signal: io.signal } : {}),
  };
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        profile: { type: "string" },
        label: { type: "string", multiple: true },
        all: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        port: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        history: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    const [groupName, ...rest] = positionals;
    const group = groupName ? GROUPS[groupName] : undefined;
    const command = typeof group === "function" ? group : rest[0] ? group?.[rest[0]] : undefined;
    if (values.help || !command) {
      out.log(USAGE);
      return values.help ? 0 : 2;
    }
    const { config, target } = await loadConfig(out.cwd, values.config, values.profile);
    return await command({
      args: typeof group === "function" ? rest : rest.slice(1),
      flags: {
        config: values.config,
        profile: values.profile,
        label: values.label,
        all: values.all,
        dryRun: values["dry-run"],
        force: values.force,
        yes: values.yes,
        port: values.port,
        from: values.from,
        to: values.to,
        history: values.history,
      },
      io: out,
      config,
      target,
      path: (...parts) => resolve(out.cwd, ...parts),
      profile: async (name) => (await loadConfig(out.cwd, values.config, name)).config,
    });
  } catch (error) {
    out.error(`tas: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
