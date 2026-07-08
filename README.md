# Goal Protocol

Goal Protocol is a provider-neutral evidence layer for AI-assisted open-source maintenance.

It does not replace Claude Code, Codex, Cline, Aider, OpenHands, Taskmaster, PR-Agent, Release Please, or GitHub release notes. It gives those tools a shared maintainer goal format, append-only evidence ledger, review gates, and publish-safe dossier workflow.

Default posture:

- read-only first;
- generate-only adapters;
- no external writes;
- no publish or application submission;
- no completion claim without evidence;
- redaction before public output.

This MVP is local-only. Commands operate on files in the current workspace, and runtime adapters only print or write generated guidance for another tool to consume later. The CLI does not open pull requests, publish packages, submit applications, upload dossiers, trigger hosted automation, or mutate external services.

## What is included

- YAML goal configuration with permission tiers, iteration limits, verification commands, review gates, and redaction rules.
- Append-only `.goal/events.jsonl` ledger plus derived local status and dashboard files.
- Evidence capture for configured local commands with timeouts, output caps, hashes, and redacted artifacts.
- Review gates that block `done` when required evidence or admissible review verdicts are missing.
- OSS dossier helpers that keep verified, unknown, inferred, and unmet facts separate.
- Generate-only adapters for agent instruction files and runtime snippets.
- Public leak checks for README, examples, and generated adapter output before publication.

## Local workflow

```bash
npm install
npm run typecheck
npm test
npm run build
```

Initialize a workspace:

```bash
node dist/cli/index.js init
node dist/cli/index.js doctor
```

Generate adapter guidance without launching an agent:

```bash
node dist/cli/index.js adapt agents-md "Synthetic Goal"
```

Run a public-safety check on a file:

```bash
node dist/cli/index.js publish-check README.md
```

See `examples/manual-maintainer/` for a synthetic maintainer configuration that is safe to copy into local tests.
