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

## Outcome (2026-10-27)

**Done**, code in `f35905e`, with the first option: Base UI's Menu (D22, already a
dependency at 1.6.0), in [`CoverCard.tsx`](../../../apps/web/src/library/CoverCard.tsx).

- `Menu.Root modal={false}`, so a click outside still reaches the page and closes
  the menu, as the old blur did; a modal menu would lock scrolling and eat that
  click. The trigger is `Menu.Trigger` with the old classes plus
  `data-[popup-open]:opacity-100`, because the portalled menu takes focus out of
  the card and the trigger would otherwise fade while its menu is open. The popup
  is portalled (the theme is on `<html>`, so it is themed) and placed below and
  right-aligned, flipping above when there is no room.
- The items are `Menu.Item` with `onClick`, which Base UI fires for Enter and Space
  too; highlight is `data-[highlighted]` on the same tokens the hover used. Several
  Discord servers are a `Menu.Group` with its caption as `Menu.GroupLabel`. The
  `menuOpen` state and the `onMouseDown` workaround are gone.

**Checked** in a browser on the scratch library with the stand-in bot (brief 95's
setup), keyboard only from the top of the home grid: Tab, 18 presses, reached
"More actions for Harbour Lights" (visible on focus); Enter opened the menu with
focus on "Add to Discord queue"; ArrowDown moved to Remove and ArrowUp back; Enter
ran it, closed the menu, returned focus to the trigger, and the tile said "Added to
Scratch Server's queue". The scratch database's Queue then held Harbour Lights,
added by the Default profile, and the stand-in got an `upcoming` command. Also:
Space opens, Esc closes back to the trigger, ArrowDown on the trigger opens, and
ArrowDown, ArrowDown, Enter on another tile's trigger ran Remove (a `DELETE`
reached the API and the tile left the grid). With the mouse: click the trigger,
click the item, and a click outside closes it. Light, Warm and Dark at 1280 px.
Design checklist: tokens only, Archivo, accent only on the focus ring, the card
radius, no motion added. `npm run typecheck` and the web build are clean; there
are no web unit tests.

**Left:**
- after Remove by keyboard, focus falls to the page body, because the tile and its
  trigger are gone; the same happened with the mouse before.
- the main chunk grows from 274.45 to 286.76 kB gzip (893 to 929 kB raw), and
  another chunk shrinks by about 0.8 kB gzip: Base UI's Menu was not in the main
  bundle before.
