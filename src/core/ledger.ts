import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { appendLine } from "./fs.js";
import { resolveGoalPaths } from "./paths.js";
import { validateBySchema } from "./schemas.js";
import type { GoalEvent } from "./types.js";

export type NewGoalEvent = Omit<GoalEvent, "id" | "created_at" | "sequence">;

export async function recordEvent(root: string, event: NewGoalEvent): Promise<GoalEvent> {
  const existing = await readEvents(root);
  const sequence = existing.length === 0 ? 1 : Math.max(...existing.map((item) => item.sequence)) + 1;
  const full: GoalEvent = {
    ...event,
    id: randomUUID(),
    created_at: new Date().toISOString(),
    sequence,
  };

  validateBySchema("goal-event", full);
  await appendLine(resolveGoalPaths(root).eventsFile, JSON.stringify(full));
  return full;
}

export async function readEvents(root: string): Promise<GoalEvent[]> {
  const file = resolveGoalPaths(root).eventsFile;
  let raw: string;

  try {
    raw = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const events: GoalEvent[] = [];
  const lines = raw.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
      validateBySchema("goal-event", parsed);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid ledger line ${index + 1}: ${message}`);
    }
    events.push(parsed);
  }

  return events;
}

