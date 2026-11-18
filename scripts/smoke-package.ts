/**
 * Checks the package the way a user gets it: packs it, installs the tarball into an empty project
 * with npm, then imports it, type-checks against its declarations and runs the `tas` executable.
 * Catches what tests against `src/` cannot: a missing file in the tarball, a wrong `exports` or
 * `bin` path, an import that only resolves inside this repository.
 *
 * Run `pnpm build` first. Needs network access to install the two runtime dependencies.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "tas-smoke-"));
const run = (command: string, args: string[], cwd: string) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });

try {
  // `--ignore-scripts`: the build has been done; do not let `prepack` hide a stale or missing dist.
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", work], root);
  const tarball = readdirSync(work).find((file) => file.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");

  const app = join(work, "app");
  mkdirSync(join(app, "prompts"), { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", join(work, tarball)], app);

  // The library: import it, and use it end to end against the in-memory platform.
  writeFileSync(
    join(app, "main.ts"),
    `import { createClient, memory, checkPortability, type PromptDefinition } from "@traceandscale/sdk";
const prompt: PromptDefinition = { type: "chat", name: "hello", messages: [{ role: "user", content: "Hi {{name}}" }] };
const tas = createClient({ platform: memory(), prompts: [prompt], tracing: false });
const { messages } = await tas.prompts.render("hello", { variables: { name: "Ada" } });
if (messages[0]?.content !== "Hi Ada") throw new Error("render gave " + JSON.stringify(messages));
if (!Array.isArray(checkPortability(prompt))) throw new Error("checkPortability did not return notes");
console.log("library ok");
`,
  );
  process.stdout.write(run(process.execPath, ["main.ts"], app));

  // The declarations: the same file must type-check for a consumer.
  run(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--module",
      "nodenext",
      "--target",
      "es2024",
      "--skipLibCheck",
      "main.ts",
    ],
    app,
  );
  console.log("types ok");

  // The executable, through the path npm linked for it.
  writeFileSync(join(app, "prompts/hello.prompt.yaml"), "messages:\n  - role: user\n    content: Hi {{name}}\n");
  writeFileSync(
    join(app, "tas.config.ts"),
    `import { defineConfig, memory } from "@traceandscale/sdk";\nexport default defineConfig({ platform: memory() });\n`,
  );
  const tas = join(app, "node_modules/.bin/tas");
  if (!run(tas, ["--help"], app).includes("tas prompts")) throw new Error("tas --help did not print usage");
  const status = run(tas, ["prompts", "status"], app);
  if (!status.includes("hello")) throw new Error(`tas prompts status did not list the prompt:\n${status}`);
  console.log("cli ok");
} finally {
  rmSync(work, { recursive: true, force: true });
}
