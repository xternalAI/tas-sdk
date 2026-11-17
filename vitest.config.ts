import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this checkout's tests: agent worktrees under .claude/ hold copies of the whole repo.
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The executable is one line around `runCli`; it is exercised by a test that starts a real process.
      exclude: ["src/bin.ts"],
      reporter: ["text", "json-summary"],
      // The floor the project commits to. `pnpm coverage` fails below it.
      thresholds: { statements: 96, branches: 89, functions: 95, lines: 98 },
    },
  },
});
