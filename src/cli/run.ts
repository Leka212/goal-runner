import { Command } from "commander";
import { writeDefaultGoalConfig } from "../core/config.js";
import { doctor } from "../core/doctor.js";
import { appendGoalStep, startGoal, stopGoal } from "../core/goals.js";
import { readGoalStatus } from "../core/status.js";
import type { GoalStatus } from "../core/types.js";

const goalStatuses = ["active", "done", "blocked", "reverted", "abandoned"] as const satisfies readonly GoalStatus[];

export async function runCli(argv: string[], cwd = process.cwd()): Promise<number> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  program.name("goal");

  program.command("init").action(async () => {
    await writeDefaultGoalConfig(cwd);
  });

  program
    .command("start")
    .argument("<slug>")
    .argument("<title>")
    .option("--acceptance <item>", "acceptance criterion", (value, previous: string[]) => [...previous, value], [] as string[])
    .action(async (slug: string, title: string, options: { acceptance: string[] }) => {
      await startGoal(cwd, slug, title, options.acceptance.length > 0 ? options.acceptance : ["goal has evidence"]);
    });

  program
    .command("step")
    .argument("<slug>")
    .argument("<summary>")
    .requiredOption("--evidence <text>")
    .action(async (slug: string, summary: string, options: { evidence: string }) => {
      await appendGoalStep(cwd, slug, summary, options.evidence);
    });

  program.command("status").argument("<slug>").action(async (slug: string) => {
    await readGoalStatus(cwd, slug);
  });

  program
    .command("stop")
    .argument("<slug>")
    .requiredOption("--status <status>")
    .action(async (slug: string, options: { status: string }) => {
      if (!isGoalStatus(options.status)) throw new Error(`invalid status: ${options.status}`);
      await stopGoal(cwd, slug, options.status);
    });

  program.command("doctor").action(async () => {
    const result = await doctor(cwd);
    if (!result.ok) throw new Error(result.errors.join("; "));
  });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch {
    return 1;
  }
}

function isGoalStatus(value: string): value is GoalStatus {
  return goalStatuses.includes(value as GoalStatus);
}
