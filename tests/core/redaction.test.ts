import { describe, expect, it } from "vitest";
import { capOutput, redactText } from "../../src/core/redaction.js";

describe("redaction", () => {
  it("redacts token-like output with configured patterns", () => {
    const output = redactText("Authorization: Bearer abc.def_123\napi_key=secret", [
      "(?i)bearer\\s+[a-z0-9._-]+",
      "(?i)api[_-]?key=\\S+",
    ]);

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("abc.def_123");
    expect(output).not.toContain("secret");
  });

  it("caps output by bytes and records truncation", () => {
    const output = capOutput("0123456789abcdef", 10);

    expect(Buffer.byteLength(output, "utf8")).toBeGreaterThan(10);
    expect(output).toContain("0123456789");
    expect(output).toContain("[TRUNCATED 6 bytes]");
    expect(output).not.toContain("abcdef");
  });
});
