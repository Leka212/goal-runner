export function renderOhMyPiGuide(goalTitle: string): string {
  return `# Oh-My-Pi Goal Protocol guide

Goal: ${goalTitle}

This is generate-only local guidance for Oh-My-Pi operators. It prepares instructions for a local workspace file; the Goal Protocol CLI remains the source of truth for gates, evidence, redaction, and verification.

Required operating loop:
1. Inspect current state with goal query --json before choosing work.
2. Confirm readiness with goal review --stage preflight using the active goal slug, verdict, and reviewer flags.
3. Run goal verify for configured local checks and keep the generated evidence record.
4. Run goal doctor before claiming the workspace is ready.
5. Report completion only with concrete evidence: command evidence from goal verify, review verdicts from goal review, or local structured evidence files referenced by the Goal Protocol ledger.

Safety posture:
- Generate guidance only; do not use this adapter as permission to change remote services, distribute packages, send applications, install MCP integrations, or start background processes.
- Keep all artifacts in the current workspace unless the Goal Protocol configuration and review gate explicitly allow more.
- If evidence is missing or a gate is not satisfied, report the blocker instead of treating the goal as complete.
`;
}
