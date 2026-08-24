---
summary: What Atrium is in a paragraph — a personal, per-user-account media gallery (books, music, video) + a Notes tab; the orientation page.
updated: 2026-08-24
---

# Overview

**Atrium** (renamed from "ebook-reader" in brief 24, 2026-07-20) is a personal
**media gallery** with **per-user accounts** and a **shared persistent
library** — books (PDF/EPUB), music (MP3), and video (MP4/WebM), plus a
**Notes** tab for drawing and writing.

Since the **Reading Room** rework (briefs 27–33, D33) there is **one home** at
`/`: media kind is a filter chip with a live count, not a destination — which
reverses brief 25's per-type routes (`/books` `/music` `/videos` survive as
redirects). Each kind keeps its native card shape (book 2:3, music square,
video 16:9) and now carries a **paper tint** that signals kind without a badge.
A **Continue** strip leads the page in *time remaining*, a **player dock** at
the foot survives navigation, and a `/`-focused field searches the whole
library. **Notes** (brief 26) stays its own destination, outside the grid — a
notebook is authored, not collected. The name/design evolved but the internal
npm scope `@ebook-reader/*` and the `books`/`library` code nouns were kept (see
[decisions.md](decisions.md) D32).

The original reader core is unchanged below:

Upload a PDF or EPUB → it's saved and appears as a cover card in the library →
reopen and read it anytime. Access is gated by **per-user accounts** (operator-
seeded, no self-registration — D30); the library itself (files + extracted
covers) is **shared** across users and persists server-side in SQLite (D24).
Reading **progress + exact resume position are per-user** (D31). Other view state
(font size, theme, chrome) still lives in Zustand in memory and resets on refresh
(D9); the paged/scroll mode persists to localStorage.

## What it does
1. **Library home** — upload a PDF/EPUB → backend stores the file, extracts a
   cover, inserts a row → the book shows as a cover card in a gallery. Reopen
   anytime; delete when done. This is the front door (was: one-step uploader).
2. **Read PDF** — open a library book → renders client-side via `react-pdf`
   (PDF.js).
3. **Read EPUB** — open a library book → renders natively client-side via
   `react-reader` (epub.js), reflowable, Kindle-style.
4. **Convert EPUB→PDF** — from the EPUB reader → backend shells out to Calibre →
   PDF streams back as a **download**.

## The cast (monorepo, npm workspaces)
- **`apps/web`** — React + Vite frontend. The heart of the app (the reader).
- **`apps/api`** — Node + Fastify backend. Owns the **library** (SQLite CRUD +
  file/cover storage on disk) and the stateless `POST /convert` route.
- **`packages/shared`** — Zod schemas + inferred TS types (convert contract +
  file validation + library book contract), imported by both apps so they can't
  drift.

## The honest tension we settled
EPUB→PDF conversion *discards* reflow (EPUB's best trait), so it is strictly an
**export/download** utility — never the primary reading path. Native EPUB
reading stays the star. See [decisions.md](decisions.md).

## Runs
Local dev only. `npm run dev` runs web + api. Calibre must be installed on the
host (the backend warns loudly on startup if `ebook-convert` is missing).
