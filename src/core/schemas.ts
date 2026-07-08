import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import evidenceSchema from "../../schemas/evidence.schema.json" with { type: "json" };
import goalConfigSchema from "../../schemas/goal-config.schema.json" with { type: "json" };
import goalEventSchema from "../../schemas/goal-event.schema.json" with { type: "json" };
import reviewVerdictSchema from "../../schemas/review-verdict.schema.json" with { type: "json" };
import type { EvidenceRecord, GoalConfig, GoalEvent, ReviewVerdict } from "./types.js";

export type SchemaName = "goal-config" | "goal-event" | "evidence" | "review-verdict";

type SchemaValueMap = {
  "goal-config": GoalConfig;
  "goal-event": GoalEvent;
  evidence: EvidenceRecord;
  "review-verdict": ReviewVerdict;
};

const ajv = new Ajv2020({ allErrors: true });

const validators: Record<SchemaName, ValidateFunction> = {
  "goal-config": ajv.compile(goalConfigSchema),
  "goal-event": ajv.compile(goalEventSchema),
  evidence: ajv.compile(evidenceSchema),
  "review-verdict": ajv.compile(reviewVerdictSchema),
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
