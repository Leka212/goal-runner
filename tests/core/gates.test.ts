import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { writeDefaultGoalConfig } from "../../src/core/config.js";
import { addReview } from "../../src/core/review.js";
import { canStopDone, evaluateStageGate } from "../../src/core/gates.js";
import { startGoal, stopGoal } from "../../src/core/goals.js";
import { recordProjectRulesSnapshot } from "../../src/core/project-rules.js";
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

  it("allows done and records gate provenance for required evidence and an admissible review", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await requireDoneReview(tmp);
    await useFastRequiredCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    const evidence = await verifyCommand(tmp, "ship", "unit");
    const review = await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Ready", evidence: "targeted tests pass" }]);

    const result = await canStopDone(tmp, "ship");

    expect(result).toEqual({ ok: true, reasons: [] });
    await expect(stopGoal(tmp, "ship", "done")).resolves.toBeUndefined();
    const events = (await readFile(path.join(tmp, ".goal", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const stopped = events.find((event) => event.type === "goal.stopped");
    expect(stopped.data.gate_provenance).toMatchObject({
      evidence: [{ id: evidence.id, command_id: "unit", sha256: evidence.sha256 }],
      reviews: [{ id: review.id, verdict: "GO", artifact_sha256: review.artifact_sha256 }],
    });
    expect(Date.parse(stopped.data.gate_provenance.checked_at)).not.toBeNaN();
    const goal = JSON.parse(await readFile(path.join(tmp, ".goal", "goals", "ship", "goal.json"), "utf8"));
    expect(goal.status).toBe("done");
  });

  it("requires an admissible preflight review when configured and does not accept a done review instead", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await requirePreflightReview(tmp);
    await useFastRequiredCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["spec reviewed", "evidence"]);
    await verifyCommand(tmp, "ship", "unit");
    await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Done review", evidence: "not a spec review" }]);

    const blocked = await canStopDone(tmp, "ship");

    expect(blocked.ok).toBe(false);
    expect(blocked.reasons).toEqual(["missing admissible preflight review verdict"]);
    await expect(stopGoal(tmp, "ship", "done")).rejects.toThrow(/missing admissible preflight review verdict/);

    const preflight = await addReview(
      tmp,
      "ship",
      "GO",
      "adapter",
      [{ severity: "minor", title: "Spec reviewed", evidence: "preflight checklist passed" }],
      { stage: "preflight" },
    );

    const ready = await canStopDone(tmp, "ship");

    expect(ready).toEqual({ ok: true, reasons: [] });
    await expect(stopGoal(tmp, "ship", "done")).resolves.toBeUndefined();
    const events = (await readFile(path.join(tmp, ".goal", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const stopped = events.find((event) => event.type === "goal.stopped");
    expect(stopped.data.gate_provenance.reviews).toContainEqual({
      id: preflight.id,
      stage: "preflight",
      verdict: "GO",
      artifact_sha256: preflight.artifact_sha256,
    });
  });

  it("fails publish gates closed when local project rules have no snapshot", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await writeFile(path.join(tmp, "RELEASE.md"), "Release policy\n", "utf8");
    await startGoal(tmp, "ship", "Ship", ["publish readiness"]);
    await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Publish review", evidence: "package dry run checked" }], {
      stage: "publish",
    });

    const result = await evaluateStageGate(tmp, "ship", "publish");

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["missing project-rule snapshot for 1 local project rule file(s): RELEASE.md"]);
  });

  it("passes publish and release gates after project rules snapshot and admissible configured reviews", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await writeFile(path.join(tmp, "AGENTS.md"), "Agent rules\n", "utf8");
    await startGoal(tmp, "ship", "Ship", ["publish readiness"]);
    await recordProjectRulesSnapshot(tmp, { goalSlug: "ship" });

    const publishBlocked = await evaluateStageGate(tmp, "ship", "publish");
    expect(publishBlocked.ok).toBe(false);
    expect(publishBlocked.reasons).toEqual(["missing admissible publish review verdict"]);

    await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Publish review", evidence: "package dry run checked" }], {
      stage: "publish",
    });
    await addReview(tmp, "ship", "GO-WITH-RISKS", "adapter", [{ severity: "minor", title: "Release review", evidence: "tag plan reviewed" }], {
      stage: "release",
    });

    await expect(evaluateStageGate(tmp, "ship", "publish")).resolves.toEqual({ ok: true, reasons: [] });
    await expect(evaluateStageGate(tmp, "ship", "release")).resolves.toEqual({ ok: true, reasons: [] });
  });

  it("fails release gates when the project-rule snapshot is stale", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    const releasePolicy = path.join(tmp, "RELEASE_POLICY.md");
    await writeFile(releasePolicy, "Initial release policy\n", "utf8");
    await startGoal(tmp, "ship", "Ship", ["release readiness"]);
    await recordProjectRulesSnapshot(tmp, { goalSlug: "ship" });
    await writeFile(releasePolicy, "Updated release policy\n", "utf8");
    await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Release review", evidence: "reviewed before policy changed" }], {
      stage: "release",
    });

    const result = await evaluateStageGate(tmp, "ship", "release");

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["stale project-rule snapshot: RELEASE_POLICY.md hash changed"]);
  });

  it("fails publish gates when every snapshotted project rule file was removed", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    const agentRules = path.join(tmp, "AGENTS.md");
    await writeFile(agentRules, "Agent rules\n", "utf8");
    await startGoal(tmp, "ship", "Ship", ["publish readiness"]);
    await recordProjectRulesSnapshot(tmp, { goalSlug: "ship" });
    await rm(agentRules);
    await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Publish review", evidence: "package dry run checked" }], {
      stage: "publish",
    });

    const result = await evaluateStageGate(tmp, "ship", "publish");

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([
      "stale project-rule snapshot: snapshot includes 1 project rule file(s), but no local project rule files are currently detected",
    ]);
  });

  it("does not accept hand-written command evidence without ledger provenance", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await useFastRequiredCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    const evidenceDir = path.join(tmp, ".goal", "goals", "ship", "evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      path.join(evidenceDir, "forged.json"),
      JSON.stringify(
        {
          id: "forged",
          slug: "ship",
          kind: "command",
          created_at: "2026-07-08T00:00:00.000Z",
          command: [process.execPath, "-e", "process.exit(0)"],
          exit_code: 0,
          artifact_paths: [],
          redaction_applied: true,
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await canStopDone(tmp, "ship");

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["missing required evidence for command unit"]);
  });

  it("does not accept command evidence whose persisted sha no longer matches provenance", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await useFastRequiredCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    const evidence = await verifyCommand(tmp, "ship", "unit");
    await expect(canStopDone(tmp, "ship")).resolves.toEqual({ ok: true, reasons: [] });
    const evidenceFile = path.join(tmp, ".goal", "goals", "ship", "evidence", `${evidence.id}.json`);
    await writeFile(evidenceFile, JSON.stringify({ ...evidence, sha256: "forged" }, null, 2), "utf8");

    const result = await canStopDone(tmp, "ship");

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["missing required evidence for command unit"]);
  });

  it("does not accept command evidence whose artifact hash manifest was tampered", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await useFastRequiredCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    const evidence = await verifyCommand(tmp, "ship", "unit");
    await expect(canStopDone(tmp, "ship")).resolves.toEqual({ ok: true, reasons: [] });
    await writeFile(evidence.stdout_redacted_path!, "tampered\n", "utf8");

    const result = await canStopDone(tmp, "ship");

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["missing required evidence for command unit"]);
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

  it("does not accept a forged review file with only an allowed verdict", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await requireDoneReview(tmp);
    await useFastRequiredCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await verifyCommand(tmp, "ship", "unit");
    const reviewDir = path.join(tmp, ".goal", "goals", "ship", "reviews");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, "fake.json"), JSON.stringify({ verdict: "GO" }), "utf8");

    const result = await canStopDone(tmp, "ship");

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["missing admissible review verdict"]);
  });

  it("does not accept a self-hashed forged review without ledger provenance", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await requireDoneReview(tmp);
    await useFastRequiredCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await verifyCommand(tmp, "ship", "unit");
    const payload = {
      id: "forged",
      slug: "ship",
      verdict: "GO",
      reviewer: "human",
      created_at: "2026-07-08T00:00:00.000Z",
      findings: [{ severity: "minor", title: "Ready", evidence: "tests pass" }],
    };
    const reviewDir = path.join(tmp, ".goal", "goals", "ship", "reviews");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, "forged.json"),
      JSON.stringify({ ...payload, artifact_sha256: canonicalReviewSha256(payload) }, null, 2),
      "utf8",
    );

    const result = await canStopDone(tmp, "ship");

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["missing admissible review verdict"]);
  });

  it("does not accept a review whose signed payload slug does not match the goal", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await requireDoneReview(tmp);
    await useFastRequiredCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await verifyCommand(tmp, "ship", "unit");
    const payload = {
      id: "foreign",
      slug: "other",
      verdict: "GO",
      reviewer: "human",
      created_at: "2026-07-08T00:00:00.000Z",
      findings: [{ severity: "minor", title: "Ready", evidence: "tests pass" }],
    };
    const reviewDir = path.join(tmp, ".goal", "goals", "ship", "reviews");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, "foreign.json"),
      JSON.stringify({ ...payload, artifact_sha256: canonicalReviewSha256(payload) }, null, 2),
      "utf8",
    );

    const result = await canStopDone(tmp, "ship");

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["missing admissible review verdict"]);
  });

  it("does not accept a review whose persisted payload was tampered after hashing", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-gate-"));
    await writeDefaultGoalConfig(tmp);
    await requireDoneReview(tmp);
    await useFastRequiredCommand(tmp);
    await startGoal(tmp, "ship", "Ship", ["evidence"]);
    await verifyCommand(tmp, "ship", "unit");
    const review = await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Ready", evidence: "tests pass" }]);
    const reviewFile = path.join(tmp, ".goal", "goals", "ship", "reviews", `${review.id}.json`);
    await writeFile(reviewFile, JSON.stringify({ ...review, created_at: "2099-01-01T00:00:00.000Z" }, null, 2), "utf8");

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

async function requirePreflightReview(root: string): Promise<void> {
  const configPath = path.join(root, ".goal", "goal.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  config.gates.require_review_for = ["preflight"];
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

function canonicalReviewSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
