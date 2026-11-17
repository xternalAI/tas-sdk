#!/usr/bin/env node
import { runCli } from "./cli.ts";

// The executable. All behaviour lives in `runCli`; this only connects it to the process.
process.exitCode = await runCli(process.argv.slice(2));
