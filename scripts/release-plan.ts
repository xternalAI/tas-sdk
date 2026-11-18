/**
 * Decides what the release workflow should do for the commit it is running on. The version in
 * package.json is the only place a version is written: the npm version, the git tag and the
 * GitHub release are all derived from it here, so they cannot disagree.
 *
 * Run by .github/workflows/release.yml, which reads the result from the step's outputs.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ReleaseState {
  /** The package has been published at least once, under any version. */
  packageExists: boolean;
  /** This exact version is on npm. */
  versionPublished: boolean;
  /** The tag `v<version>` exists in the repository. */
  tagExists: boolean;
}

export interface ReleasePlan {
  /** Publish this version to npm. */
  publish: boolean;
  /** Create the tag `v<version>` and its GitHub release on this commit. */
  release: boolean;
  /** One line for the workflow log saying why. */
  reason: string;
}

export function releasePlan(version: string, state: ReleaseState): ReleasePlan {
  // npm only lets a workflow publish a package that already exists, so the first version is published by hand.
  if (!state.packageExists)
    return { publish: false, release: false, reason: "the package is not on npm yet: the first version is published by hand" };
  if (!state.versionPublished)
    return { publish: true, release: true, reason: `${version} is not on npm: publish it, then tag and release it` };
  // Published, but the tag is missing: a hand-published version, or a run that failed between the two steps.
  if (!state.tagExists) return { publish: false, release: true, reason: `${version} is on npm but has no tag: tag and release it` };
  return { publish: false, release: false, reason: `${version} is already published and tagged` };
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const { name, version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { name: string; version: string };

  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
  if (!response.ok && response.status !== 404) throw new Error(`npm registry answered ${response.status}`);
  const versions = response.ok ? Object.keys(((await response.json()) as { versions?: object }).versions ?? {}) : [];
  const tags = execFileSync("git", ["ls-remote", "--tags", "origin", `refs/tags/v${version}`], { cwd: root, encoding: "utf8" });

  const plan = releasePlan(version, {
    packageExists: response.ok,
    versionPublished: versions.includes(version),
    tagExists: tags.trim() !== "",
  });
  console.log(plan.reason);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `version=${version}\npublish=${plan.publish}\nrelease=${plan.release}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
