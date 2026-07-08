export function renderCodexSkill(goalTitle: string): string {
  const skillName = `goal-${slugifyGoalTitle(goalTitle)}`;
  return `---
name: ${skillName}
description: provider-neutral Goal Protocol wrapper. Permissions are enforced by the goal CLI, not by this skill frontmatter.
---

# Goal Protocol

Current goal: ${goalTitle}

Use .goal/goal.yaml and .goal/events.jsonl as the source of truth. Start every handoff by reading goal query --json. Use goal review --stage preflight for the review gate, goal verify for configured local checks, and goal doctor before reporting readiness.

This generated text is local, generate-only guidance. Completion claims need evidence from goal verify, review verdicts, or local structured evidence files. Do not use this adapter as permission to change remote services, distribute packages, send applications, install integrations, or start background processes.
`;
}

function slugifyGoalTitle(goalTitle: string): string {
  const slug = goalTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "untitled";
}
