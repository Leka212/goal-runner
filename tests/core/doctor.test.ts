import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDefaultGoalConfig } from "../../src/core/config.js";
import { doctor } from "../../src/core/doctor.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("doctor", () => {
  it("reports a missing config as unhealthy", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));

    await expect(doctor(tmp)).resolves.toEqual({
      ok: false,
      errors: expect.arrayContaining(["missing .goal/goal.yaml"]),
    });
  });

  it("reports an initialized workspace as healthy", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));

    await writeDefaultGoalConfig(tmp);

    await expect(doctor(tmp)).resolves.toEqual({ ok: true, errors: [] });
  });

  it("reports malformed event ledgers without throwing", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));
    await writeDefaultGoalConfig(tmp);
    await writeFile(path.join(tmp, ".goal", "events.jsonl"), "not json\n", "utf8");

    const result = await doctor(tmp);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("invalid event ledger");
  });
});
