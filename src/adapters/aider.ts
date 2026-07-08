export function renderAiderGuide(goalTitle: string): string {
  return `# Aider Goal Protocol guide

Goal: ${goalTitle}

This is generate-only local guidance for Aider. Use it as prompt/context text only; the Goal Protocol CLI remains the source of truth for goal state, gates, redaction, verification, and evidence reporting hooks.

Required operating loop:
1. Inspect current state with goal query --json before choosing or editing work.
2. Complete the preflight review gate with goal review --stage preflight using the active goal slug, verdict, and reviewer flags.
3. Run goal verify for configured local checks and keep the generated evidence record.
4. Run goal doctor before reporting that the workspace is ready.
5. Report completion only with concrete evidence from goal verify, review verdicts from goal review, or local structured evidence files referenced by the Goal Protocol ledger.

Safety posture:
- Generate guidance only; do not use this adapter as permission to start agents, change remote services, distribute packages, send applications, install integrations, or start background processes.
- Keep Aider instructions and artifacts in the current workspace unless Goal Protocol configuration and review gates explicitly allow more.
- If evidence is missing or a gate is not satisfied, report the blocker instead of treating the goal as complete.
`;
}
