# TeleBots quality gate

## Rule

Never report a code change as **SIAP** merely because code was written or committed.

A change may be reported as **SIAP** only after the applicable checks below pass.
If an external platform blocks a later check, report **BLOCKED**, not SIAP.

## Required sequence for every change

1. **OWNERSHIP** — identify the one domain/module that owns the requested topic.
2. **CODED** — make the smallest change inside that domain.
3. **UNIT TESTED** — add/update automated regression tests for the changed behavior.
4. **CI PASS** — the repository test workflow must pass on the exact head commit.
5. **INTEGRATION TESTED** — test the real dependency boundary when the change uses DB/API state.
6. **DEPLOYED** — confirm the intended build is actually live; do not infer this from a commit alone.
7. **SMOKE VERIFIED** — exercise the changed production route with the safest meaningful test.
8. **UPDATE OWNER** — only now report SIAP, including what was tested and any remaining limits.

## SEND / batch changes

SEND changes have additional mandatory checks because a failure can spam or reorder a destination group.

Before reporting a SEND change as SIAP:

- automated tests must verify ordered behavior, duplicate-worker behavior, stop gates, and retry behavior relevant to the change;
- database claim/order logic must be tested with synthetic rows and cleaned afterward;
- ambiguous network errors must not be blindly retried if a retry could duplicate a Telegram message;
- Telegram explicit `retry after` responses may retry the SAME item only after the requested wait;
- no worker may claim position N+1 while position N is still `SENDING`;
- a duplicate worker must not fan out additional workers while another item is in flight;
- production smoke testing must begin with a tiny batch before any large batch is attempted.

## Status words used in updates

- **CODED** — implementation exists, tests not all passed yet.
- **TESTED** — automated/integration tests passed, but not confirmed live.
- **DEPLOYED** — intended build is confirmed live, smoke test pending.
- **VERIFIED / SIAP** — deployed route passed the required smoke test.
- **BLOCKED** — a required next gate cannot currently run; explain the blocker.

This file applies to future changes as well as the current SEND refactor.
