import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./fs.js";
import { readEvents, recordEvent } from "./ledger.js";
import { goalRunDir } from "./paths.js";
import { validateBySchema } from "./schemas.js";
import type { ReviewAddedEventData, ReviewStage, ReviewVerdict, ReviewVerdictValue } from "./types.js";

export interface AddReviewOptions {
  stage?: ReviewStage;
}

export async function addReview(
  root: string,
  slug: string,
  verdict: ReviewVerdictValue,
  reviewer: ReviewVerdict["reviewer"],
  findings: ReviewVerdict["findings"],
  options: AddReviewOptions = {},
): Promise<ReviewVerdict> {
  const id = randomUUID();
  const file = path.join(goalRunDir(root, slug), "reviews", `${id}.json`);
  const stage = options.stage ?? "done";
  const payload = {
    id,
    slug,
    stage,
    verdict,
    reviewer,
    created_at: new Date().toISOString(),
    findings,
  };
  const review = { ...payload, artifact_sha256: reviewArtifactSha256(payload) } satisfies ReviewVerdict;

  validateBySchema("review-verdict", review);
  await writeJsonFile(file, review);
  const eventData: ReviewAddedEventData = { review_id: id, stage, verdict, artifact_sha256: review.artifact_sha256 };
  await recordEvent(root, { type: "review.added", slug, data: eventData });

  return review;
}

export async function listVerifiedReviews(root: string, slug: string): Promise<ReviewVerdict[]> {
  const dir = path.join(goalRunDir(root, slug), "reviews");
  const provenance = await reviewProvenanceKeys(root, slug);
  try {
    const names = await readdir(dir);
    const reviews = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          try {
            const raw = await readJsonFile<unknown>(path.join(dir, name));
            validateBySchema("review-verdict", raw);
            const review = normalizeReview(raw);
            if (review.slug !== slug) return null;
            if (review.artifact_sha256 !== reviewArtifactSha256(raw)) return null;
            if (!provenance.has(reviewProvenanceKey(review))) return null;
            return review;
          } catch {
            return null;
          }
        }),
    );
    return reviews.filter((review): review is ReviewVerdict => review !== null);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}


async function reviewProvenanceKeys(root: string, slug: string): Promise<Set<string>> {
  const events = await readEvents(root);
  const provenance = new Set<string>();
  for (const event of events) {
    if (event.type !== "review.added" || event.slug !== slug) continue;
    const { review_id, stage, verdict, artifact_sha256 } = event.data;
    if (typeof review_id !== "string" || !isReviewVerdictValue(verdict) || typeof artifact_sha256 !== "string") continue;
    const reviewStage = stage === undefined ? "done" : stage;
    if (!isReviewStage(reviewStage)) continue;
    provenance.add(reviewProvenanceKeyFromParts(review_id, reviewStage, verdict, artifact_sha256));
  }
  return provenance;
}


function isReviewVerdictValue(value: unknown): value is ReviewVerdictValue {
  return value === "GO" || value === "NO-GO" || value === "GO-WITH-RISKS";
}

function isReviewStage(value: unknown): value is ReviewStage {
  return value === "preflight" || value === "done" || value === "publish" || value === "release" || value === "secrets" || value === "prod";
}

function normalizeReview(value: unknown): ReviewVerdict {
  if (!isRecord(value)) throw new Error("invalid review");
  const stage = value.stage === undefined ? "done" : value.stage;
  if (!isReviewStage(stage)) throw new Error("invalid review stage");
  return { ...value, stage } as ReviewVerdict;
}

function reviewProvenanceKey(review: Pick<ReviewVerdict, "id" | "stage" | "verdict" | "artifact_sha256">): string {
  return reviewProvenanceKeyFromParts(review.id, review.stage, review.verdict, review.artifact_sha256);
}

function reviewProvenanceKeyFromParts(reviewId: string, stage: ReviewStage, verdict: ReviewVerdictValue, artifactSha256: string): string {
  return `${reviewId}\u0000${stage}\u0000${verdict}\u0000${artifactSha256}`;
}

export function reviewArtifactSha256(value: unknown): string {
  if (!isRecord(value)) throw new Error("invalid review artifact");
  const { artifact_sha256: _discarded, ...payload } = value;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
