import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderAgentsMd } from "../../src/adapters/agents-md.js";
import { renderClaudeSnippet } from "../../src/adapters/claude-code.js";
import { renderCodexSkill } from "../../src/adapters/codex.js";
import { detectPublishLeaks } from "../../src/core/redaction.js";

describe("adapters", () => {
  it("renders generate-only provider-neutral adapter text", () => {
    const agentsMd = renderAgentsMd("Ship CLI");
    const codexSkill = renderCodexSkill("Ship CLI");
    const claudeSnippet = renderClaudeSnippet("Ship CLI");

    expect(agentsMd).toContain("Ship CLI");
    expect(agentsMd).toContain("generate-only");
    expect(agentsMd).toContain("provider-neutral");
    expect(agentsMd).not.toMatch(/spawn|execute agents|npm publish|GitHub Actions/i);

    expect(codexSkill).toContain("provider-neutral");
    expect(codexSkill).toContain("Permissions are enforced by the goal CLI");
    expect(codexSkill).not.toContain("claude");

    expect(claudeSnippet).toContain("thin wrapper");
    expect(claudeSnippet).toContain("provider-neutral goal CLI");
    expect(claudeSnippet).not.toMatch(/permission boundary/i);
  });

  it("detects generic synthetic publish leaks without relying on private markers", async () => {
    const fixture = await readFile(path.join(import.meta.dirname, "..", "fixtures", "private-leak", "README.md"), "utf8");
    const detectorSource = await readFile(path.join(import.meta.dirname, "..", "..", "src", "core", "redaction.ts"), "utf8");

    expect(detectorSource).not.toMatch(/\b[A-Z][a-z]{4}y\|[A-Z][a-z]{4}a\b/);
    expect(fixture).not.toMatch(/\/home\/(?!example\b)[a-z0-9_-]+\b/i);
    expect(fixture).not.toMatch(/\b(?:10|100|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(fixture).not.toMatch(/\b(?!ExampleInternalProject\b)[A-Z][A-Za-z]+ internal\b/);

    expect(detectPublishLeaks("TOKEN=abc")).toContain("secret-like token text");
    expect(detectPublishLeaks("Authorization: Bearer abc.def_123")).toContain("secret-like token text");
    expect(detectPublishLeaks("/home/synthetic/private")).toContain("private home path");
    expect(detectPublishLeaks("ExampleInternalProject")).toContain("internal/private marker");
    expect(detectPublishLeaks("host 203.0.113.10")).toContain("ip address");
    expect(detectPublishLeaks(fixture)).toEqual(
      expect.arrayContaining(["secret-like token text", "internal/private marker", "ip address"]),
    );
  });
});
