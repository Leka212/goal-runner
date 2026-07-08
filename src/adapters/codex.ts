export function renderCodexSkill(goalTitle: string): string {
  const skillName = `goal-${slugifyGoalTitle(goalTitle)}`;
  return `---
name: ${skillName}
description: provider-neutral Goal Protocol wrapper. Permissions are enforced by the goal CLI, not by this skill frontmatter.
---

# Goal Protocol

Current goal: ${goalTitle}

Use .goal/goal.yaml and .goal/events.jsonl as the source of truth. Run goal verify and goal doctor before reporting done. This generated text is local guidance only: do not publish packages, enable remote automation, create public repositories, or mutate external services from this adapter.
`;
}

function slugifyGoalTitle(goalTitle: string): string {
  const slug = goalTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "untitled";
}
