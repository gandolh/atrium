---
summary: The project's vocabulary — one canonical name per concept Atrium uses in a specific way, with the synonyms it displaces; the page that stops the same thing being called three names.
updated: 2026-08-24
---

# Glossary

Definitions only — what a term *is*, not how it works. Mechanism lives on the
concept pages; this page links to them. Only terms Atrium uses in a
**project-specific** way earn an entry ("cache", "retry", "token" as such do not).

`_Avoid_` is the load-bearing half: those are the rejected synonyms, listed so
they stop coming back. A term with two live meanings is two terms — see
[open-questions.md](open-questions.md) for the ones still unreconciled.

## Content

**Library**:
The single shared, server-owned collection of everything uploaded, across all
media kinds. Shared across users; only progress and identity are per-user (D31).
_Avoid_: collection, shelf, gallery, catalog

**Shelves / Stacks** _(retired 2026-08-24, D33)_:
Brief 21's two grouped-gallery arrangements. The UI is removed; the
author/series/subject columns it backfilled stay populated and now feed search
and chips. Kept here so the names are recognised in `log.md` and old briefs
without being revived.

**Library item**:
One uploaded piece of media in the library, whatever its kind. The code noun is
`LibraryBook` / the `books` table / `/library` for **every** kind, not just books
— a deliberate legacy kept by D32.
_Avoid_: asset, file, media object, book (in the general sense)

**Book**:
A library item whose kind is `book` — a PDF or EPUB. The user-facing sense is
always this narrow one.
_Avoid_: ebook, document, title, publication

**Media kind**:
One of `book` | `music` | `video`, derived from the format at upload (brief 23).
The axis the areas and card shapes are cut along.
_Avoid_: media type, content type, category

**Format**:
The concrete file format — `pdf`, `epub`, `mp3`, `mp4`, `webm`. Narrower than
kind; several formats map to one kind.
_Avoid_: filetype, extension, MIME (reserve *MIME* for the header itself)

**Cover**:
The image shown on an item's card, extracted server-side at upload (D26). Stored
on disk as a thumbnail file, never in the DB (D25); a missing one falls back to a
typographic tile.
_Avoid_: thumbnail (that is the stored file specifically), artwork, poster, image

**Chip**:
A filter control on the home grid that narrows it to one media kind, carrying a
live count. Since D33 this is what *kind* looks like in the UI — it replaced the
per-kind routes, so kind is a filter again and no longer a destination.
_Avoid_: tab, area, pill, toggle, facet

**Tint**:
The paper tone a tile carries to signal its kind — cream for books, rose for
music, sky for video, mint for notes (D33). The primary kind signal, which is
why format badges are no longer load-bearing.
_Avoid_: colour coding, category colour, highlight, label

**Dock**:
The persistent player strip at the foot of the app that survives navigation
(D33). The one place playback state lives.
_Avoid_: player bar, mini player, footer, now-playing bar

**Discover**:
The `/discover` page for browsing Project Gutenberg through the API's Gutendex
proxy and importing an EPUB into the library (brief 22).
_Avoid_: store, search, browse, catalog (that is the shared contract module and
the upstream data, not the page)

**Convert**:
The EPUB→PDF export path via Calibre. Strictly an export that ends in a download
— never a way to read a book (D1). See [conversion.md](conversion.md).
_Avoid_: transform, render, export-to-read

## Reading state

**Progress**:
The coarse per-user 0..1 "how far in" that drives the cover's progress bar (D31).
_Avoid_: percent, completion, position, **fraction** (what the offline store's
record calls it — a live drift, see [open-questions.md](open-questions.md))

**Locator**:
The exact resume position, opaque to the app: a page number as a string for PDF,
an epub.js CFI for EPUB. Distinct from progress and stored alongside it.
_Avoid_: position, bookmark, cfi, page, offset

**Resume**:
Reopening an item at its stored locator rather than at the start.
_Avoid_: continue, restore, seek

**Reading mode**:
The paged ⇄ scroll toggle (brief 11), persisted to localStorage. Not the colour
theme and not the font settings.
_Avoid_: view mode, layout, display mode

**Chrome**:
The reader UI framing the page — running header, footer, progress rail, the "Aa"
panel — which fades away while reading. See [reader.md](reader.md).
_Avoid_: toolbar, controls, UI, frame

**Progress rail**:
The scrubbable bar along the reader's bottom edge (chapter ticks, hover tooltip,
drag-to-seek; brief 08). Shared chrome — both readers mount it.
_Avoid_: scrubber, slider, seek bar, progress bar (that is the cover's)

## Access

**Seeded account**:
A user record created by the operator via the seed script. There is no
self-registration, by design (D30).
_Avoid_: signup, registration, member

**Session**:
An opaque, server-stored random token traded for a username and password, sent as
a bearer token or `?token=` query param. Not a JWT and not a cookie (D30).
_Avoid_: JWT, cookie, API key, login token, auth token

## Offline

**Download**:
An explicit, user-initiated copy of one item into IndexedDB so it reads with zero
connectivity (brief 20). Always deliberate — nothing is downloaded automatically.
See [pwa.md](pwa.md).
_Avoid_: cache, sync, save, offline mode

**Runtime cache**:
The service worker's stale-while-revalidate cache of cover thumbnails — the only
thing cached at runtime, and never user-initiated. The opposite end from a
download.
_Avoid_: offline storage, download, precache (that is the built shell)

## Notes

**Note**:
One per-user notebook: an ordered list of note pages, stored server-side
(brief 26).
_Avoid_: notebook, document, doc, sketch

**Note page**:
A single page inside a note, carrying a template (blank / ruled / grid), its
strokes and its text boxes.
_Avoid_: canvas, sheet, slide, board

**Stroke**:
One vector ink mark — sampled points with pressure, rendered via
perfect-freehand. Coordinates are normalized to page width.
_Avoid_: path, line, scribble, mark

**Text box**:
A movable typed-text element placed on a note page.
_Avoid_: label, annotation, caption, textarea

## Design

**Reading Room**:
The enforced design system (D33) — warm neutrals, four kind tints, and the
Newsreader/Archivo split that every `apps/web` change must conform to. See
[design.md](design.md).
_Avoid_: the theme, the style guide, the design language, **Quiet Paper** and
**Quiet Gallery** (both retired 2026-08-24 — the two names the previous system
drifted between)
