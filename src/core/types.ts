export type GoalStatus = "active" | "done" | "blocked" | "reverted" | "abandoned";
export type GoalEventType = "goal.started" | "goal.step" | "goal.stopped" | "evidence.added" | "review.added" | "gate.added" | "decision.recorded";
export type PermissionTier = "read" | "suggest" | "comment" | "branch" | "release" | "admin";
export type ReviewVerdictValue = "GO" | "NO-GO" | "GO-WITH-RISKS";
export type ReviewStage = "preflight" | "done" | "publish" | "release" | "secrets" | "prod";
export type EvidenceKind = "command" | "file" | "url" | "screenshot" | "artifact" | "manual-attestation";

export interface VerificationCommand {
  id: string;
  argv: string[];
  timeout_seconds: number;
  required_for_done: boolean;
  redact: boolean;
  output_byte_cap: number;
}

export interface GoalConfig {
  project: { name: string; repo?: string; public_safe: boolean };
  limits: {
    max_iterations: number;
    max_minutes: number;
    max_workers: number;
    max_review_rounds: number;
    stale_no_output_seconds: number;
    require_explicit_next_decision: boolean;
    kill_switch_file: string;
  };
  permissions: {
    default_tier: PermissionTier;
    tiers: PermissionTier[];
    fork_pr_safe_mode: boolean;
  };
  verification: { commands: VerificationCommand[] };
  gates: {
    require_review_for: ReviewStage[];
    review_verdicts: { allowed: ReviewVerdictValue[] };
  };
  redaction: {
    deny_env_patterns: string[];
    deny_path_patterns: string[];
    deny_output_patterns: string[];
  };
  oss?: { github_owner?: string; github_repo?: string; registries?: string[]; package_names?: string[] };
}

export interface GoalEvent {
  id: string;
  sequence: number;
  type: GoalEventType;
  slug: string;
  created_at: string;
  data: Record<string, unknown>;
}

export interface ReviewAddedEventData extends Record<string, unknown> {
  review_id: string;
  stage: ReviewStage;
  verdict: ReviewVerdictValue;
  artifact_sha256: string;
}

export interface EvidenceAddedEventData extends Record<string, unknown> {
  evidence_id: string;
  kind: EvidenceKind;
  exit_code?: number;
  sha256?: string;
  artifact_paths: string[];
}

export interface EvidenceRecord {
  id: string;
  slug: string;
  kind: EvidenceKind;
  created_at: string;
  command?: string[];
  exit_code?: number;
  stdout_redacted_path?: string;
  stderr_redacted_path?: string;
  artifact_paths: string[];
  sha256?: string;
  redaction_applied: boolean;
}

export interface ReviewVerdict {
  id: string;
  stage: ReviewStage;
  slug: string;
  verdict: ReviewVerdictValue;
  reviewer: "human" | "adapter" | "command";
  created_at: string;
  findings: Array<{ severity: "critical" | "important" | "minor"; title: string; evidence: string }>;
  artifact_sha256: string;
}

export interface DoneGateEvidenceProvenance {
  id: string;
  command_id: string;
  sha256: string;
}

export interface DoneGateReviewProvenance {
  id: string;
  stage?: ReviewStage;
  verdict: ReviewVerdictValue;
  artifact_sha256: string;
}

export interface DoneGateProvenance {
  checked_at: string;
  evidence: DoneGateEvidenceProvenance[];
  reviews: DoneGateReviewProvenance[];
}

export interface RouteCard {
  route: {
    category: "direct" | "mission" | "worker-wave" | "review" | "research" | "skill-capability" | "publish-gated";
    primary_capability: string;
    supporting_tools: string[];
    runtime: { engine: string; model: string | null; effort: string | null };
    target: { workspace: string; machine: "local" | "remote" | "unknown" };
    state_scope: { repo: string | null; worktree: string | null; memory: string[] };
    gates: { review: boolean; human_approval: boolean; prod: boolean; secrets: boolean; publish: boolean };
    evidence_required: Array<{ type: string; command_or_url: string | null }>;
    fallback: string;
  };
}

export interface WorkerCard {
  id: string;
  role: string;
  engine: string;
  workspace: string;
  objective: string;
  files_or_systems: string[];
  non_goals: string[];
  tools_allowed: string[];
  gates: string[];
  acceptance: string[];
  output_contract: { required_sections: string[] };
  timeout_seconds: number;
}

export interface OssAudit {
  subject: string;
  verified: string[];
  unknown: string[];
  inferred: string[];
  unmet: string[];
  external_submission: false;
}
