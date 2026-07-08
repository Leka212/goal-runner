import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadGoalConfig } from "./config.js";
import { addEvidence } from "./evidence.js";
import { ensureDir, fileSha256, writeJsonFile } from "./fs.js";
import { goalRunDir } from "./paths.js";
import { redactText } from "./redaction.js";
import type { EvidenceRecord, VerificationCommand } from "./types.js";

interface OutputCapture {
  append(chunk: Buffer | string): void;
  text(): string;
}

interface ArtifactHash {
  path: string;
  sha256: string;
}

interface VerificationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function verifyCommand(root: string, slug: string, commandId: string): Promise<EvidenceRecord> {
  const config = await loadGoalConfig(root);
  const command = config.verification.commands.find((item) => item.id === commandId);
  if (!command) throw new Error(`unknown verification command: ${commandId}`);
  assertArgvCommand(command);

  const outputDir = path.join(goalRunDir(root, slug), "evidence", "redacted-output");
  await ensureDir(outputDir);

  const result = await runVerification(root, command, config.redaction.deny_output_patterns);
  const stdoutPath = path.join(outputDir, `${commandId}.stdout.txt`);
  const stderrPath = path.join(outputDir, `${commandId}.stderr.txt`);
  await writeFile(stdoutPath, result.stdout, "utf8");
  await writeFile(stderrPath, result.stderr, "utf8");

  const artifactHashes: ArtifactHash[] = [
    { path: stdoutPath, sha256: await fileSha256(stdoutPath) },
    { path: stderrPath, sha256: await fileSha256(stderrPath) },
  ];
  const manifestPath = path.join(outputDir, `${commandId}.sha256.json`);
  await writeJsonFile(manifestPath, { artifacts: artifactHashes });

  return addEvidence(root, {
    slug,
    kind: "command",
    command: command.argv,
    exit_code: result.exitCode,
    stdout_redacted_path: stdoutPath,
    stderr_redacted_path: stderrPath,
    artifact_paths: [stdoutPath, stderrPath, manifestPath],
    sha256: await fileSha256(manifestPath),
    redaction_applied: command.redact,
  });
}

function assertArgvCommand(command: VerificationCommand): void {
  if (!Array.isArray(command.argv) || command.argv.length === 0) {
    throw new Error(`verification command ${command.id} must use argv[]`);
  }
}

async function runVerification(root: string, command: VerificationCommand, patterns: string[]): Promise<VerificationResult> {
  const stdout = createOutputCapture(command.output_byte_cap);
  const stderr = createOutputCapture(command.output_byte_cap);
  const { promise, resolve } = Promise.withResolvers<number>();
  let settled = false;
  let timedOut = false;
  let forceTimer: NodeJS.Timeout | undefined;

  const child = spawn(command.argv[0], command.argv.slice(1), { cwd: root, env: {}, shell: false });
  child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
  child.on("error", (error) => {
    stderr.append(`${error.name}: ${error.message}\n`);
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    stderr.append(`verification command timed out after ${command.timeout_seconds} seconds\n`);
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  }, command.timeout_seconds * 1_000);

  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(forceTimer);
    resolve(timedOut ? 124 : (code ?? 1));
  });

  const exitCode = await promise;
  const cappedStdout = stdout.text();
  const cappedStderr = stderr.text();

  return {
    exitCode,
    stdout: command.redact ? redactText(cappedStdout, patterns) : cappedStdout,
    stderr: command.redact ? redactText(cappedStderr, patterns) : cappedStderr,
  };
}

function createOutputCapture(maxBytes: number): OutputCapture {
  const limit = Math.max(0, maxBytes);
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncatedBytes = 0;

  return {
    append(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const remaining = limit - capturedBytes;
      if (remaining > 0) {
        const captured = buffer.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.byteLength;
        truncatedBytes += buffer.byteLength - captured.byteLength;
        return;
      }
      truncatedBytes += buffer.byteLength;
    },
    text(): string {
      const captured = Buffer.concat(chunks).toString("utf8");
      if (truncatedBytes === 0) return captured;
      return `${captured}\n[TRUNCATED ${truncatedBytes} bytes]`;
    },
  };
}
