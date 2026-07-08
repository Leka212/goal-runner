import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.js";
import { addEvidence } from "../../src/core/evidence.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("cli", () => {
  it("initializes, starts, and steps a goal", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["init"], tmp)).toBe(0);
    expect(await runCli(["start", "ship-cli", "Ship CLI", "--acceptance", "tests pass"], tmp)).toBe(0);
    expect(await runCli(["step", "ship-cli", "Created tests", "--evidence", "vitest output"], tmp)).toBe(0);

    const human = await readFile(path.join(tmp, "GOALS.md"), "utf8");
    expect(human).toContain("Ship CLI");
    expect(human).toContain("Created tests");
  });

  it("reports status and stops a goal without running verification commands", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));
    await writeFile(path.join(tmp, "sentinel.txt"), "not executed", "utf8");

    expect(await runCli(["init"], tmp)).toBe(0);
    expect(await runCli(["start", "ship-cli", "Ship CLI", "--acceptance", "tests pass"], tmp)).toBe(0);
    expect(await runCli(["status", "ship-cli"], tmp)).toBe(0);
    expect(await runCli(["stop", "ship-cli", "--status", "blocked"], tmp)).toBe(0);
    expect(await runCli(["status", "ship-cli"], tmp)).toBe(0);

    const goal = JSON.parse(await readFile(path.join(tmp, ".goal", "goals", "ship-cli", "goal.json"), "utf8"));
    expect(goal.status).toBe("blocked");
    expect(await readFile(path.join(tmp, "sentinel.txt"), "utf8")).toBe("not executed");
  });

  it("returns a failing exit code when status cannot find the goal", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["init"], tmp)).toBe(0);
    expect(await runCli(["status", "missing-goal"], tmp)).toBe(1);
  });

  it("prints machine-readable query JSON for agents and applies every query filter", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["init"], tmp)).toBe(0);
    await writeRepoConfig(tmp, "local/goal-runner");
    expect(await runCli(["start", "ship-cli", "Ship CLI", "--acceptance", "tests pass"], tmp)).toBe(0);
    await addEvidence(tmp, {
      slug: "ship-cli",
      kind: "file",
      artifact_paths: [],
      redaction_applied: true,
    });
    expect(await runCli(["review", "ship-cli", "--verdict", "NO-GO", "--reviewer", "human", "--stage", "preflight"], tmp)).toBe(0);
    expect(await runCli(["stop", "ship-cli", "--status", "blocked"], tmp)).toBe(0);
    expect(await runCli(["start", "docs-cli", "Docs CLI", "--acceptance", "docs updated"], tmp)).toBe(0);

    const all = await captureStdio(() => runCli(["query", "--json"], tmp));
    expect(all.exitCode).toBe(0);
    expect(all.stderr).toBe("");
    const parsed = JSON.parse(all.stdout);
    expect(parsed.goals.map((goal: { slug: string }) => goal.slug)).toEqual(["ship-cli", "docs-cli"]);
    expect(parsed.goals[0]).toMatchObject({
      slug: "ship-cli",
      status: "blocked",
      outcome: "blocked",
      acceptance: ["tests pass"],
      verified: { evidence: [{ kind: "file" }], reviews: [{ stage: "preflight", verdict: "NO-GO", reviewer: "human" }] },
      preflight_review: { required: false, satisfied: false, review_id: expect.any(String), verdict: "NO-GO", reviewer: "human" },
    });

    const bySlug = await captureStdio(() => runCli(["query", "--json", "--slug", "docs-cli"], tmp));
    expect(JSON.parse(bySlug.stdout).goals.map((goal: { slug: string }) => goal.slug)).toEqual(["docs-cli"]);

    const byStatus = await captureStdio(() => runCli(["query", "--json", "--status", "blocked"], tmp));
    expect(JSON.parse(byStatus.stdout).goals.map((goal: { slug: string }) => goal.slug)).toEqual(["ship-cli"]);

    const byRepo = await captureStdio(() => runCli(["query", "--json", "--repo", "local/goal-runner"], tmp));
    expect(JSON.parse(byRepo.stdout).goals.map((goal: { slug: string }) => goal.slug)).toEqual(["ship-cli", "docs-cli"]);

    const byOtherRepo = await captureStdio(() => runCli(["query", "--json", "--repo", "other/repo"], tmp));
    expect(JSON.parse(byOtherRepo.stdout).goals).toEqual([]);

    const byEventType = await captureStdio(() => runCli(["query", "--json", "--event-type", "review.added"], tmp));
    expect(JSON.parse(byEventType.stdout).goals.map((goal: { slug: string }) => goal.slug)).toEqual(["ship-cli"]);

    const byEvidenceKind = await captureStdio(() => runCli(["query", "--json", "--evidence-kind", "file"], tmp));
    expect(JSON.parse(byEvidenceKind.stdout).goals.map((goal: { slug: string }) => goal.slug)).toEqual(["ship-cli"]);

    const byReviewVerdict = await captureStdio(() => runCli(["query", "--json", "--review-verdict", "NO-GO"], tmp));
    expect(JSON.parse(byReviewVerdict.stdout).goals.map((goal: { slug: string }) => goal.slug)).toEqual(["ship-cli"]);

    const byFuture = await captureStdio(() => runCli(["query", "--json", "--from", "2100-01-01T00:00:00.000Z"], tmp));
    expect(JSON.parse(byFuture.stdout).goals).toEqual([]);

    const byRange = await captureStdio(() =>
      runCli(["query", "--json", "--from", "1970-01-01T00:00:00.000Z", "--to", "2100-01-01T00:00:00.000Z"], tmp),
    );
    expect(JSON.parse(byRange.stdout).goals.map((goal: { slug: string }) => goal.slug)).toEqual(["ship-cli", "docs-cli"]);
  });

  it("runs configured verification command through the CLI", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["init"], tmp)).toBe(0);
    expect(await runCli(["start", "ship-cli", "Ship CLI", "--acceptance", "tests pass"], tmp)).toBe(0);
    await writeFile(
      path.join(tmp, ".goal", "goal.yaml"),
      `project:
  name: test
  public_safe: true
limits:
  max_iterations: 8
  max_minutes: 45
  max_workers: 4
  max_review_rounds: 3
  stale_no_output_seconds: 900
  require_explicit_next_decision: true
  kill_switch_file: .goal/KILL
permissions:
  default_tier: read
  tiers: [read, suggest, comment, branch, release, admin]
  fork_pr_safe_mode: true
verification:
  commands:
    - id: ok
      argv: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify("console.log('verified'); process.exit(0)")}]
      timeout_seconds: 5
      required_for_done: true
      redact: true
      output_byte_cap: 20000
gates:
  require_review_for: []
  review_verdicts:
    allowed: [GO, GO-WITH-RISKS]
redaction:
  deny_env_patterns: [TOKEN]
  deny_path_patterns: [.env]
  deny_output_patterns: ['(?i)api[_-]?key=\\S+']
`,
      "utf8",
    );

    expect(await runCli(["verify", "ship-cli", "--command", "ok"], tmp)).toBe(0);

    const evidenceDir = path.join(tmp, ".goal", "goals", "ship-cli", "evidence");
    const events = await readFile(path.join(tmp, ".goal", "events.jsonl"), "utf8");
    expect(events).toContain("evidence.added");
    expect(await readFile(path.join(evidenceDir, "redacted-output", "ok.stdout.txt"), "utf8")).toContain("verified");
  });

  it("returns the verification command exit code after writing evidence for failures", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["init"], tmp)).toBe(0);
    expect(await runCli(["start", "ship-cli", "Ship CLI", "--acceptance", "tests pass"], tmp)).toBe(0);
    await writeFile(
      path.join(tmp, ".goal", "goal.yaml"),
      `project:
  name: test
  public_safe: true
limits:
  max_iterations: 8
  max_minutes: 45
  max_workers: 4
  max_review_rounds: 3
  stale_no_output_seconds: 900
  require_explicit_next_decision: true
  kill_switch_file: .goal/KILL
permissions:
  default_tier: read
  tiers: [read, suggest, comment, branch, release, admin]
  fork_pr_safe_mode: true
verification:
  commands:
    - id: fail
      argv: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify("console.error('api_key=secret'); process.exit(7)")}]
      timeout_seconds: 5
      required_for_done: true
      redact: true
      output_byte_cap: 20000
gates:
  require_review_for: []
  review_verdicts:
    allowed: [GO, GO-WITH-RISKS]
redaction:
  deny_env_patterns: [TOKEN]
  deny_path_patterns: [.env]
  deny_output_patterns: ['(?i)api[_-]?key=\\S+']
`,
      "utf8",
    );

    expect(await runCli(["verify", "ship-cli", "--command", "fail"], tmp)).toBe(7);

    const evidenceDir = path.join(tmp, ".goal", "goals", "ship-cli", "evidence");
    const events = await readFile(path.join(tmp, ".goal", "events.jsonl"), "utf8");
    expect(events).toContain("evidence.added");
    const stderr = await readFile(path.join(evidenceDir, "redacted-output", "fail.stderr.txt"), "utf8");
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).not.toContain("secret");
  });

  it("returns a failing exit code when doctor finds an invalid workspace", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["doctor"], tmp)).toBe(1);
    expect(await runCli(["init"], tmp)).toBe(0);
    expect(await runCli(["doctor"], tmp)).toBe(0);
  });

  it("blocks CLI done when required evidence and review gates are unsatisfied", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["init"], tmp)).toBe(0);
    await writeDoneGatedConfig(tmp, "blocked", "process.exit(0)");
    expect(await runCli(["start", "ship-cli", "Ship CLI", "--acceptance", "tests pass"], tmp)).toBe(0);

    expect(await runCli(["stop", "ship-cli", "--status", "done"], tmp)).toBe(1);
    const goal = JSON.parse(await readFile(path.join(tmp, ".goal", "goals", "ship-cli", "goal.json"), "utf8"));
    expect(goal.status).toBe("active");
  });

  it("allows CLI done and dashboard rendering after evidence and review gates pass", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["init"], tmp)).toBe(0);
    await writeDoneGatedConfig(tmp, "ok", "process.exit(0)");
    expect(await runCli(["start", "ship-cli", "Ship CLI", "--acceptance", "tests pass"], tmp)).toBe(0);
    expect(await runCli(["verify", "ship-cli", "--command", "ok"], tmp)).toBe(0);
    expect(await runCli(["review", "ship-cli", "--verdict", "GO", "--reviewer", "human"], tmp)).toBe(0);
    expect(await runCli(["dashboard"], tmp)).toBe(0);
    expect(await runCli(["stop", "ship-cli", "--status", "done"], tmp)).toBe(0);

    const goal = JSON.parse(await readFile(path.join(tmp, ".goal", "goals", "ship-cli", "goal.json"), "utf8"));
    expect(goal.status).toBe("done");
    const dashboard = JSON.parse(await readFile(path.join(tmp, ".goal", "dashboard.json"), "utf8"));
    expect(dashboard.goals["ship-cli"]).toMatchObject({
      evidence: { required: [{ id: "ok", satisfied: true }] },
      review: { required: true, satisfied: true, latest_verdict: "GO" },
      done_gate: { ok: true, reasons: [] },
    });
  });

  it("writes an OSS audit stub locally without external submission", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["oss", "audit", "--subject", "Leka212"], tmp)).toBe(0);

    const audit = JSON.parse(await readFile(path.join(tmp, ".goal", "oss", "audit.json"), "utf8")) as {
      subject: string;
      verified: string[];
      unknown: string[];
      inferred: string[];
      unmet: string[];
      external_submission: boolean;
    };
    expect(audit).toEqual({
      subject: "Leka212",
      verified: [],
      unknown: [
        "GitHub stars unknown",
        "registry downloads unknown",
        "dependent count unknown",
        "external merged PR count unknown",
      ],
      inferred: [],
      unmet: [],
      external_submission: false,
    });
  });

  it("writes an OSS dossier locally from explicit CLI facts", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(
      await runCli(
        [
          "oss",
          "dossier",
          "--subject",
          "Leka212",
          "--verified",
          "GitHub profile observed",
          "--unknown",
          "registry downloads unknown",
          "--inferred",
          "[INFERENCE] no public registry package found locally",
          "--unmet",
          "No verified external merged PR count",
        ],
        tmp,
      ),
    ).toBe(0);

    const markdown = await readFile(path.join(tmp, ".goal", "oss", "claude-for-oss-dossier.md"), "utf8");
    expect(markdown).toContain("## Verified facts\n\n- GitHub profile observed");
    expect(markdown).toContain("## Unknown or missing\n\n- registry downloads unknown");
    expect(markdown).toContain("## Inferences\n\n- [INFERENCE] no public registry package found locally");
    expect(markdown).toContain("## Unmet criteria\n\n- No verified external merged PR count");
    expect(markdown).toContain("No fake stars, downloads, dependents, PRs, maintainer rights, or affiliations are claimed.");
  });

  it("normalizes unprefixed CLI dossier inferences before writing markdown", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(
      await runCli(
        [
          "oss",
          "dossier",
          "--subject",
          "Leka212",
          "--inferred",
          "no public registry package found locally",
        ],
        tmp,
      ),
    ).toBe(0);

    const markdown = await readFile(path.join(tmp, ".goal", "oss", "claude-for-oss-dossier.md"), "utf8");
    expect(markdown).toContain("## Inferences\n\n- [INFERENCE] no public registry package found locally");
    expect(markdown).not.toContain("- no public registry package found locally");
  });
  it("writes generated adapter text only to the requested local file", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));
    const out = "AGENTS.md";

    expect(await runCli(["adapt", "agents-md", "Ship CLI", "--out", out], tmp)).toBe(0);

    const text = await readFile(path.join(tmp, out), "utf8");
    expect(text).toContain("Ship CLI");
    expect(text).toContain("generate-only");
    expect(text).toContain("provider-neutral");
  });

  it("lists available adapters with ids and descriptions", async () => {
    const result = await captureStdio(() => runCli(["adapt", "list"]));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("agents-md");
    expect(result.stdout).toContain("codex");
    expect(result.stdout).toContain("claude-code");
    expect(result.stdout).toContain("oh-my-pi");
    expect(result.stdout).toContain("description");
  });

  it("generates first-class Oh-My-Pi and Claude Code adapter guidance", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["adapt", "oh-my-pi", "Ship CLI", "--out", "OMP.md"], tmp)).toBe(0);
    expect(await runCli(["adapt", "claude-code", "Ship CLI", "--out", "CLAUDE.md"], tmp)).toBe(0);

    const ohMyPi = await readFile(path.join(tmp, "OMP.md"), "utf8");
    const claudeCode = await readFile(path.join(tmp, "CLAUDE.md"), "utf8");

    for (const text of [ohMyPi, claudeCode]) {
      expect(text).toContain("Goal Protocol");
      expect(text).toContain("goal query --json");
      expect(text).toContain("goal review --stage preflight");
      expect(text).toContain("goal verify");
      expect(text).toContain("goal doctor");
      expect(text).toContain("evidence");
      expect(text).toContain("generate-only");
      expect(text).not.toMatch(/npm publish|git push|gh pr create|launch|daemon|server|MCP install|external write|hosted automation|submit application/i);
    }
  });

  it("keeps legacy adapter aliases compatible", async () => {
    const agentsMd = await captureStdio(() => runCli(["adapt", "agents-md", "Ship CLI"]));
    const codex = await captureStdio(() => runCli(["adapt", "codex", "Ship CLI"]));
    const claude = await captureStdio(() => runCli(["adapt", "claude", "Ship CLI"]));

    expect(agentsMd.exitCode).toBe(0);
    expect(codex.exitCode).toBe(0);
    expect(claude.exitCode).toBe(0);
    expect(agentsMd.stdout).toContain("provider-neutral");
    expect(codex.stdout).toContain("provider-neutral");
    expect(claude.stdout).toContain("CLAUDE.md");
  });

  it("rejects adapter output paths that are absolute or escape the workspace", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));
    const workspace = path.join(tmp, "workspace");
    await mkdir(workspace);
    const absoluteOut = path.join(tmp, "absolute.md");
    const escapingOut = path.join(tmp, "escape.md");

    expect(await runCli(["adapt", "agents-md", "Ship CLI", "--out", absoluteOut], workspace)).toBe(1);
    await expect(readFile(absoluteOut, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    expect(await runCli(["adapt", "agents-md", "Ship CLI", "--out", "../escape.md"], workspace)).toBe(1);
    await expect(readFile(escapingOut, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes publish-check for clean local content", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));
    await writeFile(path.join(tmp, "clean.md"), "Public project notes only.\nNo private tokens here.\n", "utf8");

    const output = await captureStdio(() => runCli(["publish-check", "clean.md"], tmp));

    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("no publish leaks found");
  });

  it("passes publish-check for packaged public examples", async () => {
    const packageRoot = path.resolve(import.meta.dirname, "..", "..");

    const output = await captureStdio(() => runCli(["publish-check", "examples/manual-maintainer/goal.yaml"], packageRoot));

    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("no publish leaks found");
  });

  it("fails publish-check for leaking local content and reports findings", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));
    await writeFile(path.join(tmp, "leak.md"), "TOKEN=abc\n/home/synthetic/private\n", "utf8");

    const output = await captureStdio(() => runCli(["publish-check", "leak.md"], tmp));

    expect(output.exitCode).not.toBe(0);
    expect(output.stderr).toContain("publish-check found");
    expect(output.stderr).toContain("secret-like token text");
    expect(output.stderr).toContain("private home path");
  });

  it("rejects publish-check reads outside the workspace", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));
    const workspace = path.join(tmp, "workspace");
    await mkdir(workspace);
    const outsideFile = path.join(tmp, "outside.md");
    await writeFile(outsideFile, "Public notes\n", "utf8");

    expect(await runCli(["publish-check", outsideFile], workspace)).toBe(1);
    expect(await runCli(["publish-check", "../outside.md"], workspace)).toBe(1);
  });

  it("keeps publish-check local-only without writing submission artifacts", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));
    await writeFile(path.join(tmp, "clean.md"), "Safe local content.\n", "utf8");

    const before = await readdir(tmp);
    const output = await captureStdio(() => runCli(["publish-check", "clean.md"], tmp));
    const after = await readdir(tmp);

    expect(output.exitCode).toBe(0);
    expect(after).toEqual(before);
    expect(await readFile(path.join(tmp, "clean.md"), "utf8")).toBe("Safe local content.\n");
  });

  it("packs only runtime and public artifacts", () => {
    const packageRoot = path.resolve(import.meta.dirname, "..", "..");

    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const [{ files }] = JSON.parse(result.stdout) as [{ files: Array<{ path: string }> }];
    const packageFiles = files.map((file) => file.path);

    expect(packageFiles).toEqual(
      expect.arrayContaining([
        "package.json",
        "README.md",
        "LICENSE",
        "schemas/goal-config.schema.json",
        "examples/manual-maintainer/goal.yaml",
      ]),
    );
    expect(packageFiles.some((file) => file.startsWith(".superpowers/"))).toBe(false);
    expect(packageFiles.some((file) => file.startsWith("tests/"))).toBe(false);
    expect(packageFiles.some((file) => file.startsWith("src/"))).toBe(false);
    expect(packageFiles.some((file) => file.includes("private-leak"))).toBe(false);
  });

});

