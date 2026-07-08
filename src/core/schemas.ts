import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { EvidenceRecord, GoalConfig, GoalEvent, OssAudit, ReviewVerdict, RouteCard, WorkerCard } from "./types.js";

export type SchemaName =
  | "goal-config"
  | "goal-event"
  | "evidence"
  | "review-verdict"
  | "route-card"
  | "worker-card"
  | "oss-audit";

type SchemaValueMap = {
  "goal-config": GoalConfig;
  "goal-event": GoalEvent;
  evidence: EvidenceRecord;
  "review-verdict": ReviewVerdict;
  "route-card": RouteCard;
  "worker-card": WorkerCard;
  "oss-audit": OssAudit;
};

type CompilableSchema = Parameters<Ajv2020["compile"]>[0];

const ajv = new Ajv2020({ allErrors: true });

const schemas: Record<SchemaName, CompilableSchema> = {
  "goal-config": JSON.parse(
    readFileSync(new URL("../../schemas/goal-config.schema.json", import.meta.url), "utf8"),
  ) as CompilableSchema,
  "goal-event": JSON.parse(
    readFileSync(new URL("../../schemas/goal-event.schema.json", import.meta.url), "utf8"),
  ) as CompilableSchema,
  evidence: JSON.parse(
    readFileSync(new URL("../../schemas/evidence.schema.json", import.meta.url), "utf8"),
  ) as CompilableSchema,
  "review-verdict": JSON.parse(
    readFileSync(new URL("../../schemas/review-verdict.schema.json", import.meta.url), "utf8"),
  ) as CompilableSchema,
  "route-card": JSON.parse(
    readFileSync(new URL("../../schemas/route-card.schema.json", import.meta.url), "utf8"),
  ) as CompilableSchema,
  "worker-card": JSON.parse(
    readFileSync(new URL("../../schemas/worker-card.schema.json", import.meta.url), "utf8"),
  ) as CompilableSchema,
  "oss-audit": JSON.parse(
    readFileSync(new URL("../../schemas/oss-audit.schema.json", import.meta.url), "utf8"),
  ) as CompilableSchema,
};

const validators: Record<SchemaName, ValidateFunction> = {
  "goal-config": ajv.compile(schemas["goal-config"]),
  "goal-event": ajv.compile(schemas["goal-event"]),
  evidence: ajv.compile(schemas.evidence),
  "review-verdict": ajv.compile(schemas["review-verdict"]),
  "route-card": ajv.compile(schemas["route-card"]),
  "worker-card": ajv.compile(schemas["worker-card"]),
  "oss-audit": ajv.compile(schemas["oss-audit"]),
};

export function validateBySchema<Name extends SchemaName>(
  name: Name,
  value: unknown,
): asserts value is SchemaValueMap[Name] {
  const validate = validators[name];
  if (!validate(value)) {
    const details = ajv.errorsText(validate.errors, { separator: "; " });
    throw new Error(`${name} schema validation failed: ${details}`);
  }
}
