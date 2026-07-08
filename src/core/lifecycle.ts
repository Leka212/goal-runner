import { appendLine, ensureDir, readJsonFile, writeJsonFile } from "./fs.js";
import { goalRunDir, resolveGoalPaths } from "./paths.js";
import { recordEvent } from "./ledger.js";
import type { GoalStatus } from "./types.js";

interface GoalState {
  slug: string;
  title: string;
  acceptance: string[];
  status: GoalStatus;
  created_at: string;
  stopped_at?: string;
}

export async function startGoal(root: string, slug: string, title: string, acceptance: string[]): Promise<void> {
  const dir = goalRunDir(root, slug);
  await ensureDir(dir);
  const createdAt = new Date().toISOString();
  await writeJsonFile(`${dir}/goal.json`, { slug, title, acceptance, status: "active", created_at: createdAt } satisfies GoalState);
  await recordEvent(root, { type: "goal.started", slug, data: { title, acceptance } });
  await appendLine(
    resolveGoalPaths(root).humanLogFile,
    `\n## ${slug}: ${title}\n\nStatus: active\n\nAcceptance:\n${acceptance.map((item) => `- ${item}`).join("\n")}\n`,
  );
}

export async function recordStep(root: string, slug: string, summary: string, evidenceExpected: string): Promise<void> {
  await recordEvent(root, { type: "goal.step", slug, data: { summary, evidence_expected: evidenceExpected } });
  await appendLine(resolveGoalPaths(root).humanLogFile, `\n- Step: ${summary}\n  Evidence expected: ${evidenceExpected}\n`);
}

export async function stopGoal(root: string, slug: string, status: GoalStatus): Promise<void> {
  await recordEvent(root, { type: "goal.stopped", slug, data: { status } });
  await persistStoppedGoal(root, slug, status);
  await appendLine(resolveGoalPaths(root).humanLogFile, `\n- Stop: ${slug} -> ${status}\n`);
}

async function persistStoppedGoal(root: string, slug: string, status: GoalStatus): Promise<void> {
  const file = `${goalRunDir(root, slug)}/goal.json`;
  try {
    const goal = await readJsonFile<GoalState>(file);
    await writeJsonFile(file, { ...goal, status, stopped_at: new Date().toISOString() } satisfies GoalState);
  } catch (error: unknown) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }
}

