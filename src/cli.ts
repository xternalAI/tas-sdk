#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "./client.ts";
import type { TasConfig, TasProfiles } from "./config.ts";
import type { EvalDefinition } from "./eval.ts";
import { loadPrompts } from "./prompt/file.ts";
import { pull, push, remove, status, type SyncContext, type SyncResult } from "./sync.ts";

const USAGE = `tas prompts <status|pull|push|delete> [names...]

  status   compare prompt files with the platform
  pull     platform -> files
  push     files -> platform
  delete   permanently delete the named prompts: every version on the platform,
           plus the local file. To retire a prompt reversibly, set
           "archived: true" in its file and push instead.

tas eval <files...>

  Run evaluations. Each file's default export is defineEval({...}), an array of them, or a
  function taking the client and returning either. Exits 1 if any threshold is not met.

Options
  --config <path>    config file (default: tas.config.ts)
  --profile <name>   which profile of a multi-profile config to use
  --label <label>    push: point this label at the pushed version (repeatable)
  --force            let the non-canonical side overwrite the canonical one, and push
                     prompts that use non-portable template syntax
  --yes              delete: confirm. Without it, delete only lists what it would remove
`;

const CONFIG_NAMES = ["tas.config.ts", "tas.config.mts", "tas.config.js", "tas.config.mjs"];

async function loadConfig(path: string | undefined, profile: string | undefined) {
  const file = path ? resolve(path) : CONFIG_NAMES.map((n) => resolve(n)).find(existsSync);
  if (!file || !existsSync(file)) throw new Error(`no config found (looked for ${path ?? CONFIG_NAMES.join(", ")})`);
  const loaded = ((await import(pathToFileURL(file).href)) as { default?: TasConfig | TasProfiles }).default;
  if (!loaded) throw new Error(`${file} has no default export`);
  if ("profiles" in loaded) {
    const name = profile ?? loaded.default;
    const config = loaded.profiles[name];
    if (!config) throw new Error(`no profile "${name}" (have: ${Object.keys(loaded.profiles).join(", ")})`);
    return { config, target: name };
  }
  if (profile) throw new Error(`--profile given but ${file} defines a single config`);
  return { config: loaded, target: "default" };
}

function report(results: SyncResult[]): number {
  for (const r of results) {
    const note =
      r.reason === "other-side-changed"
        ? "  (other side changed; use --force)"
        : r.reason === "non-portable"
          ? "  (non-portable template syntax; use --force)"
          : r.reason === "deleted-locally"
            ? "  (deleted here, still on the platform; `tas prompts delete` removes it there)"
            : r.reason === "deleted-remotely"
              ? "  (deleted on the platform; use --force to act anyway)"
              : r.overwrote
                ? `  (overwrote ${r.overwrote} change)`
                : "";
    console.log(`${r.action.padEnd(10)} ${r.name}${r.version ? `  @${r.version}` : ""}${note}`);
    if (r.nonPortable) console.log(`           not portable: ${r.nonPortable.join("  ")}`);
  }
  return results.some((r) => r.action === "refused") ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      profile: { type: "string" },
      label: { type: "string", multiple: true },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (positionals[0] === "eval" && !values.help) return runEvals(positionals.slice(1), values.config, values.profile);
  const [group, command, ...names] = positionals;
  if (values.help || group !== "prompts" || !command || !["status", "pull", "push", "delete"].includes(command)) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  const { config, target } = await loadConfig(values.config, values.profile);
  const registry = config.platform.prompts;
  if (!registry) throw new Error(`platform "${config.platform.id}" has no prompt registry`);
  const ctx: SyncContext = {
    dir: resolve(config.promptsDir ?? "prompts"),
    registry,
    platform: config.platform.id,
    canonical: config.canonical ?? "repo",
    target,
  };
  const only = names.length ? { only: names } : {};

  if (command === "status") {
    const entries = (await status(ctx)).filter((e) => !names.length || names.includes(e.name));
    for (const e of entries) {
      console.log(`${e.state.padEnd(15)} ${e.name}`);
      if (e.nonPortable) console.log(`                not portable: ${e.nonPortable.join("  ")}`);
    }
    if (!entries.length) console.log("no prompts");
    return 0;
  }
  if (command === "delete") {
    if (!names.length) throw new Error("delete needs at least one prompt name");
    if (!values.yes) {
      for (const name of names) console.log(`would delete ${name} from ${config.platform.id} (all versions) and its local file`);
      console.log("Nothing deleted. This cannot be undone on the platform; re-run with --yes to confirm.");
      return 1;
    }
    return report(await remove(ctx, names));
  }
  if (command === "pull") return report(await pull(ctx, { force: values.force, ...only }));
  return report(await push(ctx, { force: values.force, ...(values.label ? { labels: values.label } : {}), ...only }));
}

async function runEvals(files: string[], configPath: string | undefined, profile: string | undefined): Promise<number> {
  if (!files.length) throw new Error("eval needs at least one file");
  const { config } = await loadConfig(configPath, profile);
  const client = createClient({ ...config, prompts: config.prompts ?? (await loadPrompts(resolve(config.promptsDir ?? "prompts"))) });
  let failed = false;
  try {
    for (const file of files) {
      const exported = ((await import(pathToFileURL(resolve(file)).href)) as { default?: unknown }).default;
      const resolved = typeof exported === "function" ? await exported(client) : exported;
      const definitions = (Array.isArray(resolved) ? resolved : [resolved]) as EvalDefinition[];
      if (!definitions[0]?.name) throw new Error(`${file}: default export must be defineEval({...}), an array of them, or a function returning either`);
      for (const { name, ...options } of definitions) {
        const result = await client.evaluate(name, options);
        const scores = Object.entries(result.summary.scores).map(([k, v]) => `${k} ${v.mean.toFixed(3)}`).join("  ") || "(no scores)";
        console.log(`${result.passed ? "pass" : "FAIL"}  ${name}  ${result.rows.length} items  ${scores}${result.summary.errors ? `  ${result.summary.errors} errored` : ""}`);
        for (const failure of result.failures) console.log(`      below threshold: ${failure}`);
        for (const report of result.reports) console.log(`      ${report.platform}: ${report.error ? `not reported (${report.error})` : (report.url ?? `reported as ${result.runName}`)}`);
        failed ||= !result.passed;
      }
    }
  } finally {
    await client.close();
  }
  return failed ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`tas: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
