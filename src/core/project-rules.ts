import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileSha256 } from "./fs.js";
import { readEvents, recordEvent } from "./ledger.js";
import type { GoalEvent } from "./types.js";

export const PROJECT_RULES_SLUG = "__project_rules__";

export type ProjectRuleKind = "code_of_conduct" | "contributing" | "security" | "pull_request_template" | "release_policy" | "agent_instructions";

export interface ProjectRuleFile {
  kind: ProjectRuleKind;
  path: string;
  sha256: string;
}

export interface ProjectRulesSnapshot {
  event_id: string;
  sequence: number;
  recorded_at: string;
  goal_slug: string | null;
  files: ProjectRuleFile[];
}

export interface ProjectRulesState {
  discovered: ProjectRuleFile[];
  discovered_count: number;
  snapshot: ProjectRulesSnapshot | null;
  missing_snapshot: boolean;
  stale: boolean;
  satisfied: boolean;
  errors: string[];
}

interface RuleCandidate {
  kind: ProjectRuleKind;
  absolutePath: string;
  priority: number;
}

const fixedRules: Array<{ kind: ProjectRuleKind; relativePath: string; priority: number }> = [
  { kind: "code_of_conduct", relativePath: "CODE_OF_CONDUCT.md", priority: 0 },
  { kind: "contributing", relativePath: "CONTRIBUTING.md", priority: 1 },
  { kind: "security", relativePath: "SECURITY.md", priority: 2 },
  { kind: "pull_request_template", relativePath: ".github/pull_request_template.md", priority: 4 },
  { kind: "release_policy", relativePath: "RELEASE.md", priority: 5 },
  { kind: "release_policy", relativePath: "RELEASE_POLICY.md", priority: 5 },
  { kind: "release_policy", relativePath: ".github/release.yml", priority: 5 },
  { kind: "agent_instructions", relativePath: "AGENTS.md", priority: 6 },
  { kind: "agent_instructions", relativePath: "CLAUDE.md", priority: 6 },
  { kind: "agent_instructions", relativePath: ".github/copilot-instructions.md", priority: 6 },
];

export async function discoverProjectRules(root: string): Promise<ProjectRuleFile[]> {
  const candidates: RuleCandidate[] = [];

  for (const rule of fixedRules) {
    const absolutePath = path.join(root, rule.relativePath);
    if (await isRegularFile(absolutePath)) candidates.push({ kind: rule.kind, absolutePath, priority: rule.priority });
  }

  const templateDir = path.join(root, ".github", "PULL_REQUEST_TEMPLATE");
  try {
    const entries = await readdir(templateDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      candidates.push({ kind: "pull_request_template", absolutePath: path.join(templateDir, entry.name), priority: 3 });
    }
  } catch (error: unknown) {
    if (!isNoEntry(error)) throw error;
  }

  const cursorRulesDir = path.join(root, ".cursor", "rules");
  try {
    const entries = await readdir(cursorRulesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".mdc")) continue;
      candidates.push({ kind: "agent_instructions", absolutePath: path.join(cursorRulesDir, entry.name), priority: 6 });
    }
  } catch (error: unknown) {
    if (!isNoEntry(error)) throw error;
  }

  const rules = await Promise.all(
    candidates.map(async (candidate) => ({
      kind: candidate.kind,
      path: workspaceRelativePath(root, candidate.absolutePath),
      sha256: await fileSha256(candidate.absolutePath),
      priority: candidate.priority,
    })),
  );

  return rules
    .sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path))
    .map(({ priority: _discarded, ...rule }) => rule);
}

export async function recordProjectRulesSnapshot(root: string, options: { goalSlug?: string } = {}): Promise<ProjectRulesSnapshot> {
  const files = await discoverProjectRules(root);
  const event = await recordEvent(root, {
    type: "project_rules.snapshot",
    slug: PROJECT_RULES_SLUG,
    data: {
      files,
      rule_count: files.length,
      ...(options.goalSlug ? { goal_slug: options.goalSlug } : {}),
    },
  });
  return snapshotFromEvent(event)!;
}

