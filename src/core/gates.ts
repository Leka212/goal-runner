import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadGoalConfig } from "./config.js";
import { listVerifiedEvidence } from "./evidence.js";
import { readJsonFile } from "./fs.js";
import { listVerifiedReviews } from "./review.js";
import type { DoneGateProvenance, EvidenceRecord, ReviewStage, ReviewVerdict } from "./types.js";

export interface DoneGateResult {
  ok: boolean;
  reasons: string[];
}

export interface DoneGateEvaluation extends DoneGateResult {
  provenance?: DoneGateProvenance;
}

export async function canStopDone(root: string, slug: string): Promise<DoneGateResult> {
  const { ok, reasons } = await evaluateDoneGate(root, slug);
  return { ok, reasons };
}

export async function evaluateDoneGate(root: string, slug: string): Promise<DoneGateEvaluation> {
  const config = await loadGoalConfig(root);
  const evidence = await listVerifiedEvidence(root, slug);
  const reviews = await listVerifiedReviews(root, slug);
  const reasons: string[] = [];
  const provenance: DoneGateProvenance = { checked_at: new Date().toISOString(), evidence: [], reviews: [] };

  for (const command of config.verification.commands.filter((item) => item.required_for_done)) {
    const found = evidence.find(
      (item) => item.kind === "command" && item.command?.join("\u0000") === command.argv.join("\u0000") && item.exit_code === 0,
    );
    if (!found) {
      reasons.push(`missing required evidence for command ${command.id}`);
      continue;
    }
    const reference = evidenceProvenanceReference(command.id, found);
    if (!reference) {
      reasons.push(`missing hash for required evidence ${found.id}`);
      continue;
    }
    provenance.evidence.push(reference);
  }

  const allowed = new Set(config.gates.review_verdicts.allowed);
  for (const stage of doneReadinessReviewStages(config.gates.require_review_for)) {
    const found = reviews.find((review) => review.stage === stage && allowed.has(review.verdict));
    if (!found) {
      reasons.push(missingReviewReason(stage));
    } else {
      provenance.reviews.push(reviewProvenanceReference(found));
    }
  }

  return reasons.length === 0 ? { ok: true, reasons, provenance } : { ok: false, reasons };
}

export async function listJson<T>(dir: string): Promise<T[]> {
  try {
    const names = await readdir(dir);
    return Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => readJsonFile<T>(path.join(dir, name))),
    );
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function evidenceProvenanceReference(commandId: string, evidence: EvidenceRecord): DoneGateProvenance["evidence"][number] | null {
  if (typeof evidence.sha256 !== "string") return null;
  return { id: evidence.id, command_id: commandId, sha256: evidence.sha256 };
}

function doneReadinessReviewStages(stages: ReviewStage[]): ReviewStage[] {
  return stages.filter((stage) => stage === "preflight" || stage === "done");
}

function missingReviewReason(stage: ReviewStage): string {
  return stage === "done" ? "missing admissible review verdict" : `missing admissible ${stage} review verdict`;
}

function reviewProvenanceReference(review: ReviewVerdict): DoneGateProvenance["reviews"][number] {
  return { id: review.id, stage: review.stage, verdict: review.verdict, artifact_sha256: review.artifact_sha256 };
}
