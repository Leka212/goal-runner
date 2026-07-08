import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDefaultGoalConfig } from "../../src/core/config.js";
import { fileSha256 } from "../../src/core/fs.js";
import { startGoal } from "../../src/core/goals.js";
import { verifyCommand } from "../../src/core/verify.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("verify", () => {
  it("captures successful command output as redacted, capped evidence", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-verify-"));
    await writeDefaultGoalConfig(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await writeGoalConfig(tmp, [
      `    - id: ok`,
      `      argv: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify("console.log('api_key=secret-' + 'x'.repeat(200)); process.exit(0)")}]`,
      `      timeout_seconds: 5`,
      `      required_for_done: true`,
      `      redact: true`,
      `      output_byte_cap: 100`,
    ]);

    const evidence = await verifyCommand(tmp, "ship", "ok");

    expect(evidence.exit_code).toBe(0);
    expect(evidence.command).toEqual([
      process.execPath,
      "-e",
      "console.log('api_key=secret-' + 'x'.repeat(200)); process.exit(0)",
    ]);
    expect(evidence.redaction_applied).toBe(true);
    expect(evidence.artifact_paths).toHaveLength(3);

    const stdout = await readFile(evidence.stdout_redacted_path!, "utf8");
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).toContain("[TRUNCATED");
    expect(stdout).not.toContain("secret");
    expect(stdout).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

    const manifestPath = evidence.artifact_paths.find((item) => item.endsWith(".sha256.json"));
    expect(manifestPath).toBeDefined();
    expect(evidence.sha256).toBe(await fileSha256(manifestPath!));
    const manifest = JSON.parse(await readFile(manifestPath!, "utf8"));
    expect(manifest.artifacts).toEqual(
      expect.arrayContaining([
        { path: evidence.stdout_redacted_path, sha256: await fileSha256(evidence.stdout_redacted_path!) },
        { path: evidence.stderr_redacted_path, sha256: await fileSha256(evidence.stderr_redacted_path!) },
      ]),
    );
  });

  it("captures non-zero exit code and redacts failure output without masking the failure", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-verify-"));
    await writeDefaultGoalConfig(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await writeGoalConfig(tmp, [
      `    - id: leak`,
      `      argv: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify("console.error('api_key=secret'); process.exit(7)")}]`,
      `      timeout_seconds: 5`,
      `      required_for_done: true`,
      `      redact: true`,
      `      output_byte_cap: 20000`,
    ]);

    const evidence = await verifyCommand(tmp, "ship", "leak");

    expect(evidence.exit_code).toBe(7);
    expect(evidence.redaction_applied).toBe(true);
    const stderr = await readFile(evidence.stderr_redacted_path!, "utf8");
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).not.toContain("secret");
  });

  it("passes argv entries literally instead of evaluating shell metacharacters", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-verify-"));
    await writeDefaultGoalConfig(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    const literalTarget = "literal.txt;touch shell-pwned";
    await writeGoalConfig(tmp, [
      `    - id: literal`,
      `      argv: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify("require('node:fs').writeFileSync(process.argv[1], 'ok')")}, ${JSON.stringify(literalTarget)}]`,
      `      timeout_seconds: 5`,
      `      required_for_done: true`,
      `      redact: true`,
      `      output_byte_cap: 20000`,
    ]);

    const evidence = await verifyCommand(tmp, "ship", "literal");

    expect(evidence.exit_code).toBe(0);
    await expect(access(path.join(tmp, literalTarget), constants.F_OK)).resolves.toBeUndefined();
    await expect(access(path.join(tmp, "shell-pwned"), constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function writeGoalConfig(root: string, commandLines: string[]): Promise<void> {
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
${commandLines.join("\n")}
gates:
  require_review_for: []
  review_verdicts:
    allowed: [GO, GO-WITH-RISKS]
redaction:
  deny_env_patterns: [TOKEN]
  deny_path_patterns: [.env]
  deny_output_patterns: ['(?i)api[_-]?key=\\S+', '(?i)bearer\\s+[a-z0-9._-]+']
`,
    "utf8",
  );
}
