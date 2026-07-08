export function renderClaudeSnippet(goalTitle: string): string {
  return `# Claude Code Goal Protocol guide for CLAUDE.md, skills, and subagent instructions

Goal: ${goalTitle}

Use the provider-neutral goal CLI as source of truth. This Claude Code text is a thin wrapper for local generate-only guidance; core validation, gates, redaction, and allowlists remain authoritative in Goal Protocol.

Recommended local files:
- CLAUDE.md for repository-level instructions.
- .claude/skills/goal-protocol/SKILL.md when a reusable skill is useful.
- Subagent assignment text that repeats the same gates and evidence hooks.

Required operating loop:
1. Inspect the current goal state with goal query --json before choosing work.
2. Record or require preflight approval with goal review --stage preflight using the active goal slug, verdict, and reviewer flags.
3. Run goal verify for configured local checks and keep the generated evidence record.
4. Run goal doctor before claiming the workspace is ready.
5. Report completion only with concrete evidence: command evidence from goal verify, review verdicts from goal review, or local structured evidence files referenced by the Goal Protocol ledger.

Safety posture:
- Generate guidance only; do not use this adapter as permission to change remote services, distribute packages, send applications, install MCP integrations, or start background processes.
- Keep CLAUDE.md, skills, and subagent instructions local unless Goal Protocol gates explicitly allow more.
- If evidence is missing or a gate is not satisfied, report the blocker instead of treating the goal as complete.
`;
}
