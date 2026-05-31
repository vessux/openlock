# Policies

A sandbox's egress + trust policy lives at `.openlock/policy.yaml`, scaffolded by `openlock init` (the template is shaped by the chosen harness) and linted by `openlock validate`. The full policy schema is in the [agent config reference](./agent-config-reference.md).

The base template ships as `policies/default.yaml`. Point a run at an explicit policy file with `openlock sandbox --policy /abs/path/to/policy.yaml`.
