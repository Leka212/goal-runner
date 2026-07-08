import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { runCli } from "../../src/cli/run.js";
import { defaultGoalConfig } from "../../src/core/config.js";
import { addEvidence } from "../../src/core/evidence.js";
import { fileSha256 } from "../../src/core/fs.js";
import { readEvents } from "../../src/core/ledger.js";
import { detectPublishLeaks } from "../../src/core/redaction.js";
import type { GoalConfig, GoalEvent, ReviewVerdictValue } from "../../src/core/types.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("maintainer integration scenarios", () => {
  it("records a full issue triage to done flow with verified evidence, review provenance, gates, query, dashboard, and public-safe report", async () => {
    tmp = await createWorkspace("maintainer-done-");
    await writeScenarioConfig(tmp, {
      requireReviewFor: ["done"],
      commands: [commandConfig("maintainer-unit", "console.log('triage verification ok')")],
    });

    await expectCli(tmp, ["start", "issue-11", "Triage issue #11", "--acceptance", "triage recorded", "--acceptance", "verification and review pass"]);
    await expectCli(tmp, ["step", "issue-11", "Mapped issue report to local maintainer acceptance", "--evidence", "local issue triage notes and targeted command"]);
    await expectCli(tmp, ["verify", "issue-11", "--command", "maintainer-unit"]);
    await expectCli(tmp, ["review", "issue-11", "--verdict", "GO", "--reviewer", "human", "--stage", "done"]);
    await expectCli(tmp, ["gate", "issue-11", "--stage", "done"]);
    await expectCli(tmp, ["stop", "issue-11", "--status", "done"]);

    const events = await readEvents(tmp);
    expect(events.map((event) => event.type)).toEqual(["goal.started", "goal.step", "evidence.added", "review.added", "goal.stopped"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);

    const evidenceEvent = events.find((event) => event.type === "evidence.added");
    const reviewEvent = events.find((event) => event.type === "review.added");
    const stoppedEvent = events.at(-1);
    expect(evidenceEvent?.data).toMatchObject({ kind: "command", exit_code: 0 });
    expect(typeof evidenceEvent?.data.evidence_id).toBe("string");
    expect(typeof evidenceEvent?.data.sha256).toBe("string");
    expect(reviewEvent?.data).toMatchObject({ stage: "done", verdict: "GO" });

    const query = await queryCli(tmp, ["--slug", "issue-11"]);
    expect(query.goals).toHaveLength(1);
    const goal = query.goals[0];
    expect(goal).toMatchObject({ slug: "issue-11", status: "done", outcome: "done" });
    expect(goal.acceptance).toEqual(["triage recorded", "verification and review pass"]);
    expect(goal.verified.evidence).toHaveLength(1);
    expect(goal.verified.reviews).toHaveLength(1);
    expect(goal.verified.evidence[0]).toMatchObject({ command: [process.execPath, "-e", "console.log('triage verification ok')"], exit_code: 0, redaction_applied: true });
    expect(goal.verified.evidence[0].sha256).toBe(evidenceEvent?.data.sha256);
    expect(goal.verified.reviews[0].artifact_sha256).toBe(reviewEvent?.data.artifact_sha256);
    expect(goal.done_claim).toEqual({ valid: true, reasons: [] });

    const provenance = gateProvenance(stoppedEvent);
    expect(provenance.evidence).toEqual([{ id: evidenceEvent?.data.evidence_id, command_id: "maintainer-unit", sha256: evidenceEvent?.data.sha256 }]);
    expect(provenance.reviews).toEqual([{ id: reviewEvent?.data.review_id, stage: "done", verdict: "GO", artifact_sha256: reviewEvent?.data.artifact_sha256 }]);

    const manifestPath = goal.verified.evidence[0].artifact_paths.find((artifactPath: string) => artifactPath.endsWith(".sha256.json"));
    expect(manifestPath).toBeDefined();
    expect(goal.verified.evidence[0].sha256).toBe(await fileSha256(path.join(tmp, manifestPath!)));

    await expectCli(tmp, ["dashboard"]);
    const dashboard = JSON.parse(await readFile(path.join(tmp, ".goal", "dashboard.json"), "utf8"));
    expect(dashboard.goals["issue-11"].evidence.required).toEqual([{ id: "maintainer-unit", command: [process.execPath, "-e", "console.log('triage verification ok')"], satisfied: true }]);
    expect(dashboard.goals["issue-11"].review).toEqual({ required: true, satisfied: true, latest_verdict: "GO" });
    expect(dashboard.goals["issue-11"].done_gate).toEqual({ ok: true, reasons: [] });

    await expectCli(tmp, ["status-report", "--out", "GOAL_STATUS.md"]);
    const report = await readFile(path.join(tmp, "GOAL_STATUS.md"), "utf8");
    expect(report).toContain("issue-11");
    expect(report).toContain("command maintainer-unit exited 0");
    expect(report).toContain("Done claim has verified gate provenance.");
    expect(detectPublishLeaks(report)).toEqual([]);
  });

  it("keeps failed verification evidence redacted and queryable as prior blocked history after a maintainer restarts the goal", async () => {
    tmp = await createWorkspace("maintainer-blocked-");
    await writeScenarioConfig(tmp, {
      commands: [commandConfig("maintainer-fail", "console.error('api_key=leaked-value'); process.exit(9)")],
    });

    await expectCli(tmp, ["start", "flaky-fix", "Fix flaky parser regression", "--acceptance", "failing command is captured"]);
    const failedVerify = await captureStdio(() => runCli(["verify", "flaky-fix", "--command", "maintainer-fail"], tmp!));
    expect(failedVerify.exitCode).toBe(9);
    await expectCli(tmp, ["stop", "flaky-fix", "--status", "blocked"]);
    await expectCli(tmp, ["start", "flaky-fix", "Restart flaky parser regression", "--acceptance", "prior blocker remains visible"]);

    const query = await queryCli(tmp, ["--slug", "flaky-fix"]);
    expect(query.goals).toHaveLength(1);
    const goal = query.goals[0];
    expect(goal).toMatchObject({ slug: "flaky-fix", status: "active", outcome: null });
    expect(goal.outcomes).toEqual([expect.objectContaining({ status: "blocked" })]);
    expect(goal.inferred.prior_failure).toContain("previously ended as blocked");
    expect(goal.verified.evidence).toHaveLength(1);
    expect(goal.verified.evidence[0]).toMatchObject({ exit_code: 9, redaction_applied: true });

    const stderr = await readFile(path.join(tmp, goal.verified.evidence[0].stderr_redacted_path), "utf8");
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).not.toContain("leaked-value");
    expect(stderr).not.toContain("api_key=");

    const blocked = await queryCli(tmp, ["--status", "active", "--evidence-kind", "command"]);
    expect(blocked.goals.map((item: { slug: string }) => item.slug)).toEqual(["flaky-fix"]);
  });

  it("stops unsafe publish material before export while status reports and OSS dossiers stay redacted and publish-clean", async () => {
    tmp = await createWorkspace("maintainer-publish-");
    await writeScenarioConfig(tmp, { commands: [commandConfig("publish-unit", "console.log('publish verification ok')")] });

    const unsafeDraft = "MaintainerPrivateNotes TOKEN=unsafe-secret /home/mathis/project 100.83.96.73 Authorization: Bearer abcdefghijklmnop";
    await writeFile(path.join(tmp, "unsafe-draft.md"), unsafeDraft, "utf8");
    expect(detectPublishLeaks(unsafeDraft)).toEqual(expect.arrayContaining(["secret-like token text", "private home path", "internal/private marker", "ip address"]));

    const publishCheck = await captureStdio(() => runCli(["publish-check", "unsafe-draft.md"], tmp!));
    expect(publishCheck.exitCode).toBe(1);
    expect(publishCheck.stderr).toContain("publish-check found");
    expect(publishCheck.stderr).not.toContain("unsafe-secret");
    expect(publishCheck.stderr).not.toContain("/home/mathis");

    await expectCli(tmp, ["start", "public-safety", "Fix TOKEN=unsafe-secret /home/mathis/project 100.83.96.73", "--acceptance", "publish draft is redacted"]);
    await expectCli(tmp, ["status-report", "--out", "PUBLIC_STATUS.md"]);
    const report = await readFile(path.join(tmp, "PUBLIC_STATUS.md"), "utf8");
    expect(report).toContain("[REDACTED]");
    expect(report).toContain("/home/example/[REDACTED]");
    expect(report).toContain("[REDACTED_IP]");
    expect(report).not.toContain("unsafe-secret");
    expect(report).not.toContain("/home/mathis");
    expect(report).not.toContain("100.83.96.73");
    expect(detectPublishLeaks(report)).toEqual([]);

    await expectCli(tmp, [
      "oss",
      "dossier",
      "--subject",
      "MaintainerPrivateNotes 100.83.96.73",
      "--verified",
      "TOKEN=unsafe-secret observed only in private draft",
      "--unknown",
      "/home/mathis/project metrics unknown",
      "--inferred",
      "Authorization: Bearer abcdefghijklmnop must never be exported",
      "--unmet",
      "PrivateInternalLaunch data is unavailable",
    ]);
    const dossier = await readFile(path.join(tmp, ".goal", "oss", "claude-for-oss-dossier.md"), "utf8");
    expect(dossier).toContain("[REDACTED]");
    expect(dossier).toContain("[REDACTED_IP]");
    expect(dossier).toContain("/home/example/[REDACTED]");
    expect(dossier).toContain("[REDACTED_MARKER]");
    expect(dossier).not.toContain("unsafe-secret");
    expect(dossier).not.toContain("/home/mathis");
    expect(dossier).not.toContain("100.83.96.73");
    expect(dossier).not.toContain("abcdefghijklmnop");
    expect(detectPublishLeaks(dossier)).toEqual([]);
  });

  it("records adapter-generated local instructions as ledger evidence without launching agents or leaking publish-unsafe text", async () => {
    tmp = await createWorkspace("maintainer-adapter-");
    await writeScenarioConfig(tmp, {
      commands: [commandConfig("adapter-local-check", "const fs = require('fs'); if (!fs.existsSync('instructions/codex.md')) process.exit(4); console.log('adapter instruction evidence ok')")],
    });

    await expectCli(tmp, ["start", "adapter-evidence", "Capture adapter evidence", "--acceptance", "adapter instructions are local evidence"]);
    await expectCli(tmp, ["adapt", "codex", "Capture adapter evidence", "--out", "instructions/codex.md"]);

    const adapterPath = path.join(tmp, "instructions", "codex.md");
    const adapterText = await readFile(adapterPath, "utf8");
    expect(adapterText).toContain("generate-only guidance");
    expect(adapterText).toContain("Completion claims need evidence from goal verify");
    expect(adapterText).not.toMatch(/execute agents|start agents|npm publish|GitHub Actions/i);
    expect(detectPublishLeaks(adapterText)).toEqual([]);

    const adapterEvidence = await addEvidence(tmp, {
      slug: "adapter-evidence",
      kind: "file",
      artifact_paths: [adapterPath],
      sha256: await fileSha256(adapterPath),
      redaction_applied: true,
    });
    await expectCli(tmp, ["verify", "adapter-evidence", "--command", "adapter-local-check"]);

    const events = await readEvents(tmp);
    const fileEvidenceEvent = events.find((event) => event.type === "evidence.added" && event.data.evidence_id === adapterEvidence.id);
    expect(fileEvidenceEvent?.data).toMatchObject({ kind: "file", sha256: adapterEvidence.sha256, artifact_paths: [adapterPath] });

    const query = await queryCli(tmp, ["--slug", "adapter-evidence", "--evidence-kind", "file"]);
    expect(query.goals).toHaveLength(1);
    expect(query.goals[0].verified.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", artifact_paths: ["instructions/codex.md"], sha256: adapterEvidence.sha256, redaction_applied: true }),
      ]),
    );
    expect(query.goals[0].event_types["evidence.added"]).toBe(2);
  });
});

