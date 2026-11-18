import { describe, expect, it } from "vitest";
import { releasePlan } from "../scripts/release-plan.ts";

/**
 * decisions: releasing. package.json holds the version; the workflow derives the npm version, the
 * tag and the GitHub release from it. A maintainer's approval on npm sits between staging and the
 * release. These are the only situations a run can find.
 */
describe("decisions: releasing", () => {
  it("stages a version npm does not have, including the very first one", () => {
    expect(releasePlan("0.1.0", { versionPublished: false, tagExists: false, releaseExists: false })).toMatchObject({
      stage: true,
      release: false,
    });
  });

  it("does not stage a version again while it waits for approval: the tag records that it was submitted", () => {
    expect(releasePlan("0.1.0", { versionPublished: false, tagExists: true, releaseExists: false })).toMatchObject({
      stage: false,
      release: false,
    });
  });

  it("creates the GitHub release only once the version is live on npm", () => {
    expect(releasePlan("0.1.0", { versionPublished: true, tagExists: true, releaseExists: false })).toMatchObject({
      stage: false,
      release: true,
    });
    // A version published by hand has no tag yet; releasing it creates one.
    expect(releasePlan("0.1.0", { versionPublished: true, tagExists: false, releaseExists: false }).release).toBe(true);
  });

  it("does nothing on an ordinary push, where the version is published and released", () => {
    expect(releasePlan("0.1.0", { versionPublished: true, tagExists: true, releaseExists: true })).toMatchObject({
      stage: false,
      release: false,
    });
  });

  it("never submits a version that is already on npm", () => {
    for (const tagExists of [true, false]) {
      for (const releaseExists of [true, false]) {
        expect(releasePlan("0.1.0", { versionPublished: true, tagExists, releaseExists }).stage).toBe(false);
      }
    }
  });
});
