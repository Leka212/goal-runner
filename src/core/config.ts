import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { ensureDir } from "./fs.js";
import { validateBySchema } from "./schemas.js";
import type { GoalConfig } from "./types.js";

const permissionTiers = ["read", "suggest", "comment", "branch", "release", "admin"] as const;

export function defaultGoalConfig(projectName: string): GoalConfig {
  return {
    project: { name: projectName, public_safe: true },
    limits: {
      max_iterations: 8,
      max_minutes: 45,
      max_workers: 4,
      max_review_rounds: 3,
      stale_no_output_seconds: 900,
      require_explicit_next_decision: true,
      kill_switch_file: ".goal/KILL",
    },
    permissions: {
      default_tier: "read",
      tiers: [...permissionTiers],
      fork_pr_safe_mode: true,
    },
    verification: {
      commands: [
        {
          id: "unit",
          argv: ["npm", "test"],
          timeout_seconds: 120,
          required_for_done: true,
          redact: true,
          output_byte_cap: 20_000,
        },
      ],
    },
    gates: {
      require_review_for: ["publish", "release", "secrets", "prod"],
      review_verdicts: { allowed: ["GO", "GO-WITH-RISKS"] },
    },
    redaction: {
      deny_env_patterns: ["TOKEN", "SECRET", "KEY", "PASSWORD", "COOKIE"],
      deny_path_patterns: [".env", "credentials", "id_rsa", ".pem"],
      deny_output_patterns: ["(?i)api[_-]?key", "(?i)bearer\\s+[a-z0-9._-]+"],
    },
    oss: { registries: ["npm"], package_names: [] },
  };
}

export async function writeDefaultGoalConfig(root: string): Promise<void> {
  await ensureDir(path.join(root, ".goal"));
  const config = defaultGoalConfig(path.basename(root));
  await writeFile(path.join(root, ".goal", "goal.yaml"), YAML.stringify(config), "utf8");
}

export async function loadGoalConfig(root: string): Promise<GoalConfig> {
  const raw = await readFile(path.join(root, ".goal", "goal.yaml"), "utf8");
  const parsed: unknown = YAML.parse(raw);
  validateBySchema("goal-config", parsed);
  return parsed;
}