export async function readProjectRulesState(root: string): Promise<ProjectRulesState> {
  const [discovered, events] = await Promise.all([discoverProjectRules(root), readEvents(root)]);
  const snapshot = latestSnapshot(events);
  const errors = projectRuleSnapshotErrors(discovered, snapshot);
  const missingSnapshot = discovered.length > 0 && snapshot === null;
  const stale = snapshot !== null && errors.length > 0;

  return {
    discovered,
    discovered_count: discovered.length,
    snapshot,
    missing_snapshot: missingSnapshot,
    stale,
    satisfied: !missingSnapshot && !stale,
    errors,
  };
}

export function projectRuleDoctorErrors(state: ProjectRulesState): string[] {
  if (state.stale) return state.errors.map((error) => `stale project-rule snapshot: ${error}`);
  if (state.missing_snapshot) {
    return [`missing project-rule snapshot for ${state.discovered_count} local project rule file(s): ${state.discovered.map((rule) => rule.path).join(", ")}`];
  }
  return [];
}

function latestSnapshot(events: GoalEvent[]): ProjectRulesSnapshot | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshotFromEvent(events[index]);
    if (snapshot) return snapshot;
  }
  return null;
}

function snapshotFromEvent(event: GoalEvent): ProjectRulesSnapshot | null {
  if (event.type !== "project_rules.snapshot") return null;
  const files = event.data.files;
  if (!isProjectRuleFiles(files)) return null;
  return {
    event_id: event.id,
    sequence: event.sequence,
    recorded_at: event.created_at,
    goal_slug: typeof event.data.goal_slug === "string" ? event.data.goal_slug : null,
    files: files.map((file) => ({ ...file })),
  };
}

function projectRuleSnapshotErrors(discovered: ProjectRuleFile[], snapshot: ProjectRulesSnapshot | null): string[] {
  if (discovered.length === 0) {
    return snapshot?.files.length ? [`snapshot includes ${snapshot.files.length} project rule file(s), but no local project rule files are currently detected`] : [];
  }
  if (snapshot === null) return [];

  const errors: string[] = [];
  const currentByPath = new Map(discovered.map((rule) => [rule.path, rule]));
  const snapshottedByPath = new Map(snapshot.files.map((rule) => [rule.path, rule]));

  for (const current of discovered) {
    const snapshotted = snapshottedByPath.get(current.path);
    if (!snapshotted) {
      errors.push(`missing ${current.path}`);
      continue;
    }
    if (snapshotted.kind !== current.kind) errors.push(`${current.path} kind changed from ${snapshotted.kind} to ${current.kind}`);
    if (snapshotted.sha256 !== current.sha256) errors.push(`${current.path} hash changed`);
  }

  for (const snapshotted of snapshot.files) {
    if (!currentByPath.has(snapshotted.path)) errors.push(`${snapshotted.path} no longer exists`);
  }

  return errors;
}

function isProjectRuleFiles(value: unknown): value is ProjectRuleFile[] {
  return Array.isArray(value) && value.every(isProjectRuleFile);
}

function isProjectRuleFile(value: unknown): value is ProjectRuleFile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return isProjectRuleKind(record.kind) && typeof record.path === "string" && /^[a-f0-9]{64}$/.test(String(record.sha256));
}

function isProjectRuleKind(value: unknown): value is ProjectRuleKind {
  return (
    value === "code_of_conduct" ||
    value === "contributing" ||
    value === "security" ||
    value === "pull_request_template" ||
    value === "release_policy" ||
    value === "agent_instructions"
  );
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error: unknown) {
    if (isNoEntry(error)) return false;
    throw error;
  }
}

function workspaceRelativePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function isNoEntry(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
