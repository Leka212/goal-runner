import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadGoalConfig } from "./config.js";
import { listVerifiedEvidence } from "./evidence.js";
import { readJsonFile } from "./fs.js";
import { listVerifiedReviews } from "./review.js";
import type { EvidenceRecord } from "./types.js";

export interface DoneGateResult {
  ok: boolean;
  reasons: string[];
}

export async function canStopDone(root: string, slug: string): Promise<DoneGateResult> {
  const config = await loadGoalConfig(root);
  const evidence = await listVerifiedEvidence(root, slug);
  const reviews = await listVerifiedReviews(root, slug);
  const reasons: string[] = [];

  for (const command of config.verification.commands.filter((item) => item.required_for_done)) {
    const found = evidence.some(
      (item) => item.kind === "command" && item.command?.join("\u0000") === command.argv.join("\u0000") && item.exit_code === 0,
    );
    if (!found) reasons.push(`missing required evidence for command ${command.id}`);
  }

  if (config.gates.require_review_for.includes("done")) {
    const allowed = new Set(config.gates.review_verdicts.allowed);
    if (!reviews.some((review) => allowed.has(review.verdict))) reasons.push("missing admissible review verdict");
  }

  return { ok: reasons.length === 0, reasons };
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
