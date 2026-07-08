import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileSha256, readJsonFile, writeJsonFile } from "./fs.js";
import { readEvents, recordEvent } from "./ledger.js";
import { goalRunDir } from "./paths.js";
import { validateBySchema } from "./schemas.js";
import type { EvidenceAddedEventData, EvidenceKind, EvidenceRecord } from "./types.js";

interface ArtifactManifestEntry {
  path: string;
  sha256: string;
}

interface ArtifactManifest {
  artifacts: ArtifactManifestEntry[];
}

export async function addEvidence(root: string, record: Omit<EvidenceRecord, "id" | "created_at">): Promise<EvidenceRecord> {
  const full: EvidenceRecord = { ...record, id: randomUUID(), created_at: new Date().toISOString() };
  validateBySchema("evidence", full);

  const file = `${goalRunDir(root, full.slug)}/evidence/${full.id}.json`;
  await writeJsonFile(file, full);
  const eventData: EvidenceAddedEventData = {
    evidence_id: full.id,
    kind: full.kind,
    artifact_paths: full.artifact_paths,
  };
  if (typeof full.exit_code === "number") eventData.exit_code = full.exit_code;
  if (typeof full.sha256 === "string") eventData.sha256 = full.sha256;
  await recordEvent(root, {
    type: "evidence.added",
    slug: full.slug,
    data: eventData,
  });

  return full;
}

export async function listVerifiedEvidence(root: string, slug: string): Promise<EvidenceRecord[]> {
  const dir = path.join(goalRunDir(root, slug), "evidence");
  const provenance = await evidenceProvenanceKeys(root, slug);
  try {
    const names = await readdir(dir);
    const evidence = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          try {
            const record = await readJsonFile<unknown>(path.join(dir, name));
            validateBySchema("evidence", record);
            if (record.slug !== slug) return null;
            if (record.kind === "command" && record.redaction_applied !== true) return null;
            if (!provenance.has(evidenceProvenanceKey(record))) return null;
            if (!(await evidenceArtifactsValid(record))) return null;
            return record;
          } catch {
            return null;
          }
        }),
    );
    return evidence.filter((record): record is EvidenceRecord => record !== null);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function evidenceProvenanceKeys(root: string, slug: string): Promise<Set<string>> {
  const events = await readEvents(root);
  const provenance = new Set<string>();
  for (const event of events) {
    if (event.type !== "evidence.added" || event.slug !== slug) continue;
    const evidenceId = event.data.evidence_id;
    const kind = event.data.kind;
    const exitCode = event.data.exit_code;
    const sha256 = event.data.sha256;
    const artifactPaths = event.data.artifact_paths;
    if (typeof evidenceId !== "string" || !isEvidenceKind(kind)) continue;
    if (exitCode !== undefined && typeof exitCode !== "number") continue;
    if (sha256 !== undefined && typeof sha256 !== "string") continue;
    if (!isStringArray(artifactPaths)) continue;
    provenance.add(evidenceProvenanceKeyFromParts(evidenceId, kind, exitCode, sha256, artifactPaths));
  }
  return provenance;
}

function evidenceProvenanceKey(record: EvidenceRecord): string {
  return evidenceProvenanceKeyFromParts(record.id, record.kind, record.exit_code, record.sha256, record.artifact_paths);
}

function evidenceProvenanceKeyFromParts(
  evidenceId: string,
  kind: EvidenceKind,
  exitCode: number | undefined,
  sha256: string | undefined,
  artifactPaths: string[],
): string {
  return JSON.stringify([evidenceId, kind, exitCode ?? null, sha256 ?? null, artifactPaths]);
}

async function evidenceArtifactsValid(record: EvidenceRecord): Promise<boolean> {
  if (record.kind === "command") return commandArtifactsValid(record);
  if (typeof record.sha256 !== "string") return true;
  if (record.artifact_paths.length !== 1) return true;
  return (await safeFileSha256(record.artifact_paths[0])) === record.sha256;
}

async function commandArtifactsValid(record: EvidenceRecord): Promise<boolean> {
  if (typeof record.stdout_redacted_path !== "string" || typeof record.stderr_redacted_path !== "string") return false;
  const manifestPath = record.artifact_paths.find((item) => item.endsWith(".sha256.json"));
  if (typeof manifestPath !== "string" || typeof record.sha256 !== "string") return false;
  if (!record.artifact_paths.includes(record.stdout_redacted_path)) return false;
  if (!record.artifact_paths.includes(record.stderr_redacted_path)) return false;
  if (!record.artifact_paths.includes(manifestPath)) return false;
  if ((await safeFileSha256(manifestPath)) !== record.sha256) return false;

  const manifest = await readArtifactManifest(manifestPath);
  if (!manifest) return false;

  const seen = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (!record.artifact_paths.includes(artifact.path)) return false;
    if ((await safeFileSha256(artifact.path)) !== artifact.sha256) return false;
    seen.add(artifact.path);
  }

  return seen.has(record.stdout_redacted_path) && seen.has(record.stderr_redacted_path);
}

async function readArtifactManifest(file: string): Promise<ArtifactManifest | null> {
  try {
    const manifest = await readJsonFile<unknown>(file);
    if (!isArtifactManifest(manifest)) return null;
    return manifest;
  } catch {
    return null;
  }
}

async function safeFileSha256(file: string): Promise<string | null> {
  try {
    return await fileSha256(file);
  } catch {
    return null;
  }
}

function isArtifactManifest(value: unknown): value is ArtifactManifest {
  if (!value || typeof value !== "object" || !("artifacts" in value)) return false;
  const artifacts = value.artifacts;
  return Array.isArray(artifacts) && artifacts.every(isArtifactManifestEntry);
}

function isArtifactManifestEntry(value: unknown): value is ArtifactManifestEntry {
  if (!value || typeof value !== "object") return false;
  if (!("path" in value) || !("sha256" in value)) return false;
  return typeof value.path === "string" && typeof value.sha256 === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return (
    value === "command" ||
    value === "file" ||
    value === "url" ||
    value === "screenshot" ||
    value === "artifact" ||
    value === "manual-attestation"
  );
}
