import path from "node:path";
import { listVerifiedEvidence } from "./evidence.js";
import { loadGoalConfig } from "./config.js";
import { readEvents } from "./ledger.js";
import { listVerifiedReviews } from "./review.js";
import { auditDoneClaims, type DoneClaimAudit } from "./done-claims.js";
import type { EvidenceKind, EvidenceRecord, GoalConfig, GoalEvent, GoalEventType, GoalStatus, ReviewStage, ReviewVerdict, ReviewVerdictValue } from "./types.js";

export interface LedgerQueryOptions {
  slug?: string;
  status?: GoalStatus;
  repo?: string;
  eventType?: GoalEventType;
  evidenceKind?: EvidenceKind;
  reviewVerdict?: ReviewVerdictValue;
  from?: string;
  to?: string;
}

export interface LedgerQueryResult {
  generated_at: string;
  filters: LedgerQueryOptions;
  goals: LedgerQueryGoal[];
}

export interface LedgerQueryGoal {
  slug: string;
  title: string | null;
  status: GoalStatus;
  outcome: GoalStatus | null;
  acceptance: string[];
  event_count: number;
  event_types: Partial<Record<GoalEventType, number>>;
  last_event: LedgerQueryEventSummary | null;
  outcomes: LedgerQueryOutcomeSummary[];
  verified: {
    evidence: LedgerQueryEvidenceSummary[];
    reviews: LedgerQueryReviewSummary[];
  };
  preflight_review: LedgerQueryPreflightReviewSummary;
  done_claim: {
    valid: boolean | null;
    reasons: string[];
  };
  inferred: {
    summary: string;
    prior_failure: string | null;
  };
}

export interface LedgerQueryEventSummary {
  sequence: number;
  type: GoalEventType;
  created_at: string;
}

export interface LedgerQueryOutcomeSummary {
  sequence: number;
  status: GoalStatus;
  created_at: string;
}

export interface LedgerQueryEvidenceSummary {
  id: string;
  kind: EvidenceKind;
  created_at: string;
  command?: string[];
  exit_code?: number;
  artifact_paths: string[];
  stdout_redacted_path?: string;
  stderr_redacted_path?: string;
  sha256?: string;
  redaction_applied: boolean;
}

export interface LedgerQueryPreflightReviewSummary {
  required: boolean;
  satisfied: boolean;
  review_id: string | null;
  stage: "preflight" | null;
  verdict: ReviewVerdictValue | null;
  reviewer: ReviewVerdict["reviewer"] | null;
  created_at: string | null;
  artifact_sha256: string | null;
}

export interface LedgerQueryReviewSummary {
  id: string;
  stage: ReviewStage;
  verdict: ReviewVerdictValue;
  reviewer: ReviewVerdict["reviewer"];
  created_at: string;
  findings: ReviewVerdict["findings"];
  artifact_sha256: string;
}

