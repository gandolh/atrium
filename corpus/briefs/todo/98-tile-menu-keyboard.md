# Task 98: Tile menu: reachable and usable with a keyboard

## Context

`apps/web/src/library/CoverCard.tsx:218-219`: the "More actions" trigger closes the menu on blur,
and the items fire on `onMouseDown` only (`:231`, `:246`, `:257-258`, where a comment explains why).
Tabbing from the trigger unmounts the menu before an item takes focus, and Enter or Space on an
item would fire only `click`, which these buttons do not handle. So "Add to Discord queue" and
"Remove" work only with a mouse.

Improvement sweep of 2026-10-20 (Jukebox lens), vetted against the code; the ranked report is the owner's "Repo improvement sweep" doc.

## Files you OWN

- `apps/web/src/library/CoverCard.tsx`

## What to do

1. Use Base UI's Menu (D22) for the tile menu, which handles focus and keys; or close on blur only when focus leaves the menu, and use `onClick`.

## Acceptance

- With the keyboard alone: Tab to a music tile's More actions, open it, move to "Add to Discord queue", press Enter, and the song is queued.
