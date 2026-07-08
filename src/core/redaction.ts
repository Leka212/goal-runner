export function redactText(input: string, patterns: string[]): string {
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

function parsePattern(pattern: string): { source: string; flags: string } {
  if (pattern.startsWith("(?i)")) return { source: pattern.slice(4), flags: "gi" };
  return { source: pattern, flags: "g" };
}