export async function queryLedger(root: string, options: LedgerQueryOptions = {}): Promise<LedgerQueryResult> {
  const events = await readEvents(root);
  const doneClaimAudits = await auditDoneClaims(root, events);
  const config = await loadGoalConfig(root);
  const goals: LedgerQueryGoal[] = [];
  const from = parseOptionalTimeBoundary(options.from, "from");
  const to = parseOptionalTimeBoundary(options.to, "to");
  if (from !== undefined && to !== undefined && from > to) throw new Error("invalid time range: from must be before or equal to to");

  if (options.repo) {
    const repo = repoFromConfig(config);
    if (repo !== options.repo) {
      return {
        generated_at: new Date().toISOString(),
        filters: { ...options },
        goals: [],
      };
    }
  }

  for (const [slug, goalEvents] of groupEventsBySlug(events)) {
    const status = statusFromEvents(goalEvents);
    if (options.slug && slug !== options.slug) continue;
    if (options.status && status !== options.status) continue;
    if (options.eventType && !goalEvents.some((event) => event.type === options.eventType)) continue;
    if (!eventsOverlapTimeRange(goalEvents, from, to)) continue;

    const evidence = await listVerifiedEvidence(root, slug);
    if (options.evidenceKind && !evidence.some((record) => record.kind === options.evidenceKind)) continue;

    const reviews = await listVerifiedReviews(root, slug);
    if (options.reviewVerdict && !reviews.some((review) => review.verdict === options.reviewVerdict)) continue;

    const outcome = currentOutcomeFromEvents(goalEvents);
    const outcomes = outcomeHistoryFromEvents(goalEvents);

    goals.push({
      slug,
      title: titleFromEvents(goalEvents),
      status,
      outcome,
      acceptance: acceptanceFromEvents(goalEvents),
      event_count: goalEvents.length,
      event_types: eventTypes(goalEvents),
      last_event: summarizeEvent(goalEvents.at(-1)),
      outcomes,
      verified: {
        evidence: evidence.sort(byCreatedAtThenId).map((record) => summarizeEvidence(root, record)),
        reviews: reviews.sort(byCreatedAtThenId).map(summarizeReview),
      },
      preflight_review: summarizePreflightReview(reviews, config),
      done_claim: summarizeDoneClaim(goalEvents, doneClaimAudits),
      inferred: inferGoalSummary(slug, status, outcome, outcomes, goalEvents),
    });
  }

  return {
    generated_at: new Date().toISOString(),
    filters: { ...options },
    goals,
  };
}

function groupEventsBySlug(events: GoalEvent[]): Map<string, GoalEvent[]> {
  const grouped = new Map<string, GoalEvent[]>();
  for (const event of events) {
    const existing = grouped.get(event.slug);
    if (existing) existing.push(event);
    else grouped.set(event.slug, [event]);
  }
  return grouped;
}

function statusFromEvents(events: GoalEvent[]): GoalStatus {
  const lifecycleEvent = latestLifecycleEvent(events);
  if (lifecycleEvent?.type === "goal.stopped") {
    const status = lifecycleEvent.data.status;
    if (isGoalStatus(status)) return status;
  }
  return "active";
}

function currentOutcomeFromEvents(events: GoalEvent[]): GoalStatus | null {
  const lifecycleEvent = latestLifecycleEvent(events);
  if (lifecycleEvent?.type !== "goal.stopped") return null;
  const status = lifecycleEvent.data.status;
  return isGoalStatus(status) ? status : null;
}

function outcomeHistoryFromEvents(events: GoalEvent[]): LedgerQueryOutcomeSummary[] {
  return events.flatMap((event) => {
    if (event.type !== "goal.stopped") return [];
    const status = event.data.status;
    return isGoalStatus(status) ? [{ sequence: event.sequence, status, created_at: event.created_at }] : [];
  });
}

function titleFromEvents(events: GoalEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "goal.started") continue;
    if (typeof event.data.title === "string") return event.data.title;
  }
  return null;
}

function acceptanceFromEvents(events: GoalEvent[]): string[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "goal.started") continue;
    if (Array.isArray(event.data.acceptance) && event.data.acceptance.every((item) => typeof item === "string")) {
      return [...event.data.acceptance];
    }
  }
  return [];
}

