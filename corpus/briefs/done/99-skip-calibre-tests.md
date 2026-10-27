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

## Outcome (2026-10-27)

**Done**, code in `9858e13`. [`convert-status-write.test.ts`](../../../apps/api/test/convert-status-write.test.ts)
probes Calibre once, at the top of the file, with the API's own
`isCalibreAvailable()` (`ebook-convert --version`, the boot's probe), rather than a
second PATH lookup, and passes `{ skip: "Calibre not installed" }` to both tests
when it is missing. No shared helper: no other test needs Calibre.

**Checked.** The counts differ from the brief's because this run added tests (113
then, 129 now):
- without Calibre, with `PATH` set to a scratch directory holding only `sh` plus
  node's own bin directory (`command -v ebook-convert` finds nothing): `npm test -w
  @ebook-reader/api` exits 0, 127 pass and 2 are skipped, each marked `# Calibre
  not installed`;
- the same run on the old test file: 3 failures, the two Calibre tests (`actual:
  'failed', expected: 'none'` and `actual: false, expected: true`) and the
  Jukebox long-poll timing test (`waited 7715 ms`, bound 7000), which fails under
  load and has nothing to do with Calibre (brief 94's outcome saw it too);
- with Calibre: 129 pass, 0 skipped, unchanged;
- `npm run typecheck` is clean.
