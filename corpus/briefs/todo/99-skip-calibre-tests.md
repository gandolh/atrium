# Task 99: Skip the Calibre tests when Calibre isn't installed

## Context

`apps/api/test/convert-status-write.test.ts:102` and `:122` need a real conversion through Calibre's
`ebook-convert`. `docs/getting-started.md:9` calls Calibre optional, but without it both tests fail
with assertion errors ("failed" instead of "none"; "ready" or "poor" expected) rather than
skipping, so `npm test` is red on any machine without Calibre (seen 2026-10-20: 111 of 113).

Improvement sweep of 2026-10-20 (mechanical checks lens), vetted against the code; the ranked report is the owner's "Repo improvement sweep" doc.

## Files you OWN

- `apps/api/test/convert-status-write.test.ts`
- a small shared test helper, if other tests need it

## What to do

1. Detect `ebook-convert` on PATH once and pass `{ skip: 'Calibre not installed' }` to those tests when it is missing.

## Acceptance

- Without Calibre: 111 pass and 2 are skipped with that reason; with Calibre: unchanged.
