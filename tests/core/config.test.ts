import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGoalConfig, loadGoalConfig, writeDefaultGoalConfig } from "../../src/core/config.js";

type TempRoot = string | undefined;
let tmp: TempRoot;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("goal config", () => {
  it("creates a default config that uses argv verification commands", () => {
    const config = defaultGoalConfig("example");

    expect(config.project.name).toBe("example");
    expect(config.permissions.default_tier).toBe("read");
    expect(config.verification.commands[0].argv).toEqual(["npm", "test"]);
  });

  it("writes and loads a valid default config", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-config-"));

    await writeDefaultGoalConfig(tmp);
    const config = await loadGoalConfig(tmp);

    expect(config.project.name).toBe(path.basename(tmp));
    expect(config.permissions.default_tier).toBe("read");
    expect(config.verification.commands[0].argv).toEqual(["npm", "test"]);
  });

  it("rejects YAML configs that use shell-string verification commands", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-config-"));
    await writeDefaultGoalConfig(tmp);
    await writeFile(
      path.join(tmp, ".goal", "goal.yaml"),
      `project:\n  name: invalid\n  public_safe: true\nlimits:\n  max_iterations: 8\n  max_minutes: 45\n  max_workers: 4\n  max_review_rounds: 3\n  stale_no_output_seconds: 900\n  require_explicit_next_decision: true\n  kill_switch_file: .goal/KILL\npermissions:\n  default_tier: read\n  tiers: [read, suggest, comment, branch, release, admin]\n  fork_pr_safe_mode: true\nverification:\n  commands:\n    - id: unit\n      argv: npm test\n      timeout_seconds: 120\n      required_for_done: true\n      redact: true\n      output_byte_cap: 20000\ngates:\n  require_review_for: [publish]\n  review_verdicts:\n    allowed: [GO, GO-WITH-RISKS]\nredaction:\n  deny_env_patterns: [TOKEN]\n  deny_path_patterns: [.env]\n  deny_output_patterns: ["(?i)api[_-]?key"]\n`,
      "utf8",
    );

    await expect(loadGoalConfig(tmp)).rejects.toThrow(/goal-config/);
  });
});