async function createWorkspace(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await expectCli(root, ["init"]);
  return root;
}

async function writeScenarioConfig(
  root: string,
  options: {
    commands: GoalConfig["verification"]["commands"];
    requireReviewFor?: GoalConfig["gates"]["require_review_for"];
  },
): Promise<void> {
  const config = defaultGoalConfig("maintainer-scenario");
  config.project.repo = "example/goal-runner";
  config.verification.commands = options.commands;
  config.gates.require_review_for = options.requireReviewFor ?? [];
  await writeFile(path.join(root, ".goal", "goal.yaml"), YAML.stringify(config), "utf8");
}

function commandConfig(id: string, script: string): GoalConfig["verification"]["commands"][number] {
  return {
    id,
    argv: [process.execPath, "-e", script],
    timeout_seconds: 5,
    required_for_done: true,
    redact: true,
    output_byte_cap: 20_000,
  };
}

async function expectCli(root: string, argv: string[]): Promise<void> {
  const result = await captureStdio(() => runCli(argv, root));
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
}

async function queryCli(root: string, argv: string[] = []): Promise<any> {
  const result = await captureStdio(() => runCli(["query", ...argv], root));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

async function captureStdio(action: () => Promise<number>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = "";
  let stderr = "";

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    const exitCode = await action();
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function gateProvenance(event: GoalEvent | undefined): { evidence: Array<{ id: string; command_id: string; sha256: string }>; reviews: Array<{ id: string; stage?: string; verdict: ReviewVerdictValue; artifact_sha256: string }> } {
  expect(event?.type).toBe("goal.stopped");
  expect(event?.data.status).toBe("done");
  const provenance = event?.data.gate_provenance;
  expect(provenance).toBeTypeOf("object");
  return provenance as { evidence: Array<{ id: string; command_id: string; sha256: string }>; reviews: Array<{ id: string; stage?: string; verdict: ReviewVerdictValue; artifact_sha256: string }> };
}
