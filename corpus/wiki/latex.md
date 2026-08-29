---
summary: The /latex destination — projects, the compile job, publishing into the library as versioned documents, where the sandbox actually lives now that the engine is pure, and the worker thread the engine is hosted on.
updated: 2026-08-29
---

# LaTeX in Atrium

`/latex` is the third **authored** destination, after Notes. You write a
multi-file project, compile it with **our own engine** (D38,
[typeset.md](typeset.md)), preview the PDF beside the source, and **publish** it
into the library as a document that accumulates versions. Built by brief 38;
the decisions are **D37** (drafts, publishing, versions) and **D38** (engine).

## Draft and published document are different things

A **draft** is the live project. It lives only in `/latex`, is **per-profile**,
and is **never** shown in the media gallery. **Publishing** compiles it, refuses
a failing document, and produces **one** library entry that accumulates
**versions** — pressing publish ten times gives ten versions on one card, never
ten cards. Each version stores its PDF **and a zip of the whole project**, so a
version can actually be rebuilt; a version that cannot be rebuilt is not a
version.

Deleting a version removes its row and its files. Deleting the last version
removes the entry — an entry with no versions has nothing to show. Deleting the
**draft** leaves published documents untouched: publishing is the act of making
something independent. That asymmetry is the schema's, not the code's —
`latex_projects.published_book_id` is `ON DELETE SET NULL` while
`document_versions.book_id` is `ON DELETE CASCADE`.

A **new version starts at page 0**. `reading_progress.version_id` records which
version a saved locator was measured in, and a locator is only ever applied to
its own version — page 40 of v3 is not page 40 of v4.

## Where the sandbox lives now

The engine is a pure function with no I/O, so **it** cannot be escaped. What
this brief adds is the part that *does* touch disk: uploads, project trees,
published artifacts. So path confinement is the whole of the remaining attack
surface, and it lives in one module.

`latex-paths.ts` turns an untrusted client string into a path under a project,
or refuses. It rejects absolutes (POSIX and Windows), `..` traversal including
after normalisation, symlinks resolving outside the project, **dangling**
symlinks, NUL bytes and over-long paths — resolving **component by component**,
because whole-path `realpath` cannot tell "not created yet" from "a link
pointing out of the project", and a naive implementation writes straight through
the second one. Rejection is a **result value, not a throw**, so a forgotten
`try` cannot turn a bad path into a 500.

It decodes nothing: Fastify has already decoded once, and decoding again would
manufacture the traversal it is meant to prevent (`%252e%252e%252f` → `../`).

`paths.ts` is the separate, trusted half — a total pure function of
server-generated ids, and the **only** definition of where anything lives (D39).
Nothing stores a path; everything derives one.

## The compile job

One compile at a time **per account**, not per profile — under D35 a per-profile
limit would be no limit at all. A second is **refused**, never queued.

Two guards, deliberately layered: the engine's **deterministic step budget** is
the real one (reproducible where a timer is not), and `LATEX_TIMEOUT_MS` is an
outer wall-clock backstop. A stop from either is reported as `stopped`, never as
`budget-exceeded` — the codes mean different things and conflating them tells a
writer to simplify a document that was never too complex.

**The engine runs on a `worker_thread`** (brief 44). `compile()` is still a
synchronous function — that is its contract and it did not change — but it no
longer runs on the API's thread: `latex-compile.ts` spawns
[`latex-worker.ts`](../../apps/api/src/latex-worker.ts) per compile and awaits
its result, so the process keeps reading requests throughout. Measured on a
**10.4 s** compile: the spawning thread logged **514 heartbeats, worst extra gap
1 ms**.

**Worker-per-compile, not a reused worker**, and that is the whole point. A
reused worker cannot be `terminate()`d without destroying the next compile's
host, so cancelling it would have to be cooperative — which is exactly what
cannot work against a synchronous engine that never yields. A fresh worker can
simply be terminated, so **cancel is real**: `DELETE` on a running compile stops
it mid-engine rather than waiting out `LATEX_TIMEOUT_MS`.

**`latex-worker.ts` must keep zero relative imports into `apps/api`.** It may be
loaded by plain Node type-stripping rather than tsx, where this package's
`.js`-suffixed specifiers do not resolve — dev would break while `dist/` worked.
Pass values through `LatexWorkerRequest` instead.

**A cancel is never offered where it cannot be taken.** A sibling profile's
project 404s at the cancel route, so `busyMessage` makes no offer there; and the
409 for a slot held only in-process omits `runningProjectId`, because that id
would address a deleted project.

## The seams that bit

Brief 38 was ten chunks, and — for the fifth build running — **every serious
defect spanned files owned by different chunks, and none tripped the gates**:

- the compile preview mounts a second `PdfReader` against the **shared reader
  store**, so scrolling it overwrote the last-read book's saved position;
- the editor's file-text cache was `staleTime: Infinity` and writes never
  updated it, so switching files and back reverted a saved edit;
- `flush()` was fire-and-forget, so compile and publish could run against the
  previous autosave — and for publish those stale bytes become a version;
- publish read `published_book_id` from a row snapshot taken **before** the
  compile, so two racing publishes could each create a card.

Budget the scoped review accordingly on anything this size.

## Storage

Five roots, all env-overridable and all gitignored — see
[architecture.md](architecture.md). Two are new here:
`LATEX_PROJECTS_DIR` (one directory per project) and `DOCUMENT_VERSIONS_DIR`
(per-version PDF and zip). The newest version's PDF **also** exists at the
derived library path, so `GET /library/:id/file` needs no special case; that
duplication is the price of not branching the one derivation D39 unified.

See [decisions.md](decisions.md) D37/D38/D39, [typeset.md](typeset.md) for the
engine, and [glossary-authoring.md](glossary-authoring.md) for **LaTeX
project**, **Draft**, **Published document** and **Version**.
