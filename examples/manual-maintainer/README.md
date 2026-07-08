# Manual maintainer example

This directory contains a synthetic, public-safe Goal Protocol configuration for a small open-source maintainer workflow. It is intentionally not connected to a real repository, service, registry account, or automation runner.

## What it demonstrates

- read-only default permissions;
- bounded worker and review limits;
- local verification through `npm test`;
- review gates for publish, release, secrets, and production actions;
- value-bearing redaction patterns for command output;
- OSS dossier metadata for a placeholder project under the public `example` namespace.

## Try it locally

From a disposable workspace after building the CLI:

```bash
node /path/to/goal-runner/dist/cli/index.js init
node /path/to/goal-runner/dist/cli/index.js doctor
```

To use this sample as a starting point, copy `goal.yaml` into your local `.goal/` directory and edit the project name, repository URL, verification commands, and OSS metadata for your own public project.

The sample does not submit data, publish packages, create pull requests, launch agents, or write to external systems. It is only a local configuration file.
