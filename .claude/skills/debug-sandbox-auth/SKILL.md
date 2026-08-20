---
name: debug-sandbox-auth
description: Use when a harness inside a sandbox hits a 401/403, "please log in", or another unexplained auth failure talking to a provider.
---

Work this as an ordered procedure, not a checklist of facts — stop at the first step that
explains the failure.

1. **Read `openlock logs <name>` first, not the host gateway log.** Credential-injection
   decisions and the actual egress happen in the in-container supervisor, which has to see and
   rewrite the wire traffic; the host gateway only ever sees control-plane calls (session/config
   RPCs), never the request to the provider itself. Concluding "nothing happened" from an empty
   gateway log has produced wrong diagnoses before — absence there is not evidence of absence.
2. **The egress log is asymmetric: silent on injection success, loud on failure.** An empty
   count of the failure string over that log (e.g. a relay-error grep) is itself the positive
   signal that injection worked — no debug capture needed to confirm success. Before trusting an
   absence, though, confirm the failure mode you're worried about is one the log actually
   instruments; a silent log only clears the cases it emits an error line for in the first
   place.
3. **If the provider host you expect never appears in the log at all, that is usually not a
   credential fault.** It usually means inference was never attempted — look for an earlier
   request to a *different* host (a metadata or discovery endpoint, say) that was denied first
   and prevented the real request from ever going out. Check this before concluding the provider
   itself is unreachable or misconfigured.
4. **Don't use `curl` from inside the sandbox as an egress probe.** Per-binary policy denies it
   by default, so a denial looks identical to a genuine network failure and says nothing about
   whether the harness's own request would have been allowed or injected.
5. **A 404 or 429 from the provider proves injection worked.** The request reached the provider
   authenticated and was refused on model policy or capacity, not on identity. Only a **401** is
   the injection-failure signal — don't chase a 404/429 as an auth bug.
6. **On an actual 401, check the injection config's shape, not just its presence.** A missing
   value prefix (e.g. no `Bearer `) composes as a verbatim, schemeless concatenation of the raw
   token, which 401s at the provider even while every openlock-side check still reports the
   credential as present and configured. Presence and shape are different questions.
7. **Check expiry, then separately suspect revocation.** Every built-in health signal here is
   expiry-based, not validity-based — a token the issuer revoked out-of-band still reads as live
   until it hits its own clock-based expiry. If shape and expiry both check out and the 401
   persists, suspect revocation even though nothing in openlock surfaces it directly.
8. **A login you just watched succeed is not proof the gateway's copy changed.** The login path
   writes only the local credentials file — it never talks to the gateway. The copy a sandbox
   actually receives is the gateway's, seeded and updated by the provider-ensure step at sandbox
   start and gated by never-clobber. That gate *does* push a strictly newer host token, using
   expiry as a proxy for mint time (same issuer and TTL means a later expiry implies a later
   mint), so a fresh login normally propagates. Two residual traps: it propagates only on the
   next sandbox start, never at login time; and if the gateway tracks no expiry for that key
   (unset, or an explicit 0 meaning cleared) there is nothing to compare against, so
   never-clobber holds and the host token is never treated as newer.
9. **For header-level detail, rerun with `--debug-egress`.** It adds header-line detail to the
   same in-container log from step 1 — it is not a separate log to go find.
