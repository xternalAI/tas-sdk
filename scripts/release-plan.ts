/**
 * Decides what the release workflow should do for the commit it is running on. The version in
 * package.json is the only place a version is written: the npm version, the git tag and the
 * GitHub release are all derived from it here, so they cannot disagree.
 *
 * A release has two halves with a person in between. The workflow *stages* the version on npm and
 * tags the commit; a maintainer approves the staged version on npm with 2FA, which makes it live;
 * a later run sees it live and creates the GitHub release. The tag is what records "already
 * submitted", since a workflow cannot ask npm what is waiting for approval.
 *
 * Run by .github/workflows/release.yml, which reads the result from the step's outputs.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ReleaseState {
  /** This exact version is live on npm. */
  versionPublished: boolean;
  /** The tag `v<version>` exists in the repository. */
  tagExists: boolean;
  /** A GitHub release exists for that tag. */
  releaseExists: boolean;
}

export interface ReleasePlan {
  /** Submit this version to npm for a maintainer's approval, and tag this commit `v<version>`. */
  stage: boolean;
  /** Create the GitHub release for `v<version>` (and the tag, if a hand-published version has none). */
  release: boolean;
  /** One line for the workflow log saying why. */
  reason: string;
}

export function releasePlan(version: string, state: ReleaseState): ReleasePlan {
  if (!state.versionPublished) {
    return state.tagExists
      ? { stage: false, release: false, reason: `${version} was submitted (tag v${version} exists) and is waiting for approval on npm` }
      : { stage: true, release: false, reason: `${version} is not on npm: stage it for approval and tag this commit` };
  }
  if (!state.releaseExists) return { stage: false, release: true, reason: `${version} is live on npm: create its GitHub release` };
  return { stage: false, release: false, reason: `${version} is published and released` };
}

/** True when the command succeeds. Used for questions `git` and `gh` answer with their exit code. */
function succeeds(command: string, args: string[], cwd: string): boolean {
  try {
    execFileSync(command, args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const { name, version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { name: string; version: string };

  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
  if (!response.ok && response.status !== 404) throw new Error(`npm registry answered ${response.status}`);
  const versions = response.ok ? Object.keys(((await response.json()) as { versions?: object }).versions ?? {}) : [];

  const plan = releasePlan(version, {
    versionPublished: versions.includes(version),
    // --exit-code: fail when no such tag exists on the remote.
    tagExists: succeeds("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/v${version}`], root),
    releaseExists: succeeds("gh", ["release", "view", `v${version}`, "--json", "tagName"], root),
  });
  console.log(plan.reason);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `version=${version}\nstage=${plan.stage}\nrelease=${plan.release}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