async function writeRepoConfig(root: string, repo: string): Promise<void> {
  const configPath = path.join(root, ".goal", "goal.yaml");
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, config.replace("  public_safe: true", `  repo: ${repo}\n  public_safe: true`), "utf8");
}

async function writeDoneGatedConfig(root: string, commandId: string, script: string): Promise<void> {
  await writeFile(
    path.join(root, ".goal", "goal.yaml"),
    `project:
  name: test
  public_safe: true
limits:
  max_iterations: 8
  max_minutes: 45
  max_workers: 4
  max_review_rounds: 3
  stale_no_output_seconds: 900
  require_explicit_next_decision: true
  kill_switch_file: .goal/KILL
permissions:
  default_tier: read
  tiers: [read, suggest, comment, branch, release, admin]
  fork_pr_safe_mode: true
verification:
  commands:
    - id: ${commandId}
      argv: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify(script)}]
      timeout_seconds: 5
      required_for_done: true
      redact: true
      output_byte_cap: 20000
gates:
  require_review_for: [done]
  review_verdicts:
    allowed: [GO, GO-WITH-RISKS]
redaction:
  deny_env_patterns: [TOKEN]
  deny_path_patterns: [.env]
  deny_output_patterns: ['(?i)api[_-]?key=\\S+']
`,
    "utf8",
  );
}

async function captureStdio(action: () => Promise<number>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = "";
  let stderr = "";

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    const exitCode = await action();
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}
