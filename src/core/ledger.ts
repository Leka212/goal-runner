import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { appendLine } from "./fs.js";
import { resolveGoalPaths } from "./paths.js";
import { validateBySchema } from "./schemas.js";
import type { GoalEvent } from "./types.js";

export type NewGoalEvent = Omit<GoalEvent, "id" | "created_at" | "sequence">;

const unlocked = Promise.resolve();
const ledgerLocks = new Map<string, Promise<void>>();

export async function recordEvent(root: string, event: NewGoalEvent): Promise<GoalEvent> {
  const file = resolveGoalPaths(root).eventsFile;
  return withLedgerLock(file, async () => {
    const existing = await readEvents(root);
    const full: GoalEvent = {
      ...event,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      sequence: existing.length + 1,
    };

    validateBySchema("goal-event", full);
    await appendLine(file, JSON.stringify(full));
    return full;
  });
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
    const expectedSequence = events.length + 1;
    if (parsed.sequence !== expectedSequence) {
      throw new Error(`invalid ledger line ${index + 1}: expected sequence ${expectedSequence}, got ${parsed.sequence}`);
    }
    events.push(parsed);
  }

  return events;
}

async function withLedgerLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = ledgerLocks.get(key) ?? unlocked;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  ledgerLocks.set(key, queued);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (ledgerLocks.get(key) === queued) ledgerLocks.delete(key);
  }
}

