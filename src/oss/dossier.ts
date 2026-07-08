export interface ClaudeForOssDossierInput {
  subject: string;
  verified: string[];
  unknown: string[];
  inferred: string[];
  unmet: string[];
}

function list(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

export function buildClaudeForOssDossier(input: ClaudeForOssDossierInput): string {
  return `# Claude for Open Source dossier — ${input.subject}\n\n## Verified facts\n\n${list(input.verified)}\n\n## Unknown or missing\n\n${list(input.unknown)}\n\n## Inferences\n\n${list(input.inferred)}\n\n## Unmet criteria\n\n${list(input.unmet)}\n\n## Responsible use\n\n- No fake stars, downloads, dependents, PRs, maintainer rights, or affiliations are claimed.\n- Agentic work is bounded by iteration limits, review gates, redaction, and evidence-before-claim rules.\n`;
}
