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
  it("reports done claims whose provenance was backfilled after the done event", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));
    await writeDefaultGoalConfig(tmp);
    await configureGatedFastCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    const evidence = await verifyCommand(tmp, "ship", "unit");
    const review = await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Ready", evidence: "tests pass" }]);
    expect(evidence.sha256).toEqual(expect.any(String));

    const eventsFile = path.join(tmp, ".goal", "events.jsonl");
    const [startedEvent] = (await readFile(eventsFile, "utf8")).trim().split("\n");
    await writeFile(eventsFile, `${startedEvent}\n`, "utf8");
    await recordEvent(tmp, {
      type: "goal.stopped",
      slug: "ship",
      data: {
        status: "done",
        gate_provenance: {
          checked_at: new Date().toISOString(),
          evidence: [{ id: evidence.id, command_id: "unit", sha256: evidence.sha256! }],
          reviews: [{ id: review.id, verdict: "GO", artifact_sha256: review.artifact_sha256 }],
        },
      },
    });
    await recordEvent(tmp, {
      type: "evidence.added",
      slug: "ship",
      data: {
        evidence_id: evidence.id,
        kind: evidence.kind,
        exit_code: evidence.exit_code,
        sha256: evidence.sha256!,
        artifact_paths: evidence.artifact_paths,
      },
    });
    await recordEvent(tmp, {
      type: "review.added",
      slug: "ship",
      data: { review_id: review.id, verdict: review.verdict, artifact_sha256: review.artifact_sha256 },
    });

    const result = await doctor(tmp);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("invalid done claim for ship");
    expect(result.errors.join("\n")).toContain("after done claim");
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
