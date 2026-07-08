import { randomUUID } from "node:crypto";
import { fileSha256, writeJsonFile } from "./fs.js";
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
  const file = `${goalRunDir(root, slug)}/reviews/${id}.json`;
  const draft = {
    id,
    slug,
    verdict,
    reviewer,
    created_at: new Date().toISOString(),
    findings,
    artifact_sha256: "pending",
  } satisfies ReviewVerdict;

  validateBySchema("review-verdict", draft);
  await writeJsonFile(file, draft);

  const review = { ...draft, artifact_sha256: await fileSha256(file) } satisfies ReviewVerdict;
  validateBySchema("review-verdict", review);
  await writeJsonFile(file, review);
  await recordEvent(root, { type: "review.added", slug, data: { review_id: id, verdict } });

  return review;
}
