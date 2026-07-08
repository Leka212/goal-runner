import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
