import { goalRunDir } from "./paths.js";
import { readJsonFile } from "./fs.js";
import type { GoalStatus } from "./types.js";

export interface GoalStatusSnapshot {
  slug: string;
  title: string;
  status: GoalStatus;
  acceptance: string[];
  created_at: string;
  stopped_at?: string;
}

export async function readGoalStatus(root: string, slug: string): Promise<GoalStatusSnapshot> {
  return readJsonFile<GoalStatusSnapshot>(`${goalRunDir(root, slug)}/goal.json`);
}
