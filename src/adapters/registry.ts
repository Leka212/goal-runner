export interface AdapterDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly targetFiles: readonly string[];
  readonly aliases?: readonly string[];
  readonly render: (goalTitle: string) => string;
}

import { renderAgentsMd } from "./agents-md.js";
import { renderClaudeSnippet } from "./claude-code.js";
import { renderCodexSkill } from "./codex.js";
import { renderOhMyPiGuide } from "./oh-my-pi.js";

export const adapterRegistry: readonly AdapterDefinition[] = [
  {
    id: "agents-md",
    label: "AGENTS.md",
    description: "Provider-neutral local AGENTS.md guidance for agentic coding tools.",
    targetFiles: ["AGENTS.md"],
    render: renderAgentsMd,
  },
  {
    id: "codex",
    label: "Codex skill",
    description: "Local Codex-compatible skill wrapper around Goal Protocol gates and evidence.",
    targetFiles: [".agents/skills/goal-<slug>/SKILL.md", ".codex/skills/goal-<slug>/SKILL.md"],
    render: renderCodexSkill,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    description: "CLAUDE.md, skill, and subagent-friendly local guidance for Claude Code.",
    targetFiles: ["CLAUDE.md", ".claude/skills/goal-protocol/SKILL.md"],
    aliases: ["claude"],
    render: renderClaudeSnippet,
  },
  {
    id: "oh-my-pi",
    label: "Oh-My-Pi",
    description: "Oh-My-Pi local operator guidance with Goal Protocol preflight and evidence hooks.",
    targetFiles: ["OMP.md", ".oh-my-pi/goal-protocol.md"],
    aliases: ["omp"],
    render: renderOhMyPiGuide,
  },
];

export type AdapterId = "agents-md" | "codex" | "claude-code" | "oh-my-pi";

export function listAdapters(): readonly AdapterDefinition[] {
  return adapterRegistry;
}

export function getAdapter(idOrAlias: string): AdapterDefinition | undefined {
  return adapterRegistry.find((adapter) => adapter.id === idOrAlias || adapter.aliases?.includes(idOrAlias));
}

export function renderAdapter(idOrAlias: string, goalTitle: string): string {
  const adapter = getAdapter(idOrAlias);
  if (!adapter) throw new Error(`unknown adapter: ${idOrAlias}`);
  return adapter.render(goalTitle);
}
