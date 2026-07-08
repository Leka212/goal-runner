import { readFileSync } from "node:fs";
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

const validRouteCard = {
  route: {
    category: "worker-wave",
    primary_capability: "implementation",
    supporting_tools: ["edit", "bash", "grep"],
    runtime: { engine: "codex", model: "gpt-5.5", effort: "high" },
    target: { workspace: "dev/goal-runner", machine: "local" },
    state_scope: { repo: "goal-runner", worktree: null, memory: ["memory://root/memory_summary.md"] },
    gates: { review: true, human_approval: false, prod: false, secrets: true, publish: false },
    evidence_required: [{ type: "test", command_or_url: "npm test -- tests/core/schema.test.ts" }],
    fallback: "stop and report blocker",
  },
};

const validWorkerCard = {
  id: "schema-worker",
  role: "Implementation Subagent",
  engine: "codex",
  workspace: "dev/goal-runner",
  objective: "Add planned schemas",
  files_or_systems: ["src/core/schemas.ts", "schemas"],
  non_goals: ["external API calls"],
  tools_allowed: ["edit", "bash", "grep"],
  gates: ["typecheck", "targeted tests"],
  acceptance: ["schemas validate planned artifacts"],
  output_contract: { required_sections: ["[FAIT]", "[VALIDÉ]", "[RISQUES]", "[NEXT]"] },
  timeout_seconds: 3600,
};

const validOssAudit = {
  subject: "Leka212",
  verified: ["GitHub profile observed"],
  unknown: ["registry downloads unknown"],
  inferred: ["[INFERENCE] package impact cannot be verified from local files"],
  unmet: ["No verified external merged PR count"],
  external_submission: false,
};

describe("schemas", () => {
  it("accepts valid core records", () => {
    expect(() => validateBySchema("goal-config", validConfig)).not.toThrow();
    expect(() => validateBySchema("goal-event", validEvent)).not.toThrow();
    expect(() => validateBySchema("evidence", validEvidence)).not.toThrow();
    expect(() => validateBySchema("review-verdict", validReview)).not.toThrow();
  });

  it("accepts valid planned route, worker, and OSS audit records", () => {
    expect(() => validateBySchema("route-card", validRouteCard)).not.toThrow();
    expect(() => validateBySchema("worker-card", validWorkerCard)).not.toThrow();
    expect(() => validateBySchema("oss-audit", validOssAudit)).not.toThrow();
  });

  it("rejects invalid planned records", () => {
    const invalid: unknown = { ...validRouteCard, route: { ...validRouteCard.route, category: "unsafe-prod" } };

    expect(() => validateBySchema("route-card", invalid)).toThrow(/route-card/);
  });

  it("loads schemas without Node 20.0-incompatible JSON import attributes", () => {
    const source = readFileSync(new URL("../../src/core/schemas.ts", import.meta.url), "utf8");

    expect(source).not.toContain('with { type: "json" }');
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
