import path from "node:path";
import { listVerifiedEvidence } from "./evidence.js";
import { readEvents } from "./ledger.js";
import { listVerifiedReviews } from "./review.js";
import type { EvidenceKind, EvidenceRecord, GoalEvent, GoalEventType, GoalStatus, ReviewVerdict, ReviewVerdictValue } from "./types.js";

export interface LedgerQueryOptions {
  slug?: string;
  status?: GoalStatus;
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
  verified: {
    evidence: LedgerQueryEvidenceSummary[];
    reviews: LedgerQueryReviewSummary[];
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

export interface LedgerQueryReviewSummary {
  id: string;
  verdict: ReviewVerdictValue;
  reviewer: ReviewVerdict["reviewer"];
  created_at: string;
  findings: ReviewVerdict["findings"];
  artifact_sha256: string;
}

export async function queryLedger(root: string, options: LedgerQueryOptions = {}): Promise<LedgerQueryResult> {
  const events = await readEvents(root);
  const goals: LedgerQueryGoal[] = [];

  for (const [slug, goalEvents] of groupEventsBySlug(events)) {
    const status = statusFromEvents(goalEvents);
    if (options.slug && slug !== options.slug) continue;
    if (options.status && status !== options.status) continue;

    const evidence = await listVerifiedEvidence(root, slug);
    const reviews = await listVerifiedReviews(root, slug);
    const outcome = outcomeFromEvents(goalEvents);

    goals.push({
      slug,
      title: titleFromEvents(goalEvents),
      status,
      outcome,
      acceptance: acceptanceFromEvents(goalEvents),
      event_count: goalEvents.length,
      event_types: eventTypes(goalEvents),
      last_event: summarizeEvent(goalEvents.at(-1)),
      verified: {
        evidence: evidence.sort(byCreatedAtThenId).map((record) => summarizeEvidence(root, record)),
        reviews: reviews.sort(byCreatedAtThenId).map(summarizeReview),
      },
      inferred: inferGoalSummary(slug, status, outcome, goalEvents),
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
  return outcomeFromEvents(events) ?? "active";
}

function outcomeFromEvents(events: GoalEvent[]): GoalStatus | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "goal.stopped") continue;
    const status = event.data.status;
    if (isGoalStatus(status)) return status;
  }
  return null;
}

function titleFromEvents(events: GoalEvent[]): string | null {
  for (const event of events) {
    if (event.type !== "goal.started") continue;
    if (typeof event.data.title === "string") return event.data.title;
  }
  return null;
}

function acceptanceFromEvents(events: GoalEvent[]): string[] {
  for (const event of events) {
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
    verdict: review.verdict,
    reviewer: review.reviewer,
    created_at: review.created_at,
    findings: review.findings.map((finding) => ({ ...finding })),
    artifact_sha256: review.artifact_sha256,
  };
}

function inferGoalSummary(
  slug: string,
  status: GoalStatus,
  outcome: GoalStatus | null,
  events: GoalEvent[],
): LedgerQueryGoal["inferred"] {
  const summary = outcome
    ? `[INFERENCE] ${slug} stopped with outcome ${outcome} after ${events.length} ledger event(s).`
    : `[INFERENCE] ${slug} is currently ${status} with ${events.length} ledger event(s).`;
  const priorFailure = outcome && outcome !== "done" ? `[INFERENCE] ${slug} previously ended as ${outcome}.` : null;
  return { summary, prior_failure: priorFailure };
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
