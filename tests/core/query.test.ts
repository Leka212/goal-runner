import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { addEvidence } from "../../src/core/evidence.js";
import { startGoal, appendGoalStep, stopGoal } from "../../src/core/goals.js";
import { queryLedger } from "../../src/core/query.js";
import { addReview, reviewArtifactSha256 } from "../../src/core/review.js";
import { writeDefaultGoalConfig } from "../../src/core/config.js";
import { verifyCommand } from "../../src/core/verify.js";
import type { ReviewVerdict } from "../../src/core/types.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("queryLedger", () => {
  it("returns an empty goal list for an empty ledger", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-query-"));
    await writeDefaultGoalConfig(tmp);

    await expect(queryLedger(tmp)).resolves.toMatchObject({ goals: [] });
  });

  it("returns status, outcome, event, acceptance, evidence, and admissible review summaries for multiple goals", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-query-"));
    await writeDefaultGoalConfig(tmp);

    await startGoal(tmp, "ship", "Ship feature", ["tests pass", "reviewed"]);
    await appendGoalStep(tmp, "ship", "Implemented feature", "unit evidence");
    const evidence = await addEvidence(tmp, {
      slug: "ship",
      kind: "manual-attestation",
      artifact_paths: [],
      redaction_applied: true,
    });
    const review = await addReview(tmp, "ship", "GO", "human", [
      { severity: "minor", title: "Looks good", evidence: "verified locally" },
    ]);
    await stopGoal(tmp, "ship", "blocked");

    await startGoal(tmp, "docs", "Document feature", ["docs updated"]);

    const result = await queryLedger(tmp);

    expect(result.goals.map((goal) => goal.slug)).toEqual(["ship", "docs"]);
    expect(result.goals[0]).toMatchObject({
      slug: "ship",
      title: "Ship feature",
      status: "blocked",
      outcome: "blocked",
      event_count: 5,
      last_event: { type: "goal.stopped" },
      acceptance: ["tests pass", "reviewed"],
      verified: {
        evidence: [
          {
            id: evidence.id,
            kind: "manual-attestation",
            artifact_paths: [],
            redaction_applied: true,
          },
        ],
        reviews: [
          {
            id: review.id,
            verdict: "GO",
            reviewer: "human",
            stage: "done",
            findings: [{ severity: "minor", title: "Looks good", evidence: "verified locally" }],
          },
        ],
      },
    });
    expect(result.goals[0].inferred.summary).toContain("blocked");
    expect(result.goals[1]).toMatchObject({
      slug: "docs",
      status: "active",
      outcome: null,
      event_count: 1,
      last_event: { type: "goal.started" },
      acceptance: ["docs updated"],
      verified: { evidence: [], reviews: [] },
    });
  });

  it("exposes required preflight review state and reviewer verdict details", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-query-"));
    await writeDefaultGoalConfig(tmp);
    await requirePreflightReview(tmp);
    await startGoal(tmp, "ship", "Ship feature", ["spec reviewed"]);
    const review = await addReview(
      tmp,
      "ship",
      "GO",
      "adapter",
      [{ severity: "minor", title: "Spec ready", evidence: "preflight spec review passed" }],
      { stage: "preflight" },
    );
    await startGoal(tmp, "docs", "Document feature", ["docs updated"]);

    const result = await queryLedger(tmp);

    expect(result.goals[0]).toMatchObject({
      slug: "ship",
      verified: { reviews: [{ id: review.id, stage: "preflight", verdict: "GO", reviewer: "adapter" }] },
      preflight_review: {
        required: true,
        satisfied: true,
        review_id: review.id,
        stage: "preflight",
        verdict: "GO",
        reviewer: "adapter",
        artifact_sha256: review.artifact_sha256,
      },
    });
    expect(result.goals[1]).toMatchObject({
      slug: "docs",
      preflight_review: { required: true, satisfied: false, review_id: null, verdict: null, reviewer: null },
    });
  });

  it("excludes forged evidence and review files from verified query data", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-query-"));
    await writeDefaultGoalConfig(tmp);
    await startGoal(tmp, "ship", "Ship feature", ["tests pass"]);
    const verifiedEvidence = await addEvidence(tmp, {
      slug: "ship",
      kind: "manual-attestation",
      artifact_paths: [],
      redaction_applied: true,
    });
    const verifiedReview = await addReview(tmp, "ship", "GO-WITH-RISKS", "human", []);

    const evidenceDir = path.join(tmp, ".goal", "goals", "ship", "evidence");
    await writeFile(
      path.join(evidenceDir, "forged.json"),
      JSON.stringify({
        id: "forged-evidence",
        slug: "ship",
        kind: "manual-attestation",
        created_at: "2026-01-01T00:00:00.000Z",
        artifact_paths: [],
        redaction_applied: true,
      }),
      "utf8",
    );

    const forgedReviewPayload = {
      id: "forged-review",
      slug: "ship",
      verdict: "GO",
      reviewer: "human",
      created_at: "2026-01-01T00:00:00.000Z",
      findings: [{ severity: "minor", title: "Fake", evidence: "not in ledger" }],
    } satisfies Omit<ReviewVerdict, "artifact_sha256">;
    await mkdir(path.join(tmp, ".goal", "goals", "ship", "reviews"), { recursive: true });
    await writeFile(
      path.join(tmp, ".goal", "goals", "ship", "reviews", "forged.json"),
      JSON.stringify({ ...forgedReviewPayload, artifact_sha256: reviewArtifactSha256(forgedReviewPayload) }),
      "utf8",
    );

    const result = await queryLedger(tmp);

    expect(result.goals).toHaveLength(1);
    expect(result.goals[0].verified.evidence.map((item) => item.id)).toEqual([verifiedEvidence.id]);
    expect(result.goals[0].verified.reviews.map((item) => item.id)).toEqual([verifiedReview.id]);
  });

  it("filters goals by slug, status, repo, event type, evidence kind, review verdict, and time range", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-query-"));
    await writeDefaultGoalConfig(tmp);
    const configPath = path.join(tmp, ".goal", "goal.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace("  public_safe: true", "  repo: local/goal-runner\n  public_safe: true"), "utf8");
    await startGoal(tmp, "ship", "Ship feature", ["tests pass"]);
    await addEvidence(tmp, {
      slug: "ship",
      kind: "file",
      artifact_paths: [],
      redaction_applied: true,
    });
    await addReview(tmp, "ship", "NO-GO", "human", []);
    await stopGoal(tmp, "ship", "blocked");
    await startGoal(tmp, "docs", "Document feature", ["docs updated"]);

    await expect(queryLedger(tmp, { slug: "docs" })).resolves.toMatchObject({ goals: [{ slug: "docs" }] });
    await expect(queryLedger(tmp, { status: "blocked" })).resolves.toMatchObject({ goals: [{ slug: "ship" }] });
    await expect(queryLedger(tmp, { repo: "local/goal-runner" })).resolves.toMatchObject({
      goals: [{ slug: "ship" }, { slug: "docs" }],
    });
    await expect(queryLedger(tmp, { repo: "other/repo" })).resolves.toMatchObject({ goals: [] });
    await expect(queryLedger(tmp, { eventType: "review.added" })).resolves.toMatchObject({ goals: [{ slug: "ship" }] });
    await expect(queryLedger(tmp, { evidenceKind: "file" })).resolves.toMatchObject({ goals: [{ slug: "ship" }] });
    await expect(queryLedger(tmp, { evidenceKind: "command" })).resolves.toMatchObject({ goals: [] });
    await expect(queryLedger(tmp, { reviewVerdict: "NO-GO" })).resolves.toMatchObject({ goals: [{ slug: "ship" }] });
    await expect(queryLedger(tmp, { reviewVerdict: "GO" })).resolves.toMatchObject({ goals: [] });
    await expect(queryLedger(tmp, { from: "2100-01-01T00:00:00.000Z" })).resolves.toMatchObject({ goals: [] });
    await expect(queryLedger(tmp, { from: "1970-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" })).resolves.toMatchObject({
      goals: [{ slug: "ship" }, { slug: "docs" }],
    });
  });

  it("derives a restarted same-slug goal as active while preserving prior stopped failure history", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-query-"));
    await writeDefaultGoalConfig(tmp);
    await startGoal(tmp, "ship", "Ship feature", ["tests pass"]);
    await stopGoal(tmp, "ship", "blocked");
    await startGoal(tmp, "ship", "Ship feature retry", ["tests pass"]);

    const result = await queryLedger(tmp);

    expect(result.goals).toHaveLength(1);
    expect(result.goals[0]).toMatchObject({
      slug: "ship",
      title: "Ship feature retry",
      status: "active",
      outcome: null,
      outcomes: [{ status: "blocked" }],
      last_event: { type: "goal.started" },
      event_types: { "goal.started": 2, "goal.stopped": 1 },
    });
    expect(result.goals[0].inferred.prior_failure).toContain("blocked");
  });


  it("surfaces valid and invalid done-claim provenance", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-query-"));
    await writeDefaultGoalConfig(tmp);
    await configureGatedFastCommand(tmp);
    await startGoal(tmp, "ship", "Ship feature", ["tests pass"]);
    await verifyCommand(tmp, "ship", "unit");
    const review = await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Ready", evidence: "tests pass" }]);
    await stopGoal(tmp, "ship", "done");

    await expect(queryLedger(tmp, { slug: "ship" })).resolves.toMatchObject({
      goals: [{ done_claim: { valid: true, reasons: [] } }],
    });

    await writeFile(
      path.join(tmp, ".goal", "goals", "ship", "reviews", `${review.id}.json`),
      JSON.stringify({ ...review, findings: [] }, null, 2),
      "utf8",
    );

    await expect(queryLedger(tmp, { slug: "ship" })).resolves.toMatchObject({
      goals: [{ done_claim: { valid: false, reasons: expect.arrayContaining([expect.stringContaining("referenced review")]) } }],
    });
  });
  it("rejects a corrupted ledger instead of returning untrustworthy query data", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-query-"));
    await writeDefaultGoalConfig(tmp);
    await writeFile(path.join(tmp, ".goal", "events.jsonl"), "not-json\n", "utf8");

    await expect(queryLedger(tmp)).rejects.toThrow("invalid ledger line 1");
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

async function requirePreflightReview(root: string): Promise<void> {
  const configPath = path.join(root, ".goal", "goal.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  config.gates.require_review_for = ["preflight"];
  await writeFile(configPath, YAML.stringify(config), "utf8");
}
