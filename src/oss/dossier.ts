import { MANDATORY_OUTPUT_REDACTION_PATTERNS, redactText } from "../core/redaction.js";

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
  const subject = publicSafeDossierText(input.subject);
  const verified = input.verified.map(publicSafeDossierText);
  const unknown = input.unknown.map(publicSafeDossierText);
  const inferred = input.inferred.map((item) => publicSafeDossierText(normalizeInference(item)));
  const unmet = input.unmet.map(publicSafeDossierText);
  return `# Claude for Open Source dossier — ${subject}\n\n## Verified facts\n\n${list(verified)}\n\n## Unknown or missing\n\n${list(unknown)}\n\n## Inferences\n\n${list(inferred)}\n\n## Unmet criteria\n\n${list(unmet)}\n\n## Responsible use\n\n- No fake stars, downloads, dependents, PRs, maintainer rights, or affiliations are claimed.\n- Agentic work is bounded by iteration limits, review gates, redaction, and evidence-before-claim rules.\n`;
}

function publicSafeDossierText(value: string): string {
  return redactText(value, MANDATORY_OUTPUT_REDACTION_PATTERNS)
    .replace(/\b(?:TOKEN|SECRET|PASSWORD|COOKIE|API[_-]?KEY)\b\s*[:=]\s*\S+/gi, "[REDACTED]")
    .replace(/\bAuthorization\s*:\s*Bearer\s+\S+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "[REDACTED]")
    .replace(/\/home\/(?!example\b)[A-Za-z0-9._-]+(?:\/[^\s)|,;]*)?/g, "/home/example/[REDACTED]")
    .replace(/\b\.env(?:\.[A-Za-z0-9_-]+)?\b/gi, "[REDACTED_PATH]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[REDACTED_IP]")
    .replace(/\b[A-Z][A-Za-z0-9_-]*(?:Internal|Private)[A-Za-z0-9_-]*\b/g, "[REDACTED_MARKER]");
}
