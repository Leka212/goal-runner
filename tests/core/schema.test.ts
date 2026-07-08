import { describe, expect, it } from "vitest";
import { validateBySchema } from "../../src/core/schemas.js";
import type { EvidenceRecord, GoalConfig, GoalEvent, ReviewVerdict } from "../../src/core/types.js";

const validConfig = {
  project: { name: "example", repo: "https://github.com/org/repo", public_safe: true },
  limits: {
    max_iterations: 8,
    max_minutes: 45,
    max_workers: 4,
    max_review_rounds: 3,
    stale_no_output_seconds: 900,
    require_explicit_next_decision: true,
    kill_switch_file: ".goal/KILL",
  },
  permissions: {
    default_tier: "read",
    tiers: ["read", "suggest", "comment", "branch", "release", "admin"],
    fork_pr_safe_mode: true,
  },
  verification: {
    commands: [
      {
        id: "unit",
        argv: ["npm", "test"],
        timeout_seconds: 120,
        required_for_done: true,
        redact: true,
        output_byte_cap: 20_000,
      },
    ],
  },
  gates: { require_review_for: ["publish"], review_verdicts: { allowed: ["GO", "GO-WITH-RISKS"] } },
  redaction: {
    deny_env_patterns: ["TOKEN"],
    deny_path_patterns: [".env"],
    deny_output_patterns: ["(?i)api[_-]?key"],
  },
  oss: { github_owner: "org", github_repo: "repo", registries: ["npm"], package_names: [] },
} satisfies GoalConfig;

const validEvent = {
  id: "evt_1",
  sequence: 1,
  type: "goal.started",
  slug: "ship",
  created_at: "2026-07-08T00:00:00.000Z",
  data: { title: "Ship" },
} satisfies GoalEvent;

const validEvidence = {
  id: "ev_1",
  slug: "ship",
  kind: "command",
  created_at: "2026-07-08T00:00:00.000Z",
  command: ["npm", "test"],
  exit_code: 0,
  artifact_paths: [],
  redaction_applied: true,
} satisfies EvidenceRecord;

const validReview = {
  id: "rev_1",
  slug: "ship",
  verdict: "GO",
  reviewer: "human",
  created_at: "2026-07-08T00:00:00.000Z",
  findings: [{ severity: "important", title: "Unit tests", evidence: "npm test passed" }],
  artifact_sha256: "a".repeat(64),
} satisfies ReviewVerdict;

describe("schemas", () => {
  it("accepts valid core records", () => {
    expect(() => validateBySchema("goal-config", validConfig)).not.toThrow();
    expect(() => validateBySchema("goal-event", validEvent)).not.toThrow();
    expect(() => validateBySchema("evidence", validEvidence)).not.toThrow();
    expect(() => validateBySchema("review-verdict", validReview)).not.toThrow();
  });

  it("rejects shell-string verification commands", () => {
    const invalid: unknown = {
      ...validConfig,
      verification: {
        commands: [{ ...validConfig.verification.commands[0], argv: "npm test" }],
      },
    };

    expect(() => validateBySchema("goal-config", invalid)).toThrow(/goal-config/);
  });

  it("rejects extra properties on event records", () => {
    const invalid: unknown = { ...validEvent, provider: "claude" };

    expect(() => validateBySchema("goal-event", invalid)).toThrow(/goal-event/);
  });
});
