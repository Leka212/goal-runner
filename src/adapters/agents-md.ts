export function renderAgentsMd(goalTitle: string): string {
  return `## Goal Protocol

Current goal: ${goalTitle}

Rules:
- Treat .goal/ artifacts and the goal CLI as the provider-neutral source of truth.
- This is generate-only guidance for a local text file.
- Start from goal query --json, .goal/goal.yaml, .goal/events.jsonl, and recorded evidence.
- Use goal review --stage preflight before work that needs a gate.
- Use goal verify for configured checks and goal doctor before reporting readiness.
- Report completion only with evidence from goal verify, review verdicts, or local structured evidence files.
- Do not use this adapter as permission to change remote services, distribute packages, send applications, install integrations, or start background processes.
`;
}
