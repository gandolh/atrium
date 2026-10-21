# Task 97: Songs the bot streams don't count as opened

## Context

`apps/api/src/modules/library/library.controller.ts:155-156` calls `touchOpened` for every file
request, including the jukebox-only bot's (the check just above only refuses non-audio). The home
grid sorts by most recently opened by default (`LibraryHome.tsx:125`), so the songs the bot played
push the books and videos people actually opened down the page. Every Range request is also a
database write.

Improvement sweep of 2026-10-20 (Jukebox lens), vetted against the code; the ranked report is the owner's "Repo improvement sweep" doc.

## Files you OWN

- `apps/api/src/modules/library/library.controller.ts`
- tests

## What to do

1. Skip `touchOpened` when `request.jukeboxOnly` is set.

## Acceptance

- A test: a jukebox-only file request leaves `last_opened_at` unchanged; a member's request still updates it.
