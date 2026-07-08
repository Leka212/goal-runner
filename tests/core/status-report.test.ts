import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { writeDefaultGoalConfig } from "../../src/core/config.js";
import { addReview } from "../../src/core/review.js";
import { appendGoalStep, startGoal } from "../../src/core/goals.js";
import { recordEvent } from "../../src/core/ledger.js";
import { detectPublishLeaks } from "../../src/core/redaction.js";
import { buildStatusReport } from "../../src/core/status-report.js";
import { verifyCommand } from "../../src/core/verify.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("status report", () => {
  it("renders a maintainer-readable markdown summary with top blockers before evidence sections", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-status-report-"));
    await createStatusReportFixture(tmp);

    const markdown = await buildStatusReport(tmp);

    expect(markdown).toMatch(/^# Goal Status\n/);
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("| Goal | Title | Status | Outcome | Evidence | Reviews | Preflight | Done claim | Blockers |");
    expect(markdown).toContain("| ready-status | Ready status artifact | active | - | 1 verified | 2 verified | GO-WITH-RISKS by adapter | not claimed | none |");
    expect(markdown).toContain("| bad-done | Invalid done claim | done | done | 0 verified | 0 verified | missing | invalid: missing gate provenance | invalid done claim |");
    expect(markdown).toContain("| blocked-gates | Blocked by gates | active | - | 0 verified | 0 verified | missing | not claimed | missing required evidence for command unit; missing admissible preflight review verdict; missing admissible review verdict |");

    const topBlockers = section(markdown, "Top blockers");
    expect(topBlockers).toContain("bad-done");
    expect(topBlockers).toContain("invalid done claim");
    expect(topBlockers).toContain("missing gate provenance");
    expect(topBlockers).toContain("blocked-gates");
    expect(topBlockers).toContain("missing required evidence for command unit");
    expect(topBlockers).toContain("missing admissible preflight review verdict");
    expect(topBlockers.indexOf("bad-done")).toBeLessThan(topBlockers.indexOf("blocked-gates"));
    expect(markdown.indexOf("## Top blockers")).toBeLessThan(markdown.indexOf("## Verified"));
  });

  it("keeps Verified, Inferred, Unknown, and Unmet facts separated", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-status-report-"));
    await createStatusReportFixture(tmp);

    const markdown = await buildStatusReport(tmp);
    const verified = section(markdown, "Verified");
    const inferred = section(markdown, "Inferred");
    const unknown = section(markdown, "Unknown");
    const unmet = section(markdown, "Unmet");

    expect(verified).toContain("ready-status");
    expect(verified).toContain("Latest evidence: command unit exited 0");
    expect(verified).toContain("redaction applied");
    expect(verified).toContain("Latest review: done GO by human");
    expect(verified).toContain("Preflight: GO-WITH-RISKS by adapter");
    expect(verified).not.toContain("[INFERENCE]");
    expect(verified).not.toContain("missing required evidence");

    expect(inferred).toContain("[INFERENCE] blocked-gates is currently active");
    expect(inferred).toContain("[INFERENCE] bad-done stopped with outcome done");
    expect(inferred).not.toContain("Latest evidence");
    expect(inferred).not.toContain("missing gate provenance");

    expect(unknown).toContain("blocked-gates: no verified evidence recorded");
    expect(unknown).toContain("blocked-gates: no verified review recorded");
    expect(unknown).toContain("bad-done: no admissible preflight review recorded");
    expect(unknown).not.toContain("ready-status: no verified evidence recorded");
    expect(unknown).not.toContain("[INFERENCE]");

    expect(unmet).toContain("blocked-gates: missing required evidence for command unit");
    expect(unmet).toContain("blocked-gates: missing admissible preflight review verdict");
    expect(unmet).toContain("bad-done: invalid done claim — missing gate provenance");
    expect(unmet).not.toContain("ready-status: missing required evidence");
    expect(unmet).not.toContain("[INFERENCE]");
  });

  it("is deterministic and clean under publish leak detection for synthetic safe data", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-status-report-"));
    await createStatusReportFixture(tmp);

    const first = await buildStatusReport(tmp);
    const second = await buildStatusReport(tmp);

    expect(second).toBe(first);
    expect(detectPublishLeaks(first)).toEqual([]);
    expect(first).not.toContain(tmp);
    expect(first).not.toMatch(/TOKEN|SECRET|PASSWORD|Authorization: Bearer/i);
  });
});

async function createStatusReportFixture(root: string): Promise<void> {
  await writeDefaultGoalConfig(root);
  await configureStatusReportGates(root);

  await startGoal(root, "blocked-gates", "Blocked by gates", ["unit evidence", "preflight approved"]);
  await appendGoalStep(root, "blocked-gates", "Drafted implementation plan", "needs verification and review evidence");

  await startGoal(root, "bad-done", "Invalid done claim", ["gate provenance captured"]);
  await recordEvent(root, { type: "goal.stopped", slug: "bad-done", data: { status: "done" } });

  await startGoal(root, "ready-status", "Ready status artifact", ["unit evidence", "preflight approved"]);
  await appendGoalStep(root, "ready-status", "Collected maintainer evidence", "unit command and human review");
  await verifyCommand(root, "ready-status", "unit");
  await addReview(
    root,
    "ready-status",
    "GO-WITH-RISKS",
    "adapter",
    [{ severity: "minor", title: "Small rollout risk", evidence: "documented mitigation" }],
    { stage: "preflight" },
  );
  await addReview(root, "ready-status", "GO", "human", [
    { severity: "minor", title: "Ready", evidence: "targeted status report tests passed" },
  ]);
}

async function configureStatusReportGates(root: string): Promise<void> {
  const configPath = path.join(root, ".goal", "goal.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  config.gates.require_review_for = ["preflight", "done"];
  config.verification.commands[0] = {
    id: "unit",
    argv: [process.execPath, "-e", "process.stdout.write('status report safe output\\n')"],
    timeout_seconds: 5,
    required_for_done: true,
    redact: true,
    output_byte_cap: 20_000,
  };
  await writeFile(configPath, YAML.stringify(config), "utf8");
}

function section(markdown: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  expect(start, `missing ${marker} section`).not.toBe(-1);
  const body = markdown.slice(start + marker.length);
  const nextHeading = body.search(/\n## /);
  return nextHeading === -1 ? body : body.slice(0, nextHeading);
}
