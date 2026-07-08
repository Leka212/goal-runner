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
    audits.push(await auditDoneClaim(root, config, event));
  }

  return audits;
}

async function auditDoneClaim(root: string, config: GoalConfig, event: GoalEvent): Promise<DoneClaimAudit> {
  const reasons: string[] = [];
  const provenance = event.data.gate_provenance;

  if (!isDoneGateProvenance(provenance)) {
    return invalidDoneClaim(event, ["missing gate provenance"]);
  }

  if (Number.isNaN(Date.parse(provenance.checked_at))) {
    reasons.push("invalid gate provenance checked timestamp");
  }

  const evidence = await listVerifiedEvidence(root, event.slug);
  const evidenceById = new Map(evidence.map((record) => [record.id, record]));
  for (const reference of provenance.evidence) {
    const record = evidenceById.get(reference.id);
    if (!record || record.sha256 !== reference.sha256) {
      reasons.push(`referenced evidence ${reference.id} is missing or hash-mismatched`);
    }
  }

  const reviews = await listVerifiedReviews(root, event.slug);
  const reviewsById = new Map(reviews.map((review) => [review.id, review]));
  for (const reference of provenance.reviews) {
    const review = reviewsById.get(reference.id);
    if (!review || review.artifact_sha256 !== reference.artifact_sha256 || review.verdict !== reference.verdict) {
      reasons.push(`referenced review ${reference.id} is missing or hash-mismatched`);
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
      record.sha256 === reference.sha256;
    if (!satisfiesCommand) {
      reasons.push(`referenced evidence ${reference.id} no longer satisfies required command ${command.id}`);
    }
  }

  if (config.gates.require_review_for.includes("done")) {
    const allowed = new Set<ReviewVerdictValue>(config.gates.review_verdicts.allowed);
    const hasAllowedReview = provenance.reviews.some((reference) => {
      const review = reviewsById.get(reference.id);
      return (
        review !== undefined &&
        review.artifact_sha256 === reference.artifact_sha256 &&
        review.verdict === reference.verdict &&
        allowed.has(review.verdict)
      );
    });
    if (!hasAllowedReview) reasons.push("missing gate provenance for admissible review verdict");
  }

  return { event_id: event.id, sequence: event.sequence, slug: event.slug, valid: reasons.length === 0, reasons };
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
      return typeof record.id === "string" && isReviewVerdictValue(record.verdict) && typeof record.artifact_sha256 === "string";
    })
  );
}

function isReviewVerdictValue(value: unknown): value is ReviewVerdictValue {
  return value === "GO" || value === "NO-GO" || value === "GO-WITH-RISKS";
}
