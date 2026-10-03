# Task 78 — Publishing releases reading positions on the version it supersedes

**Filed 2026-10-03** while doing brief 76.

## Context

Brief 38's decisions:
- **9:** "Opening a published card shows the latest version, or the version you
  were last reading if you had explicitly opened an older one."
- **10:** "When you are on page 40 on v3 and publish v4, you will resume from
  page 0 of v4."

`VersionPicker`'s `pickDefaultVersion` returns `currentVersionId`, the version
the profile's saved position was measured in, whenever that version still
exists. The progress sync records the loaded version with every position, the
newest included. So a reader who was simply reading the newest version is
pinned to it once a newer one is published, on a fresh page load as much as
within a session.

Seen 2026-10-03 on a scratch base: with `currentVersionId` = v2 (recorded while
v2 was newest) and v3 published, a fresh load opened "Version 2".

The client cannot tell an explicit pick from ordinary reading: both record a
version id. The server can, at the one moment it matters. At publish time, a
position measured in the **previous newest** version was ordinary reading, and
a position on any older version was an explicit choice, because only the
picker loads one.

## Scope

**In:** at publish, after the new version is committed, clear `version_id`,
`locator` and `progress` on every `reading_progress` row for that book whose
`version_id` is the version being superseded.

**Out:**
- the client's default rule (it already does the right thing once the
  position is cleared: no `currentVersionId` → newest, page 1);
- existing rows pinned by this bug before the fix, which cannot be told apart
  from explicit pins.

## Files you OWN

- `apps/api/src/modules/profiles/profiles.model.ts`: `resetProgressOnVersion`
- `apps/api/src/modules/latex/latex.controller.ts`: the publish route only
- `apps/api/test/publish-positions.test.ts` (new)

## Acceptance

- Position on v2 (the newest), then publish v3: the position has no version
  and no locator, and the card opens v3 at page 1.
- Position on v1 while v3 is newest (explicit), then publish v4: the position
  still names v1.
- A failed publish clears nothing.
- `npm run test`, typecheck and build are clean.

## Outcome (2026-10-03)

Done.

**Change:**
- `profiles.model.ts` gains `resetProgressOnVersion(bookId, versionId)`: one `UPDATE reading_progress SET version_id = NULL, locator = NULL, progress = 0` for that book and version.
- The publish route reads the current newest version (`superseded`) before appending; a first publish has none. It calls the reset **after** the guarded append-and-write block. That block rethrows on any failure, so a failed publish never reaches the reset and clears nothing.
- The client needed no change. With no `currentVersionId` it opens the newest, and `keepLocation` is false, so page 1.

**Tests** (`test/publish-positions.test.ts`):
- A position on v2 (the newest), then publishing v3: `currentVersionId` and `locator` are null.
- A position on v1 (older, explicit), then publishing v4: the position still names v1.
- The first fails on the old code; the second holds either way.
- 75 API tests pass, and typecheck and build are clean.

**Browser check** (scratch base, all roots asserted, with brief 76): the reader on v3 ("Third edition."), v4 published, the document reopened from the library tile in the same session: "Fourth edition." under **Version 4**.

**Known edges, accepted:**
- A reader who has the document open while it is published and turns a page afterwards writes the old version id back, pinning it again. Leaving without turning a page writes nothing, because the dedupe skips an unchanged position.
- Rows pinned by the old behaviour before this fix cannot be told from explicit pins, and stay pinned until the next publish supersedes their version.
