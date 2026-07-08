import { randomUUID } from "node:crypto";
import { writeJsonFile } from "./fs.js";
import { recordEvent } from "./ledger.js";
import { goalRunDir } from "./paths.js";
import { validateBySchema } from "./schemas.js";
import type { EvidenceRecord } from "./types.js";

export async function addEvidence(root: string, record: Omit<EvidenceRecord, "id" | "created_at">): Promise<EvidenceRecord> {
  const full: EvidenceRecord = { ...record, id: randomUUID(), created_at: new Date().toISOString() };
  validateBySchema("evidence", full);

  const file = `${goalRunDir(root, full.slug)}/evidence/${full.id}.json`;
  await writeJsonFile(file, full);
  await recordEvent(root, {
    type: "evidence.added",
    slug: full.slug,
    data: { evidence_id: full.id, kind: full.kind, exit_code: full.exit_code },
  });

  return full;
}
