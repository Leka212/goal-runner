import { describe, expect, it } from "vitest";
import { buildClaudeForOssDossier } from "../../src/oss/dossier.js";

describe("Claude for OSS dossier", () => {
  it("separates verified, unknown, inferred, and unmet criteria", () => {
    const markdown = buildClaudeForOssDossier({
      subject: "Leka212",
      verified: ["GitHub profile observed"],
      unknown: ["registry downloads unknown"],
      inferred: ["[INFERENCE] project may become useful after public release"],
      unmet: ["No public repos observed"],
    });

    expect(markdown).toContain("# Claude for Open Source dossier — Leka212");
    expect(markdown).toContain("## Verified facts\n\n- GitHub profile observed");
    expect(markdown).toContain("## Unknown or missing\n\n- registry downloads unknown");
    expect(markdown).toContain("## Inferences\n\n- [INFERENCE] project may become useful after public release");
    expect(markdown).toContain("## Unmet criteria\n\n- No public repos observed");
    expect(markdown).not.toContain("200,000 downloads achieved");
  });

  it("renders empty sections as none instead of inventing metrics", () => {
    const markdown = buildClaudeForOssDossier({
      subject: "example",
      verified: [],
      unknown: [],
      inferred: [],
      unmet: [],
    });

    expect(markdown.match(/- none/g)).toHaveLength(4);
    expect(markdown).toContain("No fake stars, downloads, dependents, PRs, maintainer rights, or affiliations are claimed.");
  });
});
