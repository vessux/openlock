#!/usr/bin/env bun
import type { SessionMeta } from "../sandbox/session-store";
import { defaultPickerIO, pickSession } from "./_picker";

if (process.env.OPENLOCK_PICKER_SMOKE !== "1") {
  console.error("This file is a test fixture; set OPENLOCK_PICKER_SMOKE=1");
  process.exit(2);
}

const sessions: SessionMeta[] = [
  {
    id: "a",
    name: "alpha",
    repoPath: "/tmp/alpha",
    image: "img",
    policy: "default",
    createdAt: "2026-05-09T00:00:00Z",
    lastAttachedAt: null,
    attachedPid: null,
    harness: "claude_code",
  },
  {
    id: "b",
    name: "beta",
    repoPath: "/tmp/beta",
    image: "img",
    policy: "default",
    createdAt: "2026-05-09T00:00:00Z",
    lastAttachedAt: null,
    attachedPid: null,
    harness: "claude_code",
  },
];

// Create a custom IO that overrides isTTY and disables fzf
// We can't just spread defaultPickerIO() because isTTY is read at construction time
const baseIO = defaultPickerIO();
const ioWithTTY = {
  isTTY: true, // Override this so the picker doesn't return null immediately
  readLine: baseIO.readLine,
  writeStderr: baseIO.writeStderr,
  detectFzf: () => false, // Disable fzf for the test fixture
  runFzf: baseIO.runFzf,
};

const picked = await pickSession(sessions, "smoke", ioWithTTY);
process.stdout.write(picked === null ? "<null>" : picked.name);
process.exit(0);
