import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addEvidence } from "../../src/core/evidence.js";
import { fileSha256 } from "../../src/core/fs.js";
import { readEvents } from "../../src/core/ledger.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("evidence records", () => {
  it("creates a schema-valid evidence record with artifact hash and ledger event", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "goal-evidence-"));
    const artifactDir = path.join(tmp, ".goal", "goals", "ship", "evidence", "artifacts");
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, "result.txt");
    await writeFile(artifactPath, "verified output\n", "utf8");
    const sha256 = await fileSha256(artifactPath);

    const evidence = await addEvidence(tmp, {
      slug: "ship",
      kind: "artifact",
      artifact_paths: [artifactPath],
      sha256,
      redaction_applied: false,
    });

    expect(evidence.id).toMatch(/\S/);
    expect(evidence.created_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(evidence.sha256).toBe(sha256);

    const stored = JSON.parse(
      await readFile(path.join(tmp, ".goal", "goals", "ship", "evidence", `${evidence.id}.json`), "utf8"),
    );
    expect(stored).toEqual(evidence);

    const events = await readEvents(tmp);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "evidence.added", slug: "ship" });
    expect(events[0].data).toMatchObject({ evidence_id: evidence.id, kind: "artifact", sha256, artifact_paths: [artifactPath] });
  });
});
