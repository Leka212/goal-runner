import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEvents } from "../../src/core/ledger.js";
import { discoverProjectRules, projectRuleDoctorErrors, readProjectRulesState, recordProjectRulesSnapshot } from "../../src/core/project-rules.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("project rules", () => {
  it("detects local maintainer rule files and records only kind, path, and sha256", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-project-rules-"));
    await mkdir(path.join(tmp, ".github", "PULL_REQUEST_TEMPLATE"), { recursive: true });
    await writeFile(path.join(tmp, "CONTRIBUTING.md"), "Contributing rules\nDo not print me.\n", "utf8");
    await writeFile(path.join(tmp, "SECURITY.md"), "Security policy\n", "utf8");
    await writeFile(path.join(tmp, "CODE_OF_CONDUCT.md"), "Code of conduct\n", "utf8");
    await writeFile(path.join(tmp, ".github", "pull_request_template.md"), "Root PR template\n", "utf8");
    await writeFile(path.join(tmp, ".github", "PULL_REQUEST_TEMPLATE", "feature.md"), "Feature PR template\n", "utf8");

    const rules = await discoverProjectRules(tmp);

    expect(rules).toEqual([
      { kind: "code_of_conduct", path: "CODE_OF_CONDUCT.md", sha256: sha256("Code of conduct\n") },
      { kind: "contributing", path: "CONTRIBUTING.md", sha256: sha256("Contributing rules\nDo not print me.\n") },
      { kind: "security", path: "SECURITY.md", sha256: sha256("Security policy\n") },
      { kind: "pull_request_template", path: ".github/PULL_REQUEST_TEMPLATE/feature.md", sha256: sha256("Feature PR template\n") },
      { kind: "pull_request_template", path: ".github/pull_request_template.md", sha256: sha256("Root PR template\n") },
    ]);
    expect(JSON.stringify(rules)).not.toContain("Do not print me");
  });

  it("detects release policies and local agent instructions without snapshotting contents", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-project-rules-"));
    await mkdir(path.join(tmp, ".github"), { recursive: true });
    await mkdir(path.join(tmp, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(tmp, "RELEASE.md"), "Release checklist\nsecret release note\n", "utf8");
    await writeFile(path.join(tmp, "RELEASE_POLICY.md"), "Release policy\n", "utf8");
    await writeFile(path.join(tmp, ".github", "release.yml"), "release: policy\n", "utf8");
    await writeFile(path.join(tmp, "AGENTS.md"), "Agent instructions\n", "utf8");
    await writeFile(path.join(tmp, "CLAUDE.md"), "Claude instructions\n", "utf8");
    await writeFile(path.join(tmp, ".github", "copilot-instructions.md"), "Copilot instructions\n", "utf8");
    await writeFile(path.join(tmp, ".cursor", "rules", "team.mdc"), "Cursor rules\n", "utf8");

    const rules = await discoverProjectRules(tmp);

    expect(rules).toEqual([
      { kind: "release_policy", path: ".github/release.yml", sha256: sha256("release: policy\n") },
      { kind: "release_policy", path: "RELEASE_POLICY.md", sha256: sha256("Release policy\n") },
      { kind: "release_policy", path: "RELEASE.md", sha256: sha256("Release checklist\nsecret release note\n") },
      { kind: "agent_instructions", path: ".cursor/rules/team.mdc", sha256: sha256("Cursor rules\n") },
      { kind: "agent_instructions", path: ".github/copilot-instructions.md", sha256: sha256("Copilot instructions\n") },
      { kind: "agent_instructions", path: "AGENTS.md", sha256: sha256("Agent instructions\n") },
      { kind: "agent_instructions", path: "CLAUDE.md", sha256: sha256("Claude instructions\n") },
    ]);
    expect(JSON.stringify(rules)).not.toContain("secret release note");
  });

  it("records a project-rule snapshot ledger event without file contents", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-project-rules-"));
    await writeFile(path.join(tmp, "CONTRIBUTING.md"), "Keep changes reviewed.\n", "utf8");

    const snapshot = await recordProjectRulesSnapshot(tmp);

    expect(snapshot.files).toEqual([{ kind: "contributing", path: "CONTRIBUTING.md", sha256: sha256("Keep changes reviewed.\n") }]);
    const [event] = await readEvents(tmp);
    expect(event).toMatchObject({
      type: "project_rules.snapshot",
      slug: "__project_rules__",
      data: {
        files: [{ kind: "contributing", path: "CONTRIBUTING.md", sha256: sha256("Keep changes reviewed.\n") }],
      },
    });
    expect(JSON.stringify(event)).not.toContain("Keep changes reviewed");
  });
  it("reports stale snapshots when every snapshotted rule file is removed", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-project-rules-"));
    const contributingPath = path.join(tmp, "CONTRIBUTING.md");
    await writeFile(contributingPath, "Keep changes reviewed.\n", "utf8");
    await recordProjectRulesSnapshot(tmp);
    await rm(contributingPath);

    const state = await readProjectRulesState(tmp);

    expect(state.discovered_count).toBe(0);
    expect(state.stale).toBe(true);
    expect(state.satisfied).toBe(false);
    expect(projectRuleDoctorErrors(state)).toEqual([
      "stale project-rule snapshot: snapshot includes 1 project rule file(s), but no local project rule files are currently detected",
    ]);
  });
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
