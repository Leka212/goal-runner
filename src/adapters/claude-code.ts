export function renderClaudeSnippet(goalTitle: string): string {
  return `# Goal Protocol thin wrapper

Goal: ${goalTitle}

Use the provider-neutral goal CLI as source of truth. This runtime-specific text is a thin wrapper for local guidance only; core validation, gates, redaction, and allowlists remain authoritative.

Before reporting done, check .goal/goal.yaml, .goal/events.jsonl, recorded evidence, goal verify, and goal doctor. Do not publish packages, create public repositories, enable remote automation, or mutate external services from this adapter.
`;
}
