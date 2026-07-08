import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEvents, recordEvent } from "../../src/core/ledger.js";
import { appendGoalStep, startGoal, stopGoal } from "../../src/core/goals.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function eventLine(sequence: number, type = "goal.step"): string {
  return JSON.stringify({
    id: `event-${sequence}-${type}`,
    sequence,
    type,
    slug: "alpha",
    created_at: "2026-01-01T00:00:00.000Z",
    data: {},
  });
}

describe("ledger", () => {
  it("appends JSONL events without overwriting prior events", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-ledger-"));

    await recordEvent(tmp, { type: "goal.started", slug: "alpha", data: { title: "Alpha" } });
    await recordEvent(tmp, { type: "goal.step", slug: "alpha", data: { summary: "Step" } });

    const events = await readEvents(tmp);
    expect(events.map((event) => event.type)).toEqual(["goal.started", "goal.step"]);

    const raw = await readFile(path.join(tmp, ".goal", "events.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("assigns monotonic sequence numbers across appended events", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-sequence-"));

    const first = await recordEvent(tmp, { type: "goal.started", slug: "alpha", data: { title: "Alpha" } });
    const second = await recordEvent(tmp, { type: "goal.step", slug: "alpha", data: { summary: "Step" } });
    const third = await recordEvent(tmp, { type: "goal.stopped", slug: "alpha", data: { status: "blocked" } });

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    await expect(readEvents(tmp)).resolves.toMatchObject([
      { sequence: 1, type: "goal.started" },
      { sequence: 2, type: "goal.step" },
      { sequence: 3, type: "goal.stopped" },
    ]);
  });

  it("assigns unique monotonic sequence numbers to concurrent appends on the same ledger", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-concurrent-sequence-"));

    const events = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        recordEvent(tmp!, { type: "goal.step", slug: "alpha", data: { summary: `Step ${index}` } }),
      ),
    );

    expect(events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    await expect(readEvents(tmp)).resolves.toMatchObject(
      Array.from({ length: 20 }, (_, index) => ({ sequence: index + 1 })),
    );
  });

  it("rejects duplicate or non-monotonic ledger sequences", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-bad-sequence-"));
    await mkdir(path.join(tmp, ".goal"));
    await writeFile(path.join(tmp, ".goal", "events.jsonl"), `${eventLine(1)}\n${eventLine(1)}\n`, "utf8");

    await expect(readEvents(tmp)).rejects.toThrow(/invalid ledger line 2: expected sequence 2, got 1/i);
  });

  it("rejects malformed ledger lines instead of silently dropping them", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-malformed-"));
    await mkdir(path.join(tmp, ".goal"));
    await writeFile(path.join(tmp, ".goal", "events.jsonl"), "{not-json}\n", "utf8");

    await expect(readEvents(tmp)).rejects.toThrow(/invalid ledger line 1/i);
  });
});

describe("goal lifecycle", () => {
  it("records start, step, and stop events without enforcing the done gate yet", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-lifecycle-"));

    await startGoal(tmp, "ship-cli", "Ship CLI", ["init works", "tests pass"]);
    await appendGoalStep(tmp, "ship-cli", "Created tests", "test output");
    await expect(stopGoal(tmp, "ship-cli", "done")).resolves.toBeUndefined();

    const events = await readEvents(tmp);
    expect(events.map((event) => [event.sequence, event.type, event.slug])).toEqual([
      [1, "goal.started", "ship-cli"],
      [2, "goal.step", "ship-cli"],
      [3, "goal.stopped", "ship-cli"],
    ]);
    expect(events.map((event) => event.data)).toEqual([
      { title: "Ship CLI", acceptance: ["init works", "tests pass"] },
      { summary: "Created tests", evidence_expected: "test output" },
      { status: "done" },
    ]);

    const human = await readFile(path.join(tmp, "GOALS.md"), "utf8");
    expect(human).toContain("Ship CLI");
    expect(human).toContain("Created tests");
    expect(human).toContain("Stop: ship-cli -> done");
  });
});
