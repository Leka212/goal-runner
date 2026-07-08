import { loadGoalConfig } from "./config.js";
import { listJson } from "./gates.js";
import { readEvents } from "./ledger.js";
import { goalRunDir, resolveGoalPaths } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./fs.js";
import type { EvidenceRecord, GoalEvent, GoalStatus, ReviewVerdict } from "./types.js";
import { canStopDone } from "./gates.js";
import { listVerifiedReviews } from "./review.js";

interface DashboardRequiredEvidence {
  id: string;
  command: string[];
  satisfied: boolean;
}

interface DashboardGoal {
  status: GoalStatus;
  title: string | null;
  last_event: string;
  event_count: number;
  evidence: { required: DashboardRequiredEvidence[] };
  review: { required: boolean; satisfied: boolean; latest_verdict: ReviewVerdict["verdict"] | null };
  done_gate: { ok: boolean; reasons: string[] };
}

export interface DashboardSnapshot {
  goals: Record<string, DashboardGoal>;
}

export async function buildDashboard(root: string): Promise<DashboardSnapshot> {
  const config = await loadGoalConfig(root);
  const events = await readEvents(root);
  const eventsBySlug = groupEventsBySlug(events);
  const goals: Record<string, DashboardGoal> = {};

  for (const [slug, goalEvents] of Object.entries(eventsBySlug)) {
    const evidence = await listJson<EvidenceRecord>(`${goalRunDir(root, slug)}/evidence`);
    const reviews = await listVerifiedReviews(root, slug);
    const latestReview = latestByCreatedAt(reviews);
    const doneGate = await canStopDone(root, slug);
    const goalState = await readGoalState(root, slug);
    const allowedVerdicts = config.gates.review_verdicts.allowed;
    const reviewRequired = config.gates.require_review_for.includes("done");

    goals[slug] = {
      status: statusFromEvents(goalEvents),
      title: goalState?.title ?? titleFromEvents(goalEvents),
      last_event: goalEvents[goalEvents.length - 1]?.type ?? "",
      event_count: goalEvents.length,
      evidence: {
        required: config.verification.commands
          .filter((command) => command.required_for_done)
          .map((command) => ({
            id: command.id,
            command: command.argv,
            satisfied: evidence.some(
              (item) => item.kind === "command" && item.command?.join("\u0000") === command.argv.join("\u0000") && item.exit_code === 0,
            ),
          })),
      },
      review: {
        required: reviewRequired,
        satisfied: !reviewRequired || reviews.some((review) => allowedVerdicts.includes(review.verdict)),
        latest_verdict: latestReview?.verdict ?? null,
      },
      done_gate: doneGate,
    };
  }

  const dashboard = { goals } satisfies DashboardSnapshot;
  await writeJsonFile(resolveGoalPaths(root).dashboardFile, dashboard);
  return dashboard;
}

function groupEventsBySlug(events: GoalEvent[]): Record<string, GoalEvent[]> {
  const grouped: Record<string, GoalEvent[]> = {};
  for (const event of events) {
    grouped[event.slug] = [...(grouped[event.slug] ?? []), event];
  }
  return grouped;
}

function latestByCreatedAt(reviews: ReviewVerdict[]): ReviewVerdict | undefined {
  return [...reviews].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
}

function statusFromEvents(events: GoalEvent[]): GoalStatus {
  const stopped = [...events].reverse().find((event) => event.type === "goal.stopped");
  return isGoalStatus(stopped?.data.status) ? stopped.data.status : "active";
}

function titleFromEvents(events: GoalEvent[]): string | null {
  const started = events.find((event) => event.type === "goal.started");
  return typeof started?.data.title === "string" ? started.data.title : null;
}

async function readGoalState(root: string, slug: string): Promise<{ title: string; status: GoalStatus } | null> {
  try {
    return await readJsonFile<{ title: string; status: GoalStatus }>(`${goalRunDir(root, slug)}/goal.json`);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "done" || value === "blocked" || value === "reverted" || value === "abandoned";
}
