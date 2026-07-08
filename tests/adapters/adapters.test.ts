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

  it("detects public fixture leaks", async () => {
    const fixture = await readFile(path.join(import.meta.dirname, "..", "fixtures", "private-leak", "README.md"), "utf8");

    expect(detectPublishLeaks("TOKEN=abc")).toContain("secret-like token text");
    expect(detectPublishLeaks("Authorization: Bearer abc.def_123")).toContain("secret-like token text");
    expect(detectPublishLeaks("/home/mathis/private")).toContain("private home path");
    expect(detectPublishLeaks("Neody internal")).toContain("private project name");
    expect(detectPublishLeaks("Linda internal")).toContain("private project name");
    expect(detectPublishLeaks("host 100.83.96.73")).toContain("ip address");
    expect(detectPublishLeaks(fixture)).toEqual(
      expect.arrayContaining(["secret-like token text", "private home path", "private project name", "ip address"]),
    );
  });
});
