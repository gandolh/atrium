# Brief 24 — Atrium rebrand: brand identity + design-system neutralization

Promoted from `todos/rebrand-to-media-gallery.md`
(name settled: **Atrium**). This is the **brand layer** — the first of the
rebrand briefs (24 brand → 25 IA+cards → 26 notes). Scope is user-facing
identity + the design-system *name/metaphor*, NOT structure (brief 25).

## Grilled decisions applied
- Name = **Atrium** (warm, media-neutral).
- Design = **evolve** Quiet Paper: keep the calm palette, serif display type,
  tonal depth, three themes; drop book-only metaphors.
- **Scoping call (this brief):** rename all **user-facing** surfaces + the
  design-system name/prose. **Keep** the internal npm scope `@ebook-reader/*`
  (renaming it rewrites ~40 imports + forces a native-module reinstall — high
  risk, invisible to users). Likewise keep internal `--paper*` token
  identifiers and `book`/`library` code nouns (className churn, invisible);
  re-document them as neutral surfaces. Optional later cleanup.

## What to do
1. **Wordmark** — [AppHeader.tsx](../../../apps/web/src/components/AppHeader.tsx):
   `ebook-reader` → `Atrium`. Replace the sepia-theme **book glyph** in the
   theme toggle with a media-neutral glyph (keep sun/moon for light/dark; the
   middle one becomes a neutral mark, e.g. a half-filled contrast circle).
2. **Browser title + favicon** — [index.html](../../../apps/web/index.html):
   `<title>` → `Atrium`; swap the inline 📖 SVG favicon for a neutral Atrium
   mark (a simple geometric glyph — e.g. a rounded-square "gallery" outline or
   an "A" in a frame). Keep the `theme-color` meta.
3. **PWA manifest** — [vite.config.ts](../../../apps/web/vite.config.ts):
   `name` → `Atrium`, `short_name` → `Atrium`, `description` → media-inclusive
   ("Your personal library of books, music, and video — open and enjoy
   anywhere."). (Icon PNGs in `apps/web/public/` stay for now — regenerating
   branded PNGs is a follow-up; note it.)
4. **README** — `# Atrium` + one line describing the media gallery.
5. **Design system rename** — [globals.css](../../../apps/web/src/styles/globals.css)
   header comment + [wiki/design.md](../../wiki/design.md): rename "Quiet Paper"
   to an Atrium-flavored system name; neutralize the prose (paper/shelf/book
   metaphors → "gallery surface"/"collection"), keeping the actual token
   *values*. Palette values unchanged (warm off-white still works for a
   gallery). Update D27's label.
6. **root package.json** `name` → `atrium` (safe — not referenced by imports;
   leave the `@ebook-reader/*` workspace names + `-w @ebook-reader/shared`
   script intact).

## Must NOT touch
- npm workspace scope names / any `import … from "@ebook-reader/shared"`.
- `--paper*` / `--reader-*` token *identifiers* (values may stay; names stay).
- Structure/routes/cards (brief 25), Notes (brief 26).

## Acceptance
- The app shows **Atrium** everywhere a user sees a name (tab title, wordmark,
  installed-PWA name); favicon is no longer the 📖 book.
- No book-only metaphor remains in the wordmark, theme glyph, manifest copy,
  README, or design.md prose.
- `npm run build` + typecheck clean; the three themes still render; design.md
  conformance checklist still passes (tokens unchanged).

---

> **Outcome (2026-07-20):** Shipped via orchestrate → inline build (frontend
> coupling made subagent-splitting counter-productive). Wordmark, `<title>`,
> PWA manifest name/short_name/description, README, root package `name`, and the
> globals.css design-system header all now say **Atrium**; favicon is the arch
> mark; the sepia theme glyph is the neutral contrast disc. Internal npm scope
> `@ebook-reader/*` kept (documented). Verified live in-browser at 4 breakpoints
> + dark theme. Typecheck + build clean. Uncommitted — owner controls git.
