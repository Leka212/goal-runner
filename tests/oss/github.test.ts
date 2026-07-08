import { describe, expect, it } from "vitest";
import { countExternalMergedPrs } from "../../src/oss/github.js";

describe("github oss audit", () => {
  it("excludes merged PRs in repositories owned by the audited user", () => {
    const prs = [
      { repository_owner: "Leka212", merged: true },
      { repository_owner: "other-org", merged: true },
      { repository_owner: "other-org", merged: false },
    ];

    expect(countExternalMergedPrs(prs, "Leka212")).toBe(1);
  });

  it("matches the audited owner case-insensitively", () => {
    const prs = [
      { repository_owner: "leka212", merged: true },
      { repository_owner: "ExternalOrg", merged: true },
    ];

    expect(countExternalMergedPrs(prs, "LEKA212")).toBe(1);
  });
});
