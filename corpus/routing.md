# Routing — Atrium

Routing profile read by the `orchestrate` skill.
Synced with personal-skills **v0.29.0** (2026-08-24).

## Skills
- **Implement skill:** plan-split-dispatch
- **Review skill:** code-review
- **PR skill:** (none yet — local dev only)
- **Issue tracker:** none — `corpus/briefs/` is the tracker (one queue: `todo/` → `done/`)
- **Code host:** none (local git only)

## Intent table
| If the request is… | Route to… |
|---|---|
| capture an idea / follow-up | corpus-flow §1 (add todo) |
| ready to build a todo | corpus-flow §2 (promote to brief) |
| build a brief, ≥3 chunks | plan-split-dispatch |
| build, 1–2 files / one indivisible piece | brief, then implement inline |
| "how does X work here" | corpus-flow §5 (query wiki) |
| "what do we call this" / define a term / record a locked call | corpus-flow §9 (glossary + decisions) |
| the term is still contested | grill-me, then record it |
| "what should we work on" / find the debt | improve — **gated**, returns a ranked list |
| research / compare options | inline web search — **gated**, ends in options |
| design or redesign a frontend, UI polish | impeccable — build against wiki/design.md (direction is settled, D33) |
| "is this accessible" / UI compliance on source | web-design-guidelines |
| docs or prose need a style pass | writing-guidelines (+ unslop first if AI-drafted) |
| a diagram would beat prose | diagram-design |
| review a diff | code-review; thermo-nuclear-review when a strict maintainability pass is wanted |
| work finished, needs recording | corpus-flow §4 (done + log + fold into wiki) |

**Gated means gated.** `research`, `audit` (improve) and new-feature `design` end
in **options for the user to pick from** — never a licence to start building. The
sequence is explore → propose → *user picks* → brief → build. The approval gate
holds on every path, including the ones that look too small to bother with.

## Knowledge routing — which layer answers which question
The corpus is the WHY; the code is the WHAT. Neither substitutes.

| Question shape | Route to |
|---|---|
| "Why is it built this way?" / "what was decided?" | `wiki/` — start at [index.md](index.md), budget ≤3 pages |
| "What do we call this?" / naming conflict | [wiki/glossary.md](wiki/glossary.md) |
| "Where does feature Y live?" / "who calls X?" | grep + read (no `codegraph` project skill here — corpus-flow §0b can bootstrap one) |
| **"Did I get _every_ usage?"** (rename/refactor/delete) | **`grep -rnw`** — nothing else is exhaustive |
| A correctness invariant (design tokens, contract drift) | run it: `npm run typecheck` + the design.md conformance checklist |
| "Does it actually work in a browser?" | drive it: the `agent-browser` MCP tools + `playwright/` (repo root, gitignored). Record findings in [log.md](log.md); the `ui-test-plans` skill can scaffold written plans if a run needs them. |

## READ / SKIP / SKILLS
| Area | READ | SKIP | SKILLS |
|---|---|---|---|
| frontend (apps/web) | apps/web/src, wiki/reader.md, **wiki/design.md** | apps/api | impeccable, frontend-design |
| backend (apps/api) | apps/api/src, wiki/conversion.md, wiki/architecture.md (library) | apps/web | — |
| shared contract | packages/shared, wiki/decisions.md, **wiki/glossary.md** | — | — |
| notes | packages/shared/src/notes.ts, wiki/glossary.md (Notes terms) | apps/api/src/extract.ts | impeccable |
| typesetting engine (packages/typeset) | packages/typeset/src, wiki/typeset.md, **wiki/glossary-authoring.md** (engine terms), briefs 37/39/40 | apps/web, apps/api — the engine ships no UI and no routes | — |

**`packages/typeset` toolchain quirk, load-bearing:** relative imports inside its
`src/` carry an explicit **`.ts` suffix**, not `.js`. Node's type stripping does not
rewrite specifiers, so `.js` breaks `node --test`; `tsc` rewrites `.ts` to `.js` on
emit. This deliberately differs from `apps/api`'s `.js` convention — tell every
dispatched chunk, or it will copy the wrong one.

Every dispatched chunk gets the terms it needs from
[wiki/glossary.md](wiki/glossary.md) — a subagent that doesn't know the
vocabulary invents its own.

## Design enforcement
All `apps/web` work MUST conform to **wiki/design.md** ("Reading Room", D33) and
pass its conformance checklist before it's done. See CLAUDE.md "Design
enforcement". The visual direction is **settled** — don't re-pick it, and don't
reintroduce Quiet Paper's Playfair/Source Serif/Inter roles or per-kind routes.

Motion idiom is **Motion Primitives**, with **anime.js** on the progress rail
only. SmoothUI was considered and rejected (overlap) — don't add it.
