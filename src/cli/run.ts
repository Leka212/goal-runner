import { Command } from "commander";
import { buildDashboard } from "../core/dashboard.js";
import { addReview } from "../core/review.js";
import { writeDefaultGoalConfig } from "../core/config.js";
import { doctor } from "../core/doctor.js";
import { appendGoalStep, startGoal, stopGoal } from "../core/goals.js";
import { readGoalStatus } from "../core/status.js";
import { verifyCommand } from "../core/verify.js";
import type { GoalStatus, ReviewVerdict, ReviewVerdictValue } from "../core/types.js";

const goalStatuses = ["active", "done", "blocked", "reverted", "abandoned"] as const satisfies readonly GoalStatus[];
const reviewVerdicts = ["GO", "NO-GO", "GO-WITH-RISKS"] as const satisfies readonly ReviewVerdictValue[];
const reviewers = ["human", "adapter", "command"] as const satisfies readonly ReviewVerdict["reviewer"][];

export async function runCli(argv: string[], cwd = process.cwd()): Promise<number> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  let exitCode = 0;
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

  program
    .command("verify")
    .argument("<slug>")
    .requiredOption("--command <id>")
    .action(async (slug: string, options: { command: string }) => {
      const evidence = await verifyCommand(cwd, slug, options.command);
      exitCode = evidence.exit_code ?? 0;
    });

  program
    .command("review")
    .argument("<slug>")
    .requiredOption("--verdict <verdict>")
    .option("--reviewer <reviewer>", "reviewer source", "human")
    .action(async (slug: string, options: { verdict: string; reviewer: string }) => {
      if (!isReviewVerdict(options.verdict)) throw new Error(`invalid review verdict: ${options.verdict}`);
      if (!isReviewer(options.reviewer)) throw new Error(`invalid reviewer: ${options.reviewer}`);
      await addReview(cwd, slug, options.verdict, options.reviewer, []);
    });

  program.command("dashboard").action(async () => {
    await buildDashboard(cwd);
  });

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch {
    return 1;
  }
}

function isGoalStatus(value: string): value is GoalStatus {
  return goalStatuses.includes(value as GoalStatus);
}

function isReviewVerdict(value: string): value is ReviewVerdictValue {
  return reviewVerdicts.includes(value as ReviewVerdictValue);
}

function isReviewer(value: string): value is ReviewVerdict["reviewer"] {
  return reviewers.includes(value as ReviewVerdict["reviewer"]);
}
