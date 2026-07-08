export interface ClaudeForOssDossierInput {
  subject: string;
  verified: string[];
  unknown: string[];
  inferred: string[];
  unmet: string[];
}

const inferenceMarker = "[INFERENCE]";

function normalizeInference(item: string): string {
  const trimmed = item.trim();
  if (trimmed.length === 0) return inferenceMarker;
  return trimmed.startsWith(inferenceMarker) ? trimmed : `${inferenceMarker} ${trimmed}`;
}

function list(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

export function buildClaudeForOssDossier(input: ClaudeForOssDossierInput): string {
  const inferred = input.inferred.map(normalizeInference);
  return `# Claude for Open Source dossier — ${input.subject}\n\n## Verified facts\n\n${list(input.verified)}\n\n## Unknown or missing\n\n${list(input.unknown)}\n\n## Inferences\n\n${list(inferred)}\n\n## Unmet criteria\n\n${list(input.unmet)}\n\n## Responsible use\n\n- No fake stars, downloads, dependents, PRs, maintainer rights, or affiliations are claimed.\n- Agentic work is bounded by iteration limits, review gates, redaction, and evidence-before-claim rules.\n`;
}
