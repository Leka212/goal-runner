import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { writeDefaultGoalConfig } from "../../src/core/config.js";
import { doctor } from "../../src/core/doctor.js";
import { startGoal, stopGoal } from "../../src/core/goals.js";
import { recordEvent } from "../../src/core/ledger.js";
import { addReview } from "../../src/core/review.js";
import { verifyCommand } from "../../src/core/verify.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("doctor", () => {
  it("reports a missing config as unhealthy", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));

    await expect(doctor(tmp)).resolves.toEqual({
      ok: false,
      errors: expect.arrayContaining(["missing .goal/goal.yaml"]),
    });
  });

  it("reports an initialized workspace as healthy", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));

    await writeDefaultGoalConfig(tmp);

    await expect(doctor(tmp)).resolves.toEqual({ ok: true, errors: [] });
  });

  it("reports malformed event ledgers without throwing", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));
    await writeDefaultGoalConfig(tmp);
    await writeFile(path.join(tmp, ".goal", "events.jsonl"), "not json\n", "utf8");

    const result = await doctor(tmp);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("invalid event ledger");
  });

  it("reports manual done claims without gate provenance as invalid", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));
    await writeDefaultGoalConfig(tmp);
    await configureGatedFastCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await verifyCommand(tmp, "ship", "unit");
    await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Ready", evidence: "tests pass" }]);
    await recordEvent(tmp, { type: "goal.stopped", slug: "ship", data: { status: "done" } });

    const result = await doctor(tmp);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("invalid done claim for ship");
    expect(result.errors.join("\n")).toContain("missing gate provenance");
  });

  it("reports done claims whose referenced evidence was tampered", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));
    await writeDefaultGoalConfig(tmp);
    await configureGatedFastCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    const evidence = await verifyCommand(tmp, "ship", "unit");
    await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Ready", evidence: "tests pass" }]);
    await stopGoal(tmp, "ship", "done");
    await writeFile(evidence.stdout_redacted_path!, "tampered\n", "utf8");

    const result = await doctor(tmp);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("invalid done claim for ship");
    expect(result.errors.join("\n")).toContain("referenced evidence");
  });

  it("reports done claims whose referenced review was tampered", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));
    await writeDefaultGoalConfig(tmp);
    await configureGatedFastCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await verifyCommand(tmp, "ship", "unit");
    const review = await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Ready", evidence: "tests pass" }]);
    await stopGoal(tmp, "ship", "done");
    await writeFile(
      path.join(tmp, ".goal", "goals", "ship", "reviews", `${review.id}.json`),
      JSON.stringify({ ...review, findings: [] }, null, 2),
      "utf8",
    );

    const result = await doctor(tmp);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("invalid done claim for ship");
    expect(result.errors.join("\n")).toContain("referenced review");
  });

  it("accepts valid done claims with gate provenance", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));
    await writeDefaultGoalConfig(tmp);
    await configureGatedFastCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await verifyCommand(tmp, "ship", "unit");
    await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Ready", evidence: "tests pass" }]);
    await stopGoal(tmp, "ship", "done");

    await expect(doctor(tmp)).resolves.toEqual({ ok: true, errors: [] });
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
