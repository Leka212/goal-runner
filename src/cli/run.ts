import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { getAdapter, listAdapters } from "../adapters/index.js";
import { buildDashboard } from "../core/dashboard.js";
import { queryLedger } from "../core/query.js";
import { addReview } from "../core/review.js";
import { writeDefaultGoalConfig } from "../core/config.js";
import { doctor } from "../core/doctor.js";
import { ensureDir, writeJsonFile } from "../core/fs.js";
import { appendGoalStep, startGoal, stopGoal } from "../core/goals.js";
import { readGoalStatus } from "../core/status.js";
import { detectPublishLeaks } from "../core/redaction.js";
import { buildStatusReport } from "../core/status-report.js";
import { verifyCommand } from "../core/verify.js";
import { buildClaudeForOssDossier } from "../oss/dossier.js";
import { validateBySchema } from "../core/schemas.js";
import type { EvidenceKind, GoalEventType, GoalStatus, OssAudit, ReviewStage, ReviewVerdict, ReviewVerdictValue } from "../core/types.js";

const goalEventTypes = ["goal.started", "goal.step", "goal.stopped", "evidence.added", "review.added", "gate.added", "decision.recorded"] as const satisfies readonly GoalEventType[];
const evidenceKinds = ["command", "file", "url", "screenshot", "artifact", "manual-attestation"] as const satisfies readonly EvidenceKind[];
const goalStatuses = ["active", "done", "blocked", "reverted", "abandoned"] as const satisfies readonly GoalStatus[];
const reviewVerdicts = ["GO", "NO-GO", "GO-WITH-RISKS"] as const satisfies readonly ReviewVerdictValue[];
const reviewStages = ["preflight", "done", "publish", "release", "secrets", "prod"] as const satisfies readonly ReviewStage[];
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
    .option("--stage <stage>", "review stage", "done")
    .action(async (slug: string, options: { verdict: string; reviewer: string; stage: string }) => {
      if (!isReviewVerdict(options.verdict)) throw new Error(`invalid review verdict: ${options.verdict}`);
      if (!isReviewer(options.reviewer)) throw new Error(`invalid reviewer: ${options.reviewer}`);
      if (!isReviewStage(options.stage)) throw new Error(`invalid review stage: ${options.stage}`);
      await addReview(cwd, slug, options.verdict, options.reviewer, [], { stage: options.stage });
    });

  program.command("dashboard").action(async () => {
    await buildDashboard(cwd);
  });

  program
    .command("status-report")
    .option("--out <path>", "output path inside the current workspace", "GOAL_STATUS.md")
    .action(async (options: StatusReportCliOptions) => {
      const outPath = resolveWorkspacePath(cwd, options.out);
      const markdown = await buildStatusReport(cwd);
      await ensureDir(path.dirname(outPath));
      await writeFile(outPath, markdown, "utf8");
    });

  program
    .command("query")
    .option("--json", "print machine-readable JSON", true)
    .option("--slug <slug>", "filter by goal slug")
    .option("--status <status>", "filter by derived goal status")
    .option("--repo <repo>", "filter by configured repository")
    .option("--event-type <type>", "filter by ledger event type")
    .option("--evidence-kind <kind>", "filter by verified evidence kind")
    .option("--review-verdict <verdict>", "filter by verified review verdict")
    .option("--from <iso>", "filter to goals with ledger events at or after this time")
    .option("--to <iso>", "filter to goals with ledger events at or before this time")
    .action(
      async (options: {
        json: boolean;
        slug?: string;
        status?: string;
        repo?: string;
        eventType?: string;
        evidenceKind?: string;
        reviewVerdict?: string;
        from?: string;
        to?: string;
      }) => {
        const queryOptions: {
          slug?: string;
          status?: GoalStatus;
          repo?: string;
          eventType?: GoalEventType;
          evidenceKind?: EvidenceKind;
          reviewVerdict?: ReviewVerdictValue;
          from?: string;
          to?: string;
        } = {};
        if (options.slug) queryOptions.slug = options.slug;
        if (options.status) {
          if (!isGoalStatus(options.status)) throw new Error(`invalid status: ${options.status}`);
          queryOptions.status = options.status;
        }
        if (options.repo) queryOptions.repo = options.repo;
        if (options.eventType) {
          if (!isGoalEventType(options.eventType)) throw new Error(`invalid event type: ${options.eventType}`);
          queryOptions.eventType = options.eventType;
        }
        if (options.evidenceKind) {
          if (!isEvidenceKind(options.evidenceKind)) throw new Error(`invalid evidence kind: ${options.evidenceKind}`);
          queryOptions.evidenceKind = options.evidenceKind;
        }
        if (options.reviewVerdict) {
          if (!isReviewVerdict(options.reviewVerdict)) throw new Error(`invalid review verdict: ${options.reviewVerdict}`);
          queryOptions.reviewVerdict = options.reviewVerdict;
        }
        if (options.from) queryOptions.from = options.from;
        if (options.to) queryOptions.to = options.to;
        const result = await queryLedger(cwd, queryOptions);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      },
    );

  program.command("publish-check").argument("<path>").action(async (input: string) => {
    const inputPath = resolveWorkspacePath(cwd, input);
    const findings = detectPublishLeaks(await readFile(inputPath, "utf8"));
    if (findings.length === 0) {
      process.stdout.write("no publish leaks found\n");
      return;
    }

    process.stderr.write(`publish-check found ${findings.length} potential leak(s) in ${input}:\n`);
    for (const finding of findings) {
      process.stderr.write(`- ${finding}\n`);
    }
    exitCode = 1;
  });
  const adapt = program.command("adapt");

  adapt.command("list").action(() => {
    const rows = listAdapters().map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      description: adapter.description,
      targetFiles: adapter.targetFiles,
      aliases: adapter.aliases ?? [],
    }));
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  });

  adapt
    .argument("<adapterId>")
    .argument("<goalTitle>")
    .option("--out <path>")
    .action(async (adapterId: string, goalTitle: string, options: AdapterCliOptions) => {
      const adapter = getAdapter(adapterId);
      if (!adapter) throw new Error(`unknown adapter: ${adapterId}`);
      await emitGeneratedAdapter(cwd, adapter.render(goalTitle), options);
    });



  const oss = program.command("oss");

  oss
    .command("audit")
    .requiredOption("--subject <name>")
    .action(async (options: OssAuditCliOptions) => {
      const audit = {
        subject: options.subject,
        verified: [],
        unknown: [...defaultOssUnknown],
        inferred: [],
        unmet: [],
        external_submission: false,
      } satisfies OssAudit;
      validateBySchema("oss-audit", audit);
      await writeJsonFile(path.join(ossDir(cwd), "audit.json"), audit);
    });

  oss
    .command("dossier")
    .requiredOption("--subject <name>")
    .option("--verified <item>", "verified fact", collectListOption, [] as string[])
    .option("--unknown <item>", "unknown or missing criterion", collectListOption, [] as string[])
    .option("--inferred <item>", "inference; [INFERENCE] is added when omitted", collectListOption, [] as string[])
    .option("--unmet <item>", "unmet criterion", collectListOption, [] as string[])
    .action(async (options: OssDossierCliOptions) => {
      const markdown = buildClaudeForOssDossier({
        subject: options.subject,
        verified: options.verified,
        unknown: options.unknown,
        inferred: options.inferred,
        unmet: options.unmet,
      });
      const dir = ossDir(cwd);
      await ensureDir(dir);
      await writeFile(path.join(dir, "claude-for-oss-dossier.md"), markdown, "utf8");
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

function isGoalEventType(value: string): value is GoalEventType {
  return goalEventTypes.includes(value as GoalEventType);
}

function isEvidenceKind(value: string): value is EvidenceKind {
  return evidenceKinds.includes(value as EvidenceKind);
}

function isReviewVerdict(value: string): value is ReviewVerdictValue {
  return reviewVerdicts.includes(value as ReviewVerdictValue);
}

function isReviewer(value: string): value is ReviewVerdict["reviewer"] {
  return reviewers.includes(value as ReviewVerdict["reviewer"]);
}

function isReviewStage(value: string): value is ReviewStage {
  return reviewStages.includes(value as ReviewStage);
}

const defaultOssUnknown = [
  "GitHub stars unknown",
  "registry downloads unknown",
  "dependent count unknown",
  "external merged PR count unknown",
] as const;

interface OssAuditCliOptions {
  subject: string;
}

interface OssDossierCliOptions {
  subject: string;
  verified: string[];
  unknown: string[];
  inferred: string[];
  unmet: string[];
}

interface AdapterCliOptions {
  out?: string;
}

interface StatusReportCliOptions {
  out: string;
}

function collectListOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function resolveWorkspacePath(root: string, requestedPath: string): string {
  if (path.isAbsolute(requestedPath)) throw new Error(`path must be relative to the current workspace: ${requestedPath}`);
  const workspaceRoot = path.resolve(root);
  const resolvedPath = path.resolve(workspaceRoot, requestedPath);
  const relative = path.relative(workspaceRoot, resolvedPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolvedPath;
  throw new Error(`path escapes the current workspace: ${requestedPath}`);
}

async function emitGeneratedAdapter(root: string, text: string, options: AdapterCliOptions): Promise<void> {
  if (!options.out) {
    process.stdout.write(text);
    return;
  }

  const outPath = resolveWorkspacePath(root, options.out);
  await ensureDir(path.dirname(outPath));
  await writeFile(outPath, text, "utf8");
}

function ossDir(root: string): string {
  return path.join(root, ".goal", "oss");
}
