import { loadGoalConfig } from "./config.js";
import { listVerifiedEvidence } from "./evidence.js";
import { readEvents } from "./ledger.js";
import { listVerifiedReviews } from "./review.js";
import type {
  DoneGateEvidenceProvenance,
  DoneGateProvenance,
  DoneGateReviewProvenance,
  GoalConfig,
  GoalEvent,
  ReviewStage,
  ReviewVerdictValue,
} from "./types.js";

export interface DoneClaimAudit {
  event_id: string;
  sequence: number;
  slug: string;
  valid: boolean;
  reasons: string[];
}

export async function auditDoneClaims(root: string, events?: GoalEvent[]): Promise<DoneClaimAudit[]> {
  const ledger = events ?? (await readEvents(root));
  const config = await loadGoalConfig(root);
  const doneEvents = ledger.filter((event) => event.type === "goal.stopped" && event.data.status === "done");
  const audits: DoneClaimAudit[] = [];

  for (const event of doneEvents) {
    audits.push(await auditDoneClaim(root, config, event, ledger));
  }

  return audits;
}

async function auditDoneClaim(root: string, config: GoalConfig, event: GoalEvent, ledger: GoalEvent[]): Promise<DoneClaimAudit> {
  const reasons: string[] = [];
  const provenance = event.data.gate_provenance;

  if (!isDoneGateProvenance(provenance)) {
    return invalidDoneClaim(event, ["missing gate provenance"]);
  }

  if (Number.isNaN(Date.parse(provenance.checked_at))) {
    reasons.push("invalid gate provenance checked timestamp");
  }

  const evidence = await listVerifiedEvidence(root, event.slug);
  const evidenceLedgerKeys = evidenceLedgerProvenanceKeysAtOrBefore(ledger, event.slug, event.sequence);
  const evidenceById = new Map(evidence.map((record) => [record.id, record]));
  for (const reference of provenance.evidence) {
    const record = evidenceById.get(reference.id);
    if (!record || record.sha256 !== reference.sha256) {
      reasons.push(`referenced evidence ${reference.id} is missing or hash-mismatched`);
      continue;
    }
    if (!evidenceLedgerKeys.has(evidenceProvenanceKey(record))) {
      reasons.push(`referenced evidence ${reference.id} was recorded after done claim or lacks ledger provenance at done time`);
    }
  }

  const reviews = await listVerifiedReviews(root, event.slug);
  const reviewLedgerKeys = reviewLedgerProvenanceKeysAtOrBefore(ledger, event.slug, event.sequence);
  const reviewsById = new Map(reviews.map((review) => [review.id, review]));
  for (const reference of provenance.reviews) {
    const review = reviewsById.get(reference.id);
    const referenceStage = reference.stage ?? "done";
    if (!review || review.artifact_sha256 !== reference.artifact_sha256 || review.verdict !== reference.verdict || review.stage !== referenceStage) {
      reasons.push(`referenced review ${reference.id} is missing or hash-mismatched`);
      continue;
    }
    if (!reviewLedgerKeys.has(reviewProvenanceKey(review))) {
      reasons.push(`referenced review ${reference.id} was recorded after done claim or lacks ledger provenance at done time`);
    }
  }

  for (const command of config.verification.commands.filter((item) => item.required_for_done)) {
    const reference = provenance.evidence.find((item) => item.command_id === command.id);
    if (!reference) {
      reasons.push(`missing gate provenance for required evidence ${command.id}`);
      continue;
    }
    const record = evidenceById.get(reference.id);
    const satisfiesCommand =
      record?.kind === "command" &&
      record.command?.join("\u0000") === command.argv.join("\u0000") &&
      record.exit_code === 0 &&
      record.sha256 === reference.sha256 &&
      evidenceLedgerKeys.has(evidenceProvenanceKey(record));
    if (!satisfiesCommand) {
      reasons.push(`referenced evidence ${reference.id} no longer satisfies required command ${command.id}`);
    }
  }

  const allowed = new Set<ReviewVerdictValue>(config.gates.review_verdicts.allowed);
  for (const stage of doneReadinessReviewStages(config.gates.require_review_for)) {
    const hasAllowedReview = provenance.reviews.some((reference) => {
      const review = reviewsById.get(reference.id);
      const referenceStage = reference.stage ?? "done";
      return (
        review !== undefined &&
        review.stage === stage &&
        referenceStage === stage &&
        review.artifact_sha256 === reference.artifact_sha256 &&
        review.verdict === reference.verdict &&
        allowed.has(review.verdict) &&
        reviewLedgerKeys.has(reviewProvenanceKey(review))
      );
    });
    if (!hasAllowedReview) reasons.push(missingReviewProvenanceReason(stage));
  }

  return { event_id: event.id, sequence: event.sequence, slug: event.slug, valid: reasons.length === 0, reasons };
}

