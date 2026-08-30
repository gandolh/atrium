# Atrium

Repo-root guide. The project's knowledge and work live in `corpus/`, an
LLM-maintained wiki + work tracker. **Read `corpus/index.md` first.** The human
curates sources and asks questions; the LLM curates the synthesis
(`corpus/wiki/`) and tracks work (`corpus/briefs/`, `corpus/log.md`).

Paths below are relative to `corpus/` unless written out in full.

## Layout

```
CLAUDE.md        this file — project + corpus schema and conventions
corpus/
  index.md       content catalog / front door (wiki catalog is generated — see below)
  log.md         chronological record of meaningful changes
  routing.md     orchestrate routing profile
  lint.sh        health check: frontmatter, link resolution, page size (+ --index)
  briefs/        immutable work specs, ONE queue — todo/ done/ superseded/
  wiki/          curated synthesis pages (LLM owns these) — each opens with frontmatter
    glossary.md  the project's vocabulary — one canonical name per concept
    decisions.md the locked calls, each with the *why* that lets it be revisited
```

## Conventions (load-bearing)

- **Brief numbers are stable** — never renumber when a brief moves dirs.
- **Every wiki page carries `summary:` + `updated:` frontmatter.** `summary:` is
  the retrieval signal — written for an agent deciding whether to open the page,
  not as a title. `corpus/index.md`'s wiki catalog is **generated** from those summaries
  (`bash corpus/lint.sh --index`); never hand-edit between its markers.
- **Retrieval budget (a rule, not advice):** read `corpus/index.md`, triage on the
  summaries, then open **at most 2–3 wiki pages**. Needing more is a signal a
  page is straddling topics and must split. Never read `corpus/briefs/`
  wholesale — `corpus/wiki/status.md` holds each brief's state in one line.
- **One work queue: `corpus/briefs/`. There is no `todos/`** — it was merged into
  `briefs/todo/` on 2026-08-29 and must not be recreated (the corpus-flow skill
  will otherwise bootstrap it back). Capture and spec are the same act here: a new
  idea is written **straight into `briefs/todo/` as a numbered brief**, taking the
  next free number. The cost of this is real and deliberate — there is no
  half-formed capture stage, so an idea has to arrive with a Scope, a
  Files-you-OWN list and Acceptance criteria before it is written down at all. If
  an idea genuinely cannot be specified yet, that is a signal to grill it into
  shape, not to open a second directory for it.
- **`bash corpus/lint.sh` before committing corpus changes** — it checks
  frontmatter, that every relative link resolves, and page size (~200 body
  lines). Exit non-zero gates the commit; the human sweep (stale claims,
  contradictions) still matters.
- **Standard relative markdown links**, not `[[wikilinks]]`. Code refs from
  `corpus/wiki/` are `../../apps/...`; from `corpus/briefs/<state>/` they're `../../../apps/...`.
- **Absolute dates** (`2026-07-02`), never "yesterday".
- **One concept per file**; split a wiki page past ~200 body lines.
- **Source-of-truth ordering** when things disagree:
  1. actual code > any wiki claim
  2. a `done/` brief > `wiki/` if the wiki lags
  3. `decisions.md` > `status.md` for locked tech choices
  Verify any path/function a page names before acting on it — pages drift.
- **LLM owns `corpus/wiki/`; briefs are immutable; index/log are navigation.**
- **`corpus/wiki/glossary.md` is the naming authority.** One canonical term per concept,
  each listing the synonyms it displaces (`_Avoid_:`). Definitions only — the
  moment an entry explains mechanism it belongs on a concept page. Only
  project-specific terms; "cache"/"retry" do not qualify. Write a term down the
  moment it's settled (usually mid-`grill-me`), not in a batch later. **A term
  used against its definition is a finding, not a typo** — fix one side rather
  than quietly adding a second sense; two live meanings is two terms.
- **Bar for a new `corpus/wiki/decisions.md` entry — all three must hold:** hard to reverse ·
  surprising without context · a genuine trade-off with rejected alternatives.
  Record the call, the date, what was rejected, and **the reason** — the reason is
  load-bearing, since a decision with no *why* can only be obeyed or broken, never
  revisited intelligently. Otherwise the page fills with obvious choices and stops
  being read.
- **Never commit** corpus changes unless the user explicitly asks.

## Project one-liner

**Atrium** — a personal **media gallery** with **per-user accounts** and a
**shared persistent library**: books (PDF/EPUB), music (MP3) and video
(MP4/WebM), plus a **Notes** tab of per-user paged notebooks (D32, briefs 24–26).
Upload an item → it's saved (server-side SQLite) with a server-extracted cover →
reopen from its per-kind area (`/books` `/music` `/videos` `/notes`) any time.
Books read 100% client-side (react-pdf, react-reader/epub.js); the Fastify
backend owns the library (CRUD + file/cover storage), auth (operator-seeded
accounts, opaque sessions, scrypt — D30), per-user progress + resume locator
(D31), a Gutenberg discover proxy, and EPUB→PDF export via Calibre. Auth is
always on; accounts come from `apps/api/scripts/seed.ts` (no self-registration).
The internal npm scope `@ebook-reader/*` and the `books`/`library` code nouns are
deliberately kept (D32) — see `corpus/wiki/glossary.md`. Start at `corpus/wiki/overview.md`.

## Design enforcement (load-bearing)

**`corpus/wiki/design.md` ("Reading Room") is the enforced design system (D33).** Every
`apps/web` change MUST conform. Before treating any frontend work as done, run
its **conformance checklist** (bottom of `corpus/wiki/design.md`): theme tokens only (no raw
hex in components), the Newsreader/Archivo split, tabular numerals, accent for
state only, the radii + elevation + spacing rules, all three themes checked
including artwork, a `prefers-reduced-motion` path, and the tint test (strip
every badge — the grid must still read by kind).

Reading Room replaced **Quiet Paper / Quiet Gallery** on 2026-08-24; the old
`design/stitch_extracted/screen.png` reference is superseded by the comps linked
from `corpus/wiki/design.md`.
