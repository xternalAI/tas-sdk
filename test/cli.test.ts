/** The command line as a whole: dispatch, configuration loading, exit codes and error reporting. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USAGE } from "../src/cli.ts";
import { loadDataset, writeDataset, writePrompt, type PromptDefinition } from "../src/index.ts";
import { cli, SDK } from "./cli.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tas-cli-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const run = (...args: string[]) => cli(args, dir);
const config = (body: string, file = "tas.config.ts") => writeFile(join(dir, file), `import * as tas from ${SDK};\nconst { defineConfig, memory } = tas;\n${body}\n`);
const greet: PromptDefinition = { type: "text", name: "greet", text: "Hi {{name}}" };

describe("dispatch", () => {
  it("prints usage for --help (exit 0) and for anything it does not recognise (exit 2)", async () => {
    expect(await run("--help")).toEqual({ code: 0, out: `${USAGE}\n` });
    expect(await run("prompts", "status", "-h")).toEqual({ code: 0, out: `${USAGE}\n` });
    for (const args of [[], ["bogus"], ["prompts"], ["prompts", "bogus"], ["datasets"], ["datasets", "bogus"]]) {
      expect(await run(...args)).toEqual({ code: 2, out: `${USAGE}\n` });
    }
  });

  it("reports an unknown flag as an error, not a crash", async () => {
    const result = await run("prompts", "status", "--nope");
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^tas: .*--nope/);
  });

  it("the installed executable runs the same program", async () => {
    await config("export default defineConfig({ platform: memory() });");
    const { stdout } = await promisify(execFile)(process.execPath, [resolve("src/bin.ts"), "prompts", "status"], { cwd: dir });
    expect(stdout).toBe("no prompts\n");
    const failed = await promisify(execFile)(process.execPath, [resolve("src/bin.ts"), "bogus"], { cwd: dir }).catch((error: { code: number }) => error);
    expect((failed as { code: number }).code).toBe(2);
  });
});

describe("configuration", () => {
  it("explains a missing config, a config with no default export, and a bad profile", async () => {
    expect(await run("prompts", "status")).toEqual({ code: 1, out: "tas: no config found (looked for tas.config.ts, tas.config.mts, tas.config.js, tas.config.mjs)\n" });
    expect((await run("prompts", "status", "--config", "nope.ts")).out).toBe("tas: no config found (looked for nope.ts)\n");
    await config("export const notDefault = 1;", "empty.config.ts");
    expect((await run("prompts", "status", "--config", "empty.config.ts")).out).toMatch(/has no default export/);
    await config("export default defineConfig({ platform: memory() });");
    expect((await run("prompts", "status", "--profile", "acme")).out).toMatch(/--profile given but .* defines a single config/);
  });

  it("finds a config under any of its supported names, and takes one by path", async () => {
    await config("export default defineConfig({ platform: memory() });", "tas.config.mjs");
    expect(await run("prompts", "status")).toEqual({ code: 0, out: "no prompts\n" });
    await config("export default defineConfig({ platform: memory(), promptsDir: 'elsewhere' });", "other.ts");
    await writePrompt(join(dir, "elsewhere"), greet);
    expect(await run("prompts", "status", "--config", "other.ts")).toEqual({ code: 0, out: "local-only      greet\n" });
  });

  it("says so when the platform cannot do what a command needs", async () => {
    await config("export default defineConfig({ platform: { id: 'bare' } });");
    expect(await run("prompts", "status")).toEqual({ code: 1, out: 'tas: platform "bare" has no prompt registry\n' });
    expect(await run("datasets", "list")).toEqual({ code: 1, out: 'tas: platform "bare" does not store datasets\n' });
  });
});

describe("prompts", () => {
  it("status filters by name and shows what is not portable or cannot be read", async () => {
    await config(`
      const platform = memory();
      const realGet = platform.prompts.get;
      await platform.prompts.push({ type: "text", name: "broken", text: "x" });
      platform.prompts.get = (ref) => (ref.name === "broken" ? Promise.reject(new Error("not portable: reasons")) : realGet(ref));
      export default defineConfig({ platform });`);
    await writePrompt(join(dir, "prompts"), greet);
    await writePrompt(join(dir, "prompts"), { type: "text", name: "loopy", text: "{{#a}}x{{/a}}" });
    expect((await run("prompts", "status")).out).toBe(
      "unreadable      broken\n                not portable: reasons\nlocal-only      greet\nlocal-only      loopy\n                not portable: {{#a}}  {{/a}}\n",
    );
    expect((await run("prompts", "status", "greet")).out).toBe("local-only      greet\n");
  });

  it("push and pull exit 1 when something was refused, explain why, and take names and --force", async () => {
    await config("export default defineConfig({ platform: memory(), canonical: 'platform' });");
    await writePrompt(join(dir, "prompts"), greet);
    await writePrompt(join(dir, "prompts"), { type: "text", name: "loopy", text: "{{#a}}x{{/a}}" });
    expect(await run("prompts", "push", "greet")).toEqual({ code: 0, out: "pushed     greet  @1\n" });
    expect(await run("prompts", "push")).toEqual({
      code: 1,
      out: "unchanged  greet  @1\nrefused    loopy  (non-portable template syntax; use --force)\n           not portable: {{#a}}  {{/a}}\n",
    });
    expect((await run("prompts", "push", "--force")).out).toMatch(/pushed     loopy  @1\n           not portable/);
    expect(await run("prompts", "pull")).toEqual({ code: 0, out: "unchanged  greet  @1\nunchanged  loopy  @1\n           not portable: {{#a}}  {{/a}}\n" });
  });
});

describe("datasets", () => {
  it("pulls every dataset on the platform when no name is given, and one by name", async () => {
    await config(`
      const platform = memory();
      await platform.datasets.push({ name: "qa", items: [{ id: "a", input: 1, expected: 2 }] });
      await platform.datasets.push({ name: "smoke", items: [{ id: "b", input: 3 }] });
      export default defineConfig({ platform });`);
    await writeDataset(join(dir, "datasets"), { name: "qa", items: [{ id: "local", input: 0 }] });
    expect((await run("datasets", "list")).out).toBe("qa\nsmoke\n");
    expect((await run("datasets", "pull")).out).toBe("pulled     qa  2 items  (1 new, 0 changed, 1 only in the file)\npulled     smoke  1 items  (1 new, 0 changed, 0 only in the file)\n");
    expect((await loadDataset(join(dir, "datasets", "qa.dataset.jsonl"))).items).toEqual([{ id: "local", input: 0 }, { id: "a", input: 1, expected: 2 }]);
    expect(await run("datasets", "pull", "smoke")).toEqual({ code: 0, out: "pulled     smoke  1 items  (0 new, 0 changed, 0 only in the file)\n" });
    expect(await run("datasets", "push", "qa")).toEqual({ code: 0, out: "pushed     qa  2 items\n" });
  });
});

describe("eval", () => {
  it("accepts a single definition, reports errors and platform outcomes, and rejects a file that exports no eval", async () => {
    await config(`
      const reporting = { id: "reporter", experiments: { report: async () => ({ url: "https://r.test/exp" }) } };
      const failing = { id: "down", experiments: { report: async () => { throw new Error("no route"); } } };
      const silent = { id: "quiet", experiments: { report: async () => ({}) } };
      export const targets = [reporting, failing, silent];
      export default defineConfig({ platform: memory() });`);
    await writeFile(
      join(dir, "one.eval.ts"),
      `import { defineEval } from ${SDK};\nimport { targets } from "./tas.config.ts";\n` +
        `export default defineEval({ name: "single", data: [{ input: 1 }, { input: 2 }], task: (n) => { if (n === 2) throw new Error("boom"); return n; }, report: targets });\n`,
    );
    const result = await run("eval", "one.eval.ts");
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^pass  single  2 items  \(no scores\)  1 errored\n      reporter: https:\/\/r\.test\/exp\n      down: not reported \(no route\)\n      quiet: reported as single-[0-9a-z]+\n$/);

    await writeFile(join(dir, "bad.eval.ts"), "export default { nothing: true };\n");
    expect(await run("eval", "bad.eval.ts")).toEqual({ code: 1, out: "tas: bad.eval.ts: default export must be defineEval({...}), an array of them, or a function returning either\n" });
  });
});
