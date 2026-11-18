import { describe, expect, it } from "vitest";
import { releasePlan } from "../scripts/release-plan.ts";

/**
 * decisions: releasing. package.json holds the version; the workflow derives the npm version, the
 * tag and the GitHub release from it. These are the only four situations it can find.
 */
describe("decisions: releasing", () => {
  it("does nothing before the first version exists on npm: that one is published by hand", () => {
    expect(releasePlan("0.1.0", { packageExists: false, versionPublished: false, tagExists: false })).toMatchObject({
      publish: false,
      release: false,
    });
    // Even if someone has already pushed the tag.
    expect(releasePlan("0.1.0", { packageExists: false, versionPublished: false, tagExists: true }).publish).toBe(false);
  });

  it("publishes, tags and releases a version npm does not have", () => {
    expect(releasePlan("0.2.0", { packageExists: true, versionPublished: false, tagExists: false })).toMatchObject({
      publish: true,
      release: true,
    });
  });

  it("only tags and releases a version that is on npm without a tag", () => {
    // The hand-published first version, or a run that failed after publishing.
    expect(releasePlan("0.1.0", { packageExists: true, versionPublished: true, tagExists: false })).toMatchObject({
      publish: false,
      release: true,
    });
  });

  it("does nothing on an ordinary push, where the version is already published and tagged", () => {
    expect(releasePlan("0.1.0", { packageExists: true, versionPublished: true, tagExists: true })).toMatchObject({
      publish: false,
      release: false,
    });
  });

  it("never publishes a version twice", () => {
    for (const tagExists of [true, false]) {
      expect(releasePlan("0.1.0", { packageExists: true, versionPublished: true, tagExists }).publish).toBe(false);
    }
  });
});
