import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adapterRegistry, getAdapter, listAdapters, renderAdapter } from "../../src/adapters/registry.js";
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

  it("exposes deterministic first-class adapter metadata", () => {
    expect(listAdapters()).toEqual(adapterRegistry);
    expect(adapterRegistry.map((adapter) => adapter.id)).toEqual(["agents-md", "codex", "claude-code", "oh-my-pi"]);
    for (const adapter of adapterRegistry) {
      expect(adapter.label.length).toBeGreaterThan(0);
      expect(adapter.description.length).toBeGreaterThan(0);
      expect(adapter.targetFiles.length).toBeGreaterThan(0);
      expect(getAdapter(adapter.id)).toBe(adapter);
    }
    expect(getAdapter("claude")).toBe(getAdapter("claude-code"));
  });

  it("renders Oh-My-Pi and Claude Code guidance with Goal Protocol gates and evidence hooks", () => {
    const requiredHooks = ["Goal Protocol", "goal query --json", "goal review --stage preflight", "goal verify", "goal doctor", "evidence"];
    const ohMyPi = renderAdapter("oh-my-pi", "Ship CLI");
    const claudeCode = renderAdapter("claude-code", "Ship CLI");

    expect(ohMyPi).toContain("Oh-My-Pi");
    expect(ohMyPi).toContain("Ship CLI");
    expect(ohMyPi).toContain("generate-only");
    expect(ohMyPi).toContain("local");
    expect(claudeCode).toContain("CLAUDE.md");
    expect(claudeCode).toContain("skills");
    expect(claudeCode).toContain("subagent");
    expect(claudeCode).toContain("Ship CLI");

    for (const hook of requiredHooks) {
      expect(ohMyPi).toContain(hook);
      expect(claudeCode).toContain(hook);
    }
  });

  it("keeps every adapter output local, publish-clean, and free of action instructions", () => {
    for (const adapter of adapterRegistry) {
      const output = adapter.render("Ship CLI");
      expect(output).toContain("generate-only");
      expect(detectPublishLeaks(output)).toEqual([]);
      expect(output).not.toMatch(/npm publish|git push|gh pr create|launch|daemon|server|MCP install|external write|hosted automation|submit application/i);
    }
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
