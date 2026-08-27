# Product

## Register

product

## Users

A **household**, not a person. An **account** is the household and is the
security boundary (D30 — operator-seeded, no self-registration); a **profile**
is a person in it, switched with one tap and no password (D35). Profiles carry
reading progress, notes and reading preferences; the library is shared.

The owner is a software engineer reading on his own machine — evenings, long
sessions, WSL/desktop browser at laptop and external-monitor sizes — plus a
phone. Reading is still the primary path, but it is no longer the only one.

## Product Purpose

**Atrium is a personal cloud space: your stuff, reachable from anywhere** (D36).
Two halves that share one design system, one account model and one deploy:

- **Media you collect** — books (PDF/EPUB), music (MP3), video (MP4/WebM) in a
  persistent server-side library with covers, search, per-profile progress, an
  offline path for downloaded books, and a **Convert** verb that gives a book
  its twin in the other format (D34).
- **Documents you author** — **Notes**, paged notebooks with vector ink and
  text boxes (D32); and **LaTeX**, multi-file projects that compile to PDF and
  publish into the library as versioned documents (D37/D38).

Authored destinations sit **outside** the media grid and always will — a
notebook is written, not collected (D33g, generalised by D36).

The founding one-liner was *"upload → read → gone; no accounts, no library, no
sync (D3)"*. **Every clause of that is now false**, and deliberately: D24/D25
added the library, D30 added accounts, D35 added profiles, D36 named the
premise. The sentence is kept here only so a reader who finds it quoted
somewhere older knows it was superseded on purpose rather than forgotten.

Success is unchanged in spirit: opening a real book — or a document you wrote
on the other machine this morning — and disappearing into it, without the UI
ever demanding attention.

## Brand Personality

**Reading Room** (D33, replacing "Quiet Paper" — see `corpus/wiki/design.md`,
which is the enforced system). Calm, warm, invisible-until-needed. The
typography and the page are the interface; chrome exists only in the moments
it's summoned (Kindle / iA Writer lineage). Three words: quiet, warm, precise.
The one exception to the two-family type rule is the LaTeX source pane, which
sets in the platform's monospace because character alignment there is
semantic.

## Anti-references

- **Adobe/Foxit-style PDF viewers** — dense gray toolbars, icon soup,
  enterprise chrome framing the page from all four sides.
- Web-app grammar leaking into the reading surface (cards, chips, dashboard
  scaffolding) — the reader is a page, not an app screen.

## Design Principles

1. **The page is the interface.** Every pixel of chrome must justify itself
   against a blank margin. Prefer summoned UI (auto-hide, popovers) over
   persistent UI.
2. **Typography does the design.** Hierarchy, warmth, and craft come from type
   and spacing, not decoration.
3. **Reading state is sacred.** Never steal focus, shift the text, or animate
   the page while someone is mid-paragraph. Motion conveys state only.
4. **Familiar hands.** Page-turn, TOC, search, themes behave the way a
   fluent Kindle/Books user's hands already expect — earned familiarity, no
   invented affordances.
5. **The utility stays a utility.** Upload and convert screens are efficient
   and plain; polish budget goes to the reader.
6. **Authoring surfaces are working surfaces.** The notes canvas and the LaTeX
   editor are places you *do* something, so they may be denser than a reading
   page — but they obey the same tokens, and a failure there is always said out
   loud rather than swallowed.

## Accessibility & Inclusion

WCAG AA: ≥4.5:1 body text in all three themes, full keyboard operability
(page-turn, drawers, settings), visible focus, `prefers-reduced-motion`
respected (crossfades instead of movement). A household product now rather than
a single-user one, and the bar holds on every surface — including the authored
ones.
