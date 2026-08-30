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
Brief 21's two grouped-gallery arrangements; UI removed, its backfilled
author/series/subject columns now feed search and chips. Listed so the names are
recognised in old briefs, not revived.

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
Changing a book from one format to another via Calibre — PDF→EPUB or EPUB→PDF,
one verb for both directions. A conversion produces a **converted book**, which
is read in-app like any other (D34, revising D1's export-only rule). See
[conversion.md](conversion.md).
_Avoid_: transform, render, export, reflow, export-to-read

**Source book**:
The library item a conversion was made *from*. Keeps its own file, cover, and
resume position; deleting it deletes its converted book.
_Avoid_: original, parent, master

**Converted book**:
The library row produced by a conversion, linked to its source book. Hidden from
the grid, search, chips, and counts — it is reached only by switching format
inside the reader, so one book is always one card.
_Avoid_: variant, sibling, derived row, duplicate

**Profile**:
A person in the household — the identity that owns reading progress, notes, and
preferences. Switching between profiles is free (no password, no PIN), so a
profile is an **identity** boundary and never a security one (D35).
_Avoid_: user, account, persona, member

**Account**:
The household — the credential that logs in, and the security boundary
(D30). Holds up to five profiles and one shared library. People who need real
separation from each other need separate accounts, not separate profiles.
_Avoid_: profile, user, tenant, household (use *account* in code and copy)

## Reading state

**Progress**:
The coarse per-user 0..1 "how far in" that drives the cover's progress bar (D31).
_Avoid_: percent, completion, position, **fraction** (what the offline store's
record called it until the IndexedDB v5 rename — D39, 2026-08-27; the two names
now agree, so a reintroduced `fraction` is a regression, not a synonym)

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

## Design

**Reading Room**:
The enforced design system (D33) — warm neutrals, four kind tints, and the
Newsreader/Archivo split that every `apps/web` change must conform to. See
[design.md](design.md).
_Avoid_: the theme, the style guide, the design language, **Quiet Paper** and
**Quiet Gallery** (both retired 2026-08-24 — the two names the previous system
drifted between)

## API layering (D47)

**Model**:
A module's data-access file and the ONLY code allowed to query its tables — async
Knex functions, not a domain object. `library.model.ts` owns `books`.
_Avoid_: repository, DAO, entity, row object

**Service**:
Where a module's rules live. Decides, orchestrates, touches the filesystem, and
returns a **tagged union** for any normal answer — never a status code.
_Avoid_: manager, handler, use case, business logic layer

**Controller**:
A module's HTTP file: validate, pick the status code, stream bytes. No rules, no
queries.
_Avoid_: router, routes file, endpoint, handler

**Baseline migration**:
`20260830000000-baseline.ts` — the one **idempotent** migration, needed because
the pre-Knex schema was rebuilt on every boot and left no history to replay: it
must be correct on a fresh database AND on a live one already migrated with
nothing recording that. **Every later migration is an ordinary forward migration
and must NOT be idempotent.**
_Avoid_: initial migration, schema migration, the setup migration

> **Authored content** — Note, Note page, Stroke, Text box, LaTeX project,
> Draft, Published document, Version — lives in
> [glossary-authoring.md](glossary-authoring.md). Same authority, split for size
> along D36's own line: things you collect here, things you author there.
