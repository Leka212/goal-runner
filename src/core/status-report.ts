import { buildDashboard, type DashboardSnapshot } from "./dashboard.js";
import { queryLedger, type LedgerQueryEvidenceSummary, type LedgerQueryGoal, type LedgerQueryReviewSummary } from "./query.js";
import { MANDATORY_OUTPUT_REDACTION_PATTERNS, redactText } from "./redaction.js";

interface StatusReportGoal {
  query: LedgerQueryGoal;
  dashboard: DashboardSnapshot["goals"][string] | undefined;
}

interface BlockerItem {
  slug: string;
  priority: number;
  reasons: string[];
}

interface RiskItem {
  slug: string;
  stage: string;
  severity: string;
  title: string;
  evidence: string;
}

export async function buildStatusReport(root: string): Promise<string> {
  const [query, dashboard] = await Promise.all([queryLedger(root), buildDashboard(root)]);
  const goals = query.goals.map((goal) => ({ query: goal, dashboard: dashboard.goals[goal.slug] } satisfies StatusReportGoal));
  const blockers = collectBlockers(goals);
  const risks = collectRisks(goals);

  const lines: string[] = ["# Goal Status", "", "## Summary", "", summaryTable(goals), "", "## Top blockers", "", ...blockerLines(blockers), "", "## Top risks", "", ...riskLines(risks), "", "## Verified", "", ...verifiedLines(goals), "", "## Inferred", "", ...inferredLines(goals), "", "## Unknown", "", ...unknownLines(goals), "", "## Unmet", "", ...unmetLines(goals), ""];
  return `${lines.map(safeLine).join("\n").trimEnd()}\n`;
}

