export const MANDATORY_OUTPUT_REDACTION_PATTERNS = [
  "(?i)\\bapi[_-]?key\\s*[:=]\\s*\\S+",
  "(?i)\\bauthorization\\s*:\\s*bearer\\s+\\S+",
  "(?i)\\bbearer\\s+[a-z0-9._~+/=-]+",
] as const;

export function redactText(input: string, patterns: readonly string[]): string {
  return patterns.reduce((text, pattern) => {
    const { source, flags } = parsePattern(pattern);
    return text.replace(new RegExp(source, flags), "[REDACTED]");
  }, input);
}

export function capOutput(input: string, maxBytes: number): string {
  const limit = Math.max(0, maxBytes);
  const buffer = Buffer.from(input, "utf8");
  if (buffer.byteLength <= limit) return input;

  const visible = buffer.subarray(0, limit).toString("utf8");
  return `${visible}\n[TRUNCATED ${buffer.byteLength - limit} bytes]`;
}

export function detectPublishLeaks(text: string): string[] {
  const findings: string[] = [];
  if (hasSecretLikeText(text)) findings.push("secret-like token text");
  if (/\/home\/(?!example\b)[A-Za-z0-9._-]+\b/.test(text)) findings.push("private home path");
  if (/\b[A-Z][A-Za-z0-9_-]*(?:Internal|Private)[A-Za-z0-9_-]*\b/.test(text)) {
    findings.push("internal/private marker");
  }
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text)) findings.push("ip address");
  return findings;
}

function hasSecretLikeText(text: string): boolean {
  return (
    /\b(?:TOKEN|SECRET|PASSWORD|COOKIE|API[_-]?KEY)\b\s*[:=]/i.test(text) ||
    /\bAuthorization\s*:\s*Bearer\s+\S+/i.test(text) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i.test(text) ||
    /\b\.env(?:\.[A-Za-z0-9_-]+)?\b/i.test(text)
  );
}

function parsePattern(pattern: string): { source: string; flags: string } {
  if (pattern.startsWith("(?i)")) return { source: pattern.slice(4), flags: "gi" };
  return { source: pattern, flags: "g" };
}
