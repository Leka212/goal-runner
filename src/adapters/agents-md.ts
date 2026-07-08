export function renderAgentsMd(goalTitle: string): string {
  return `## Goal Protocol

Current goal: ${goalTitle}

Rules:
- Treat .goal/ artifacts and the goal CLI as the provider-neutral source of truth.
- This is generate-only guidance for a local text file; it does not launch runtimes or mutate external systems.
- Work from .goal/goal.yaml, .goal/events.jsonl, and recorded evidence.
- Do not claim completion without evidence from goal verify, goal doctor, or an equivalent recorded check.
- Do not mutate external systems unless the permission tier and gate allow it.
`;
}