function eventTypes(events: GoalEvent[]): Partial<Record<GoalEventType, number>> {
  const counts: Partial<Record<GoalEventType, number>> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function summarizeEvent(event: GoalEvent | undefined): LedgerQueryEventSummary | null {
  if (!event) return null;
  return { sequence: event.sequence, type: event.type, created_at: event.created_at };
}

function summarizeEvidence(root: string, record: EvidenceRecord): LedgerQueryEvidenceSummary {
  const summary: LedgerQueryEvidenceSummary = {
    id: record.id,
    kind: record.kind,
    created_at: record.created_at,
    artifact_paths: record.artifact_paths.map((item) => workspaceRelativePath(root, item)),
    redaction_applied: record.redaction_applied,
  };
  if (record.command) summary.command = [...record.command];
  if (typeof record.exit_code === "number") summary.exit_code = record.exit_code;
  if (record.stdout_redacted_path) summary.stdout_redacted_path = workspaceRelativePath(root, record.stdout_redacted_path);
  if (record.stderr_redacted_path) summary.stderr_redacted_path = workspaceRelativePath(root, record.stderr_redacted_path);
  if (record.sha256) summary.sha256 = record.sha256;
  return summary;
}

function summarizeReview(review: ReviewVerdict): LedgerQueryReviewSummary {
  return {
    id: review.id,
    stage: review.stage,
    verdict: review.verdict,
    reviewer: review.reviewer,
    created_at: review.created_at,
    findings: review.findings.map((finding) => ({ ...finding })),
    artifact_sha256: review.artifact_sha256,
  };
}

function summarizePreflightReview(reviews: ReviewVerdict[], config: GoalConfig): LedgerQueryPreflightReviewSummary {
  const allowed = new Set(config.gates.review_verdicts.allowed);
  const preflightReviews = reviews.filter((review) => review.stage === "preflight").sort(byCreatedAtThenId);
  const admissible = [...preflightReviews].reverse().find((review) => allowed.has(review.verdict));
  const displayed = admissible ?? preflightReviews.at(-1);
  return {
    required: config.gates.require_review_for.includes("preflight"),
    satisfied: admissible !== undefined,
    review_id: displayed?.id ?? null,
    stage: displayed ? "preflight" : null,
    verdict: displayed?.verdict ?? null,
    reviewer: displayed?.reviewer ?? null,
    created_at: displayed?.created_at ?? null,
    artifact_sha256: displayed?.artifact_sha256 ?? null,
  };
}

function summarizeDoneClaim(events: GoalEvent[], audits: DoneClaimAudit[]): LedgerQueryGoal["done_claim"] {
  const latestDoneEvent = [...events].reverse().find((event) => event.type === "goal.stopped" && event.data.status === "done");
  if (!latestDoneEvent) return { valid: null, reasons: [] };
  const audit = audits.find((item) => item.sequence === latestDoneEvent.sequence);
  if (!audit) return { valid: false, reasons: ["missing done-claim audit"] };
  return { valid: audit.valid, reasons: audit.reasons };
}

function inferGoalSummary(
  slug: string,
  status: GoalStatus,
  outcome: GoalStatus | null,
  outcomes: LedgerQueryOutcomeSummary[],
  events: GoalEvent[],
): LedgerQueryGoal["inferred"] {
  const summary = outcome
    ? `[INFERENCE] ${slug} stopped with outcome ${outcome} after ${events.length} ledger event(s).`
    : `[INFERENCE] ${slug} is currently ${status} with ${events.length} ledger event(s).`;
  const priorFailure = [...outcomes].reverse().find((item) => item.status !== "done");
  return {
    summary,
    prior_failure: priorFailure
      ? `[INFERENCE] ${slug} ${outcome === priorFailure.status ? "ended" : "previously ended"} as ${priorFailure.status}.`
      : null,
  };
}

function workspaceRelativePath(root: string, file: string): string {
  if (!path.isAbsolute(file)) return file;
  const relative = path.relative(root, file);
  if (relative === "") return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return file;
}

function byCreatedAtThenId<T extends { created_at: string; id: string }>(left: T, right: T): number {
  return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "done" || value === "blocked" || value === "reverted" || value === "abandoned";
}

function latestLifecycleEvent(events: GoalEvent[]): GoalEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "goal.started" || event.type === "goal.stopped") return event;
  }
  return null;
}

function parseOptionalTimeBoundary(value: string | undefined, name: "from" | "to"): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`invalid ${name}: ${value}`);
  return parsed;
}

function eventsOverlapTimeRange(events: GoalEvent[], from: number | undefined, to: number | undefined): boolean {
  if (from === undefined && to === undefined) return true;
  return events.some((event) => {
    const timestamp = Date.parse(event.created_at);
    if (Number.isNaN(timestamp)) return false;
    if (from !== undefined && timestamp < from) return false;
    if (to !== undefined && timestamp > to) return false;
    return true;
  });
}


function repoFromConfig(config: GoalConfig): string | null {
  if (config.project.repo) return config.project.repo;
  if (config.oss?.github_owner && config.oss.github_repo) return `${config.oss.github_owner}/${config.oss.github_repo}`;
  return null;
}

