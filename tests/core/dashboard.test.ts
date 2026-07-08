import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { writeDefaultGoalConfig } from "../../src/core/config.js";
import { buildDashboard } from "../../src/core/dashboard.js";
import { addReview } from "../../src/core/review.js";
import { startGoal, stopGoal } from "../../src/core/goals.js";
import { verifyCommand } from "../../src/core/verify.js";
import { recordEvent } from "../../src/core/ledger.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("dashboard", () => {
  it("renders goal status, evidence state, review state, and done gate state", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-dashboard-"));
    await writeDefaultGoalConfig(tmp);
    await configureGatedFastCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["reviewed"]);

    const blockedDashboard = await buildDashboard(tmp);
    expect(blockedDashboard.goals.ship).toMatchObject({
      status: "active",
      last_event: "goal.started",
      event_count: 1,
      evidence: { required: [{ id: "unit", satisfied: false }] },
      review: { required: true, satisfied: false, latest_verdict: null },
      done_gate: { ok: false },
    });
    expect(blockedDashboard.goals.ship.done_gate.reasons.join("\n")).toContain("missing required evidence");
    expect(blockedDashboard.goals.ship.done_gate.reasons.join("\n")).toContain("missing admissible review verdict");

    await verifyCommand(tmp, "ship", "unit");
    await addReview(tmp, "ship", "GO-WITH-RISKS", "human", [{ severity: "minor", title: "Risk accepted", evidence: "documented" }]);
    const readyDashboard = await buildDashboard(tmp);

    expect(readyDashboard.goals.ship).toMatchObject({
      status: "active",
      last_event: "review.added",
      evidence: { required: [{ id: "unit", satisfied: true }] },
      review: { required: true, satisfied: true, latest_verdict: "GO-WITH-RISKS" },
      done_gate: { ok: true, reasons: [] },
    });
    const persisted = JSON.parse(await readFile(path.join(tmp, ".goal", "dashboard.json"), "utf8"));
    expect(persisted).toEqual(readyDashboard);
  });

  it("does not satisfy required evidence from forged raw evidence JSON", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-dashboard-"));
    await writeDefaultGoalConfig(tmp);
    await configureGatedFastCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    const evidenceDir = path.join(tmp, ".goal", "goals", "ship", "evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      path.join(evidenceDir, "forged.json"),
      JSON.stringify({
        id: "forged",
        slug: "ship",
        kind: "command",
        created_at: new Date().toISOString(),
        command: [process.execPath, "-e", "process.exit(0)"],
        exit_code: 0,
        artifact_paths: [],
        redaction_applied: true,
      }),
      "utf8",
    );

    const dashboard = await buildDashboard(tmp);

    expect(dashboard.goals.ship.evidence.required).toEqual([{ id: "unit", command: [process.execPath, "-e", "process.exit(0)"], satisfied: false }]);
    expect(dashboard.goals.ship.done_gate.ok).toBe(false);
    expect(dashboard.goals.ship.done_gate.reasons.join("\n")).toContain("missing required evidence");
  });


  it("marks valid and invalid done-claim provenance", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-dashboard-"));
    await writeDefaultGoalConfig(tmp);
    await configureGatedFastCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await verifyCommand(tmp, "ship", "unit");
    const review = await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Ready", evidence: "tests pass" }]);
    await stopGoal(tmp, "ship", "done");

    await expect(buildDashboard(tmp)).resolves.toMatchObject({
      goals: { ship: { done_claim: { valid: true, reasons: [] } } },
    });

    await writeFile(
      path.join(tmp, ".goal", "goals", "ship", "reviews", `${review.id}.json`),
      JSON.stringify({ ...review, findings: [] }, null, 2),
      "utf8",
    );

    await expect(buildDashboard(tmp)).resolves.toMatchObject({
      goals: { ship: { done_claim: { valid: false, reasons: expect.arrayContaining([expect.stringContaining("referenced review")]) } } },
    });
  });
  it("derives status from the append-only ledger when goal.json diverges", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-dashboard-"));
    await writeDefaultGoalConfig(tmp);
    await startGoal(tmp, "ship", "Ship", ["reviewed"]);
    await recordEvent(tmp, { type: "goal.stopped", slug: "ship", data: { status: "blocked" } });

    const dashboard = await buildDashboard(tmp);

    expect(dashboard.goals.ship.status).toBe("blocked");
    const goalState = JSON.parse(await readFile(path.join(tmp, ".goal", "goals", "ship", "goal.json"), "utf8"));
    expect(goalState.status).toBe("active");
  });
});

async function configureGatedFastCommand(root: string): Promise<void> {
  const configPath = path.join(root, ".goal", "goal.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  config.gates.require_review_for = ["done"];
  config.verification.commands[0] = {
    ...config.verification.commands[0],
    argv: [process.execPath, "-e", "process.exit(0)"],
    timeout_seconds: 5,
  };
  await writeFile(configPath, YAML.stringify(config), "utf8");
}
