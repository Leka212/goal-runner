import { access } from "node:fs/promises";
import path from "node:path";
import { loadGoalConfig } from "./config.js";
import { readEvents } from "./ledger.js";

export interface DoctorResult {
  ok: boolean;
  errors: string[];
}

export async function doctor(root: string): Promise<DoctorResult> {
  const errors: string[] = [];

  try {
    await access(path.join(root, ".goal", "goal.yaml"));
  } catch {
    errors.push("missing .goal/goal.yaml");
  }

  try {
    await loadGoalConfig(root);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`invalid config: ${message}`);
  }

  try {
    await readEvents(root);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`invalid event ledger: ${message}`);
  }

  return { ok: errors.length === 0, errors };
}
