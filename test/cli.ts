import { resolve } from "node:path";
import { runCli } from "../src/cli.ts";

/** Run the CLI in-process from `cwd`, collecting what it prints, as `{ code, out }`. */
export async function cli(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await runCli(args, { cwd, log: (line) => lines.push(line), error: (line) => lines.push(line) });
  return { code, out: lines.map((line) => `${line}\n`).join("") };
}

/** Absolute path of the SDK entry point, for config and eval files written into temp directories. */
export const SDK = JSON.stringify(resolve("src/index.ts"));
