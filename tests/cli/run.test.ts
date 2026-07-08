import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.js";

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
});

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
