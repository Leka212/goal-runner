import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { writeDefaultGoalConfig } from "../../src/core/config.js";
import { addReview } from "../../src/core/review.js";
import { canStopDone } from "../../src/core/gates.js";
import { startGoal, stopGoal } from "../../src/core/goals.js";
import { verifyCommand } from "../../src/core/verify.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("gates", () => {
  it("blocks done without required command evidence and required review", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await requireDoneReview(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);

    const result = await canStopDone(tmp, "ship");

    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toContain("missing required evidence");
    expect(result.reasons.join("\n")).toContain("missing admissible review verdict");
    await expect(stopGoal(tmp, "ship", "done")).rejects.toThrow(/missing required evidence/);
  });

  it("allows done when required evidence and an admissible review exist", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await requireDoneReview(tmp);
    await useFastRequiredCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await verifyCommand(tmp, "ship", "unit");
    await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Ready", evidence: "targeted tests pass" }]);

    const result = await canStopDone(tmp, "ship");

    expect(result).toEqual({ ok: true, reasons: [] });
    await expect(stopGoal(tmp, "ship", "done")).resolves.toBeUndefined();
    const goal = JSON.parse(await readFile(path.join(tmp, ".goal", "goals", "ship", "goal.json"), "utf8"));
    expect(goal.status).toBe("done");
  });

  it("rejects NO-GO reviews as inadmissible for done", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await requireDoneReview(tmp);
    await useFastRequiredCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await verifyCommand(tmp, "ship", "unit");
    await addReview(tmp, "ship", "NO-GO", "human", [{ severity: "important", title: "Blocked", evidence: "known blocker" }]);

    const result = await canStopDone(tmp, "ship");

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["missing admissible review verdict"]);
  });
});

async function requireDoneReview(root: string): Promise<void> {
  const configPath = path.join(root, ".goal", "goal.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  config.gates.require_review_for = ["done"];
  await writeFile(configPath, YAML.stringify(config), "utf8");
}

async function useFastRequiredCommand(root: string): Promise<void> {
  const configPath = path.join(root, ".goal", "goal.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  config.verification.commands[0] = {
    ...config.verification.commands[0],
    argv: [process.execPath, "-e", "process.exit(0)"],
    timeout_seconds: 5,
  };
  await writeFile(configPath, YAML.stringify(config), "utf8");
}
