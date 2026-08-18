# openlock documentation

Start with the [README](../README.md) for the golden path (install → doctor → init → validate → sandbox).

## Guides

- [Quickstart](./quickstart.md) — the golden path, end to end, plus the harness/provider pairing table
- [Tutorial: fix a bug in a sandbox](./tutorial.md) — a full session walkthrough, including what to ignore in `openlock logs`
- [Recipes](./recipes.md) — copy-paste config snippets (CPU/memory limits, harness pins, secondary credentials, egress allowlists) and a custom `.openlock/Containerfile` walkthrough (Playwright + Chromium)

## Reference

- [Installation & shell completion](./installation.md)
- [Sessions: picker & lifecycle](./sessions.md)
- [Mounts, args & env](./mounts.md)
- [Policies](./policies.md)
- [Security & runtime](./security.md)
- [Agent config reference](./agent-config-reference.md) — complete machine-readable config/policy schema + decision procedure for AI agents

## Maintainers

- [Releasing](./releasing.md) — how a release is cut across both repos, how the `openlock-base` image is managed, and when to cut a prerelease
