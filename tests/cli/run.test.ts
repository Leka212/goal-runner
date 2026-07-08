import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("cli", () => {
  it("initializes, starts, and steps a goal", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["init"], tmp)).toBe(0);
    expect(await runCli(["start", "ship-cli", "Ship CLI", "--acceptance", "tests pass"], tmp)).toBe(0);
    expect(await runCli(["step", "ship-cli", "Created tests", "--evidence", "vitest output"], tmp)).toBe(0);

    const human = await readFile(path.join(tmp, "GOALS.md"), "utf8");
    expect(human).toContain("Ship CLI");
    expect(human).toContain("Created tests");
  });

  it("reports status and stops a goal without running verification commands", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));
    await writeFile(path.join(tmp, "sentinel.txt"), "not executed", "utf8");

    expect(await runCli(["init"], tmp)).toBe(0);
    expect(await runCli(["start", "ship-cli", "Ship CLI", "--acceptance", "tests pass"], tmp)).toBe(0);
    expect(await runCli(["status", "ship-cli"], tmp)).toBe(0);
    expect(await runCli(["stop", "ship-cli", "--status", "blocked"], tmp)).toBe(0);
    expect(await runCli(["status", "ship-cli"], tmp)).toBe(0);

    const goal = JSON.parse(await readFile(path.join(tmp, ".goal", "goals", "ship-cli", "goal.json"), "utf8"));
    expect(goal.status).toBe("blocked");
    expect(await readFile(path.join(tmp, "sentinel.txt"), "utf8")).toBe("not executed");
  });

  it("returns a failing exit code when status cannot find the goal", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["init"], tmp)).toBe(0);
    expect(await runCli(["status", "missing-goal"], tmp)).toBe(1);
  });

  it("returns a failing exit code when doctor finds an invalid workspace", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-cli-"));

    expect(await runCli(["doctor"], tmp)).toBe(1);
    expect(await runCli(["init"], tmp)).toBe(0);
    expect(await runCli(["doctor"], tmp)).toBe(0);
  });
});
