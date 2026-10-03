# Task 74 — Picking the profile that is already active is remembered

**Filed 2026-10-03** while verifying brief 56 in the browser.

## Context

On boot, `checkStatus` in [`lib/auth.ts`](../../../apps/web/src/lib/auth.ts)
shows the "Who's reading?" picker unless the device remembers a choice
(`readStoredProfileId()`, within the 24-hour window). A server-assigned default
is deliberately not a choice.

But `switchProfile(id)` returns early when `id` is already the active profile,
the server default included:

```ts
if (id === get().activeProfileId) {
  stampActivity();
  set({ pickerRequired: false });
  return;            // ← writeStoredProfileId(id) never runs
}
```

So a person who taps the profile the server already picked has made a choice
that is never stored. On the next load `remembered` is undefined again and the
picker comes back. For an account with one profile, which is every account on
first contact, that means the picker appears on **every load**. Seen
2026-10-03 on a scratch base: tap Default, reload, the picker is back.

## Scope

**In:** recording the choice in the early-return branch of `switchProfile`.

**Out:** the 24-hour window, the picker's design, and server-side activation.
The early return stays: it exists so the cache is not cleared for a no-op
switch.

## Files you OWN

- `apps/web/src/lib/auth.ts`

## What to do

1. In the early-return branch, call `writeStoredProfileId(id)` before closing
   the gate.
2. If `FRESH_CHOICE_AT_BOOT` reads anything other than the stored id and the
   activity stamp, check that the branch satisfies it too.

## Acceptance

- One-profile account: tap Default, reload, and the app opens without the
  picker. After the idle window passes, the picker shows again.
- Two profiles: switching still clears the cache and remembers the new one.
- Typecheck and build are clean. Verify against a scratch base with all five
  storage roots set inline and asserted before start.