function summaryTable(goals: StatusReportGoal[]): string {
  const rows = [
    "| Goal | Title | Status | Outcome | Evidence | Latest evidence | Reviews | Latest review | Preflight | Done claim | Blockers |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const goal of goals) {
    rows.push(
      [
        goal.query.slug,
        goal.query.title ?? "-",
        goal.query.status,
        goal.query.outcome ?? "-",
        `${goal.query.verified.evidence.length} verified`,
        latestEvidenceCell(goal),
        `${goal.query.verified.reviews.length} verified`,
        latestReviewCell(goal.query),
        preflightCell(goal.query),
        doneClaimCell(goal.query),
        summaryBlockerCell(goal),
      ]
        .map(tableCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }

  return rows.join("\n");
}

function collectBlockers(goals: StatusReportGoal[]): BlockerItem[] {
  const invalidDoneClaims: BlockerItem[] = [];
  const unmetGates: BlockerItem[] = [];

  for (const goal of goals) {
    if (goal.query.done_claim.valid === false) {
      invalidDoneClaims.push({ slug: goal.query.slug, priority: 0, reasons: ["invalid done claim", ...goal.query.done_claim.reasons] });
      continue;
    }
    const reasons = goal.dashboard?.done_gate.ok === false ? goal.dashboard.done_gate.reasons : [];
    if (reasons.length > 0) unmetGates.push({ slug: goal.query.slug, priority: 1, reasons });
  }

  return [...invalidDoneClaims, ...unmetGates].sort((left, right) => left.priority - right.priority || left.slug.localeCompare(right.slug));
}

function collectRisks(goals: StatusReportGoal[]): RiskItem[] {
  const risks: RiskItem[] = [];
  for (const goal of goals) {
    for (const review of goal.query.verified.reviews) {
      if (review.verdict !== "GO-WITH-RISKS" && review.findings.length === 0) continue;
      for (const finding of review.findings) {
        risks.push({
          slug: goal.query.slug,
          stage: review.stage,
          severity: finding.severity,
          title: finding.title,
          evidence: finding.evidence,
        });
      }
      if (review.verdict === "GO-WITH-RISKS" && review.findings.length === 0) {
        risks.push({ slug: goal.query.slug, stage: review.stage, severity: "risk", title: "GO-WITH-RISKS", evidence: "review verdict carries accepted risk" });
      }
    }
  }
  return risks.sort((left, right) => left.slug.localeCompare(right.slug) || left.stage.localeCompare(right.stage) || left.title.localeCompare(right.title));
}

function blockerLines(blockers: BlockerItem[]): string[] {
  if (blockers.length === 0) return ["- none"];
  return blockers.map((item) => `- ${item.slug}: ${item.reasons.join("; ")}`);
}

function riskLines(risks: RiskItem[]): string[] {
  if (risks.length === 0) return ["- none"];
  return risks.map((item) => `- ${item.slug}: ${item.stage} ${item.severity} risk — ${item.title} (${item.evidence})`);
}

function verifiedLines(goals: StatusReportGoal[]): string[] {
  const lines: string[] = [];
  for (const goal of goals) {
    const evidence = latest(goal.query.verified.evidence);
    if (evidence) lines.push(`- ${goal.query.slug}: Latest evidence: ${evidenceLabel(goal, evidence)}${evidence.redaction_applied ? " (redaction applied)" : ""}.`);

    const review = latestReviewForMaintainer(goal.query.verified.reviews);
    if (review) lines.push(`- ${goal.query.slug}: Latest review: ${review.stage} ${review.verdict} by ${review.reviewer}.`);

    if (goal.query.preflight_review.review_id) {
      lines.push(`- ${goal.query.slug}: Preflight: ${goal.query.preflight_review.verdict ?? "unknown"} by ${goal.query.preflight_review.reviewer ?? "unknown"}.`);
    }

    if (goal.query.done_claim.valid === true) lines.push(`- ${goal.query.slug}: Done claim has verified gate provenance.`);
  }
  return lines.length > 0 ? lines : ["- none"];
}

function inferredLines(goals: StatusReportGoal[]): string[] {
  const lines = goals.flatMap((goal) => [goal.query.inferred.summary, goal.query.inferred.prior_failure].filter((item): item is string => item !== null));
  return lines.length > 0 ? lines.map((item) => `- ${item}`) : ["- none"];
}

function unknownLines(goals: StatusReportGoal[]): string[] {
  const lines: string[] = [];
  for (const goal of goals) {
    if (goal.query.verified.evidence.length === 0) lines.push(`- ${goal.query.slug}: no verified evidence recorded`);
    if (goal.query.verified.reviews.length === 0) lines.push(`- ${goal.query.slug}: no verified review recorded`);
    if (goal.query.preflight_review.required && !goal.query.preflight_review.satisfied) {
      lines.push(`- ${goal.query.slug}: no admissible preflight review recorded`);
    }
  }
  return lines.length > 0 ? lines : ["- none"];
}

function unmetLines(goals: StatusReportGoal[]): string[] {
  const lines: string[] = [];
  for (const goal of goals) {
    if (goal.query.done_claim.valid === false) {
      for (const reason of goal.query.done_claim.reasons) lines.push(`- ${goal.query.slug}: invalid done claim — ${reason}`);
      continue;
    }
    for (const reason of goal.dashboard?.done_gate.reasons ?? []) lines.push(`- ${goal.query.slug}: ${reason}`);
  }
  return lines.length > 0 ? lines : ["- none"];
}

function latestEvidenceCell(goal: StatusReportGoal): string {
  const evidence = latest(goal.query.verified.evidence);
  return evidence ? evidenceLabel(goal, evidence) : "none";
}

function latestReviewCell(goal: LedgerQueryGoal): string {
  const review = latestReviewForMaintainer(goal.verified.reviews);
  return review ? `${review.stage} ${review.verdict} by ${review.reviewer}` : "none";
}

function preflightCell(goal: LedgerQueryGoal): string {
  if (!goal.preflight_review.review_id) return "missing";
  const base = `${goal.preflight_review.verdict ?? "unknown"} by ${goal.preflight_review.reviewer ?? "unknown"}`;
  return goal.preflight_review.satisfied ? base : `${base} (unmet)`;
}

function doneClaimCell(goal: LedgerQueryGoal): string {
  if (goal.done_claim.valid === true) return "valid";
  if (goal.done_claim.valid === false) return `invalid: ${goal.done_claim.reasons.join("; ")}`;
  return "not claimed";
}

function summaryBlockerCell(goal: StatusReportGoal): string {
  if (goal.query.done_claim.valid === false) return "invalid done claim";
  const reasons = goal.dashboard?.done_gate.ok === false ? goal.dashboard.done_gate.reasons : [];
  return reasons.length > 0 ? reasons.join("; ") : "none";
}

function evidenceLabel(goal: StatusReportGoal, evidence: LedgerQueryEvidenceSummary): string {
  if (evidence.kind === "command") {
    const commandId = commandIdForEvidence(goal, evidence);
    const exitCode = typeof evidence.exit_code === "number" ? evidence.exit_code : "unknown";
    return `command ${commandId} exited ${exitCode}`;
  }
  return `${evidence.kind} ${evidence.id}`;
}

function commandIdForEvidence(goal: StatusReportGoal, evidence: LedgerQueryEvidenceSummary): string {
  const command = evidence.command?.join("\u0000");
  const required = goal.dashboard?.evidence.required.find((item) => item.command.join("\u0000") === command);
  return required?.id ?? evidence.id;
}

function latestReviewForMaintainer(reviews: LedgerQueryReviewSummary[]): LedgerQueryReviewSummary | undefined {
  const doneReviews = reviews.filter((review) => review.stage === "done");
  return latest(doneReviews.length > 0 ? doneReviews : reviews);
}

function latest<T extends { created_at: string; id: string }>(items: T[]): T | undefined {
  return [...items].sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)).at(-1);
}

function tableCell(value: string): string {
  return safeText(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function safeLine(value: string): string {
  if (value.startsWith("|")) return value;
  return safeText(value);
}

function safeText(value: string): string {
  return redactText(value, MANDATORY_OUTPUT_REDACTION_PATTERNS)
    .replace(/\b(?:TOKEN|SECRET|PASSWORD|COOKIE|API[_-]?KEY)\b\s*[:=]\s*\S+/gi, "[REDACTED]")
    .replace(/\bAuthorization\s*:\s*Bearer\s+\S+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "[REDACTED]")
    .replace(/\/home\/(?!example\b)[A-Za-z0-9._-]+(?:\/[^\s)|,;]*)?/g, "/home/example/[REDACTED]")
    .replace(/\b\.env(?:\.[A-Za-z0-9_-]+)?\b/gi, "[REDACTED_PATH]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[REDACTED_IP]")
    .replace(/\b[A-Z][A-Za-z0-9_-]*(?:Internal|Private)[A-Za-z0-9_-]*\b/g, "[REDACTED_MARKER]");
}
