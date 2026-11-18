/**
 * Turns the coverage numbers from `pnpm coverage` into two things for CI: a Markdown summary
 * (printed, for the run's summary page) and `coverage/badge.svg` (for the README). Written here
 * instead of using a coverage service so the repository needs no third-party account or token.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

interface Metric {
  total: number;
  covered: number;
  pct: number;
}
type FileCoverage = Record<"lines" | "statements" | "functions" | "branches", Metric>;

const root = resolve(import.meta.dirname, "..");
const summary = JSON.parse(readFileSync(resolve(root, "coverage/coverage-summary.json"), "utf8")) as Record<string, FileCoverage>;
const total = summary.total;
if (!total) throw new Error("coverage/coverage-summary.json has no total; run `pnpm coverage` first");

// ---- Markdown ---------------------------------------------------------------------------------

const row = (name: string, m: Metric) => `| ${name} | ${m.pct.toFixed(2)}% | ${m.covered} / ${m.total} |`;
const files = Object.entries(summary)
  .filter(([path, c]) => path !== "total" && c.lines.pct < 100)
  .sort(([, a], [, b]) => a.lines.pct - b.lines.pct)
  .slice(0, 10);

console.log(
  [
    "## Unit test coverage",
    "",
    "| | Covered | Count |",
    "|---|---|---|",
    row("Lines", total.lines),
    row("Statements", total.statements),
    row("Functions", total.functions),
    row("Branches", total.branches),
    "",
    ...(files.length
      ? [
          "<details><summary>Files with the lowest line coverage</summary>",
          "",
          "| File | Lines | Branches |",
          "|---|---|---|",
          ...files.map(([path, c]) => `| \`${relative(root, path)}\` | ${c.lines.pct.toFixed(1)}% | ${c.branches.pct.toFixed(1)}% |`),
          "",
          "</details>",
        ]
      : ["Every file has full line coverage."]),
    "",
    "The full HTML report is attached to this run as the `coverage-report` artifact.",
  ].join("\n"),
);

// ---- Badge ------------------------------------------------------------------------------------

const value = `${Math.floor(total.lines.pct)}%`;
const colour = total.lines.pct >= 95 ? "#3fb950" : total.lines.pct >= 80 ? "#d29922" : "#f85149";
const labelWidth = 62;
const valueWidth = 44;
const width = labelWidth + valueWidth;
writeFileSync(
  resolve(root, "coverage/badge.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="coverage: ${value}">
  <title>coverage: ${value}</title>
  <clipPath id="r"><rect width="${width}" height="20" rx="3"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${colour}"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">coverage</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${value}</text>
  </g>
</svg>
`,
);
