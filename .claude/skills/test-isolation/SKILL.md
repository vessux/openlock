---
name: test-isolation
description: Use when writing or reviewing a test in this repo that touches config, credentials, the gateway, a sandbox, or any other host/external state.
---

## The seams, and the one that looks like a seam but isn't

- Use `OPENLOCK_CONFIG_DIR` to redirect config/credentials to a throwaway directory, and
  `OPENLOCK_DISPOSABLE_HOST` as a fail-closed marker for anything that genuinely needs a
  disposable machine (e.g. CI) rather than a real dev box.
- **`XDG_CONFIG_HOME` is not an isolation lever.** The container runtime honours it for its own
  config and a spawned openlock process inherits it unchanged, so overriding it doesn't stop
  either side from reaching real state — it just relocates where you *think* you pointed them.
- These seams are partial by design. Check what a given seam actually covers before trusting it
  to cover everything a test touches — a seam over local config files, for instance, says
  nothing about a gateway registry keyed by a fixed name elsewhere.
- **Gateway credential *values* cannot be read back** (only name/type/key metadata is ever
  printed). A test that would need to inspect or restore a real gateway credential has no way to
  verify or undo what it did — refuse to run rather than improvise a backup/restore, and never
  substitute "be careful" for an actual mechanism. Backing up real state before mutating it is an
  anti-pattern, not a safeguard: it only has to lose a race with its own control flow once.

## Timeout and hook mechanics (bun:test)

- **On a test timeout, `afterEach`/`afterAll` run, but an in-body `try/finally` does not.**
  Cleanup for any resource acquired outside the process (a gateway provider, a container, a
  sandbox) belongs in a hook, keyed off a registry the test body populates as it creates each
  resource — never in the test body's own `finally`, which silently leaks on every timeout.
- **Hooks do not inherit the test's own timeout — they default to 5000ms.** A cleanup hook doing
  real teardown work under a test with a longer budget needs its own explicit timeout, e.g.
  `afterAll(fn, 120_000)`. Without it the hook itself times out mid-cleanup, which can leave the
  resource in a worse state than skipping cleanup entirely.
- **Sandbox deletion is asynchronous: exit 0 means accepted, not done.** Poll for the terminal
  state rather than proceeding immediately — an in-progress teardown can still block whatever
  cleanup step runs next.

## Compiled-binary behavior differs from the interpreter

- `bun build --compile` binaries hold the event loop open until every handle is unref'd or the
  process calls `process.exit()` — the interpreter auto-exits past a dangling handle, so a test
  run only through the interpreter can hide a real hang that exists in the shipped binary.
- A long-lived child spawned with inherited stdout keeps the **parent's** stdout file descriptor
  open even after the parent process exits, which hangs any caller that captures output (a pipe,
  `$(...)`, CI log capture) even though an interactive terminal never notices it. Test this class
  of behavior by running the command through a pipe, not bare in a TTY.

## Gate design

- `knip`'s configured scope only covers `src/**/*.ts` — it is blind to `tests/`, so a dead test
  helper under `tests/` gets no automated flag at all. Keeping such helpers wired to a real
  caller is a manual obligation, not something tooling will catch.
- A feature that runs on every CLI invocation, not just the command under test, turns every test
  that doesn't explicitly isolate it into a real-state writer. Check what fires unconditionally
  at the top of the CLI entrypoint, not just what the test itself calls.
- When adding a grep-based safety gate, key it on the actual precedence/condition that makes
  state real, not on a single variable's mere presence — a gate keyed on the wrong variable
  false-positives on genuinely safe files, and flagging safe files is how a gate ends up
  weakened or silenced rather than fixed.
- Verify a gate's exit code **unpiped**. `$?` after a pipe (e.g. into `tail`) reports the last
  command in the pipe, not the one you actually care about, and can report success for a gate
  that is in fact failing.