function evidenceLedgerProvenanceKeysAtOrBefore(ledger: GoalEvent[], slug: string, sequence: number): Set<string> {
  const provenance = new Set<string>();
  for (const event of ledger) {
    if (event.type !== "evidence.added" || event.slug !== slug || event.sequence > sequence) continue;
    const evidenceId = event.data.evidence_id;
    const kind = event.data.kind;
    const exitCode = event.data.exit_code;
    const sha256 = event.data.sha256;
    const artifactPaths = event.data.artifact_paths;
    if (typeof evidenceId !== "string" || typeof kind !== "string") continue;
    if (exitCode !== undefined && typeof exitCode !== "number") continue;
    if (sha256 !== undefined && typeof sha256 !== "string") continue;
    if (!isStringArray(artifactPaths)) continue;
    provenance.add(evidenceProvenanceKeyFromParts(evidenceId, kind, exitCode, sha256, artifactPaths));
  }
  return provenance;
}

function evidenceProvenanceKey(record: {
  id: string;
  kind: string;
  exit_code?: number;
  sha256?: string;
  artifact_paths: string[];
}): string {
  return evidenceProvenanceKeyFromParts(record.id, record.kind, record.exit_code, record.sha256, record.artifact_paths);
}

function evidenceProvenanceKeyFromParts(
  evidenceId: string,
  kind: string,
  exitCode: number | undefined,
  sha256: string | undefined,
  artifactPaths: string[],
): string {
  return JSON.stringify([evidenceId, kind, exitCode ?? null, sha256 ?? null, artifactPaths]);
}

function reviewLedgerProvenanceKeysAtOrBefore(ledger: GoalEvent[], slug: string, sequence: number): Set<string> {
  const provenance = new Set<string>();
  for (const event of ledger) {
    if (event.type !== "review.added" || event.slug !== slug || event.sequence > sequence) continue;
    const { review_id, stage, verdict, artifact_sha256 } = event.data;
    if (typeof review_id !== "string" || !isReviewVerdictValue(verdict) || typeof artifact_sha256 !== "string") continue;
    const reviewStage = stage === undefined ? "done" : stage;
    if (!isReviewStage(reviewStage)) continue;
    provenance.add(reviewProvenanceKeyFromParts(review_id, reviewStage, verdict, artifact_sha256));
  }
  return provenance;
}

function reviewProvenanceKey(review: { id: string; stage: ReviewStage; verdict: ReviewVerdictValue; artifact_sha256: string }): string {
  return reviewProvenanceKeyFromParts(review.id, review.stage, review.verdict, review.artifact_sha256);
}

function reviewProvenanceKeyFromParts(reviewId: string, stage: ReviewStage, verdict: ReviewVerdictValue, artifactSha256: string): string {
  return `${reviewId}\u0000${stage}\u0000${verdict}\u0000${artifactSha256}`;
}

function doneReadinessReviewStages(stages: ReviewStage[]): ReviewStage[] {
  return stages.filter((stage) => stage === "preflight" || stage === "done");
}

function missingReviewProvenanceReason(stage: ReviewStage): string {
  return stage === "done"
    ? "missing gate provenance for admissible review verdict"
    : `missing gate provenance for admissible ${stage} review verdict`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function invalidDoneClaim(event: GoalEvent, reasons: string[]): DoneClaimAudit {
  return { event_id: event.id, sequence: event.sequence, slug: event.slug, valid: false, reasons };
}

function isDoneGateProvenance(value: unknown): value is DoneGateProvenance {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.checked_at === "string" && isEvidenceReferences(record.evidence) && isReviewReferences(record.reviews);
}

function isEvidenceReferences(value: unknown): value is DoneGateEvidenceProvenance[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).command_id === "string" &&
        typeof (item as Record<string, unknown>).sha256 === "string",
    )
  );
}

function isReviewReferences(value: unknown): value is DoneGateReviewProvenance[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      const stage = record.stage ?? "done";
      return typeof record.id === "string" && isReviewStage(stage) && isReviewVerdictValue(record.verdict) && typeof record.artifact_sha256 === "string";
    })
  );
}

function isReviewVerdictValue(value: unknown): value is ReviewVerdictValue {
  return value === "GO" || value === "NO-GO" || value === "GO-WITH-RISKS";
}

function isReviewStage(value: unknown): value is ReviewStage {
  return value === "preflight" || value === "done" || value === "publish" || value === "release" || value === "secrets" || value === "prod";
}
