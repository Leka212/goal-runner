import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./fs.js";
import { recordEvent } from "./ledger.js";
import { goalRunDir } from "./paths.js";
import { validateBySchema } from "./schemas.js";
import type { ReviewVerdict, ReviewVerdictValue } from "./types.js";

export async function addReview(
  root: string,
  slug: string,
  verdict: ReviewVerdictValue,
  reviewer: ReviewVerdict["reviewer"],
  findings: ReviewVerdict["findings"],
): Promise<ReviewVerdict> {
  const id = randomUUID();
  const file = path.join(goalRunDir(root, slug), "reviews", `${id}.json`);
  const payload = {
    id,
    slug,
    verdict,
    reviewer,
    created_at: new Date().toISOString(),
    findings,
  };
  const review = { ...payload, artifact_sha256: reviewArtifactSha256(payload) } satisfies ReviewVerdict;

  validateBySchema("review-verdict", review);
  await writeJsonFile(file, review);
  await recordEvent(root, { type: "review.added", slug, data: { review_id: id, verdict } });

  return review;
}

export async function listVerifiedReviews(root: string, slug: string): Promise<ReviewVerdict[]> {
  const dir = path.join(goalRunDir(root, slug), "reviews");
  try {
    const names = await readdir(dir);
    const reviews = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          try {
            const review = await readJsonFile<unknown>(path.join(dir, name));
            validateBySchema("review-verdict", review);
            if (review.slug !== slug) return null;
            if (review.artifact_sha256 !== reviewArtifactSha256(review)) return null;
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

export function reviewArtifactSha256(value: Omit<ReviewVerdict, "artifact_sha256"> | ReviewVerdict): string {
  const { artifact_sha256: _discarded, ...payload } = value as ReviewVerdict;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
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
