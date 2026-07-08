import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDefaultGoalConfig } from "../../src/core/config.js";
import { addReview } from "../../src/core/review.js";
import { startGoal } from "../../src/core/goals.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("review", () => {
  it("persists GO and NO-GO review verdicts and records review events", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-review-"));
    await writeDefaultGoalConfig(tmp);
    await startGoal(tmp, "ship", "Ship", ["reviewed"]);

    const go = await addReview(tmp, "ship", "GO", "human", [{ severity: "minor", title: "Ready", evidence: "tests pass" }]);
    const noGo = await addReview(tmp, "ship", "NO-GO", "adapter", [{ severity: "critical", title: "Regression", evidence: "review found a blocker" }]);

    expect(go.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(noGo.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(go.artifact_sha256).not.toBe("pending");
    const reviewDir = path.join(tmp, ".goal", "goals", "ship", "reviews");
    const reviewFiles = (await readdir(reviewDir)).filter((name) => name.endsWith(".json"));
    expect(reviewFiles).toHaveLength(2);

    const persisted = JSON.parse(await readFile(path.join(reviewDir, `${go.id}.json`), "utf8"));
    expect(persisted).toMatchObject({ id: go.id, slug: "ship", verdict: "GO", reviewer: "human", artifact_sha256: go.artifact_sha256 });

    const events = await readFile(path.join(tmp, ".goal", "events.jsonl"), "utf8");
    expect(events).toContain('"type":"review.added"');
    expect(events).toContain('"verdict":"GO"');
    expect(events).toContain('"verdict":"NO-GO"');
  });
});
