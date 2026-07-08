import path from "node:path";

export interface GoalPaths {
  root: string;
  goalDir: string;
  eventsFile: string;
  dashboardFile: string;
  humanLogFile: string;
}

export function resolveGoalPaths(root: string): GoalPaths {
  const goalDir = path.join(root, ".goal");
  return {
    root,
    goalDir,
    eventsFile: path.join(goalDir, "events.jsonl"),
    dashboardFile: path.join(goalDir, "dashboard.json"),
    humanLogFile: path.join(root, "GOALS.md"),
  };
}

export function goalRunDir(root: string, slug: string): string {
  return path.join(root, ".goal", "goals", slug);
}
