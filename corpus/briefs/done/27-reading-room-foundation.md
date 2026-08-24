# Brief 27 — Reading Room foundation: tokens, type, motion

The **foundation wave**. Everything in briefs 28–33 depends on this landing
first. Implements the token + type + motion layer of
[design.md](../../wiki/design.md) ("Reading Room", D33) without changing a
single screen's structure — after this brief the app should look *retinted and
reset in the new faces*, not rearranged.

## Grilled decisions applied
- Type is **Newsreader (prose/reading) + Archivo (interface)**; Playfair
  Display, Source Serif 4 and Inter all retire. Three self-hosted families → two.
- Token **identifiers are kept** (`--paper*`, `--ink*`, `--accent`, `--line*`) —
  D32's no-churn principle. Only their *values* change, plus four new tints.
- Dark theme moves to a **warm** axis (`#141310`, not `#181818`).
- The `--reader-*` three-theme architecture survives untouched as architecture.
- Motion base is **Motion Primitives**; **anime.js** for the progress rail only;
  **SmoothUI rejected** (overlap).

## What to do
1. **Fonts** — [main.tsx](../../../apps/web/src/main.tsx) +
   [package.json](../../../apps/web/package.json): drop `@fontsource/inter`,
   `@fontsource/playfair-display`, `@fontsource/source-serif-4`; add
   `@fontsource/newsreader` (latin + latin-ext 400/500/600, italic 400) and
   `@fontsource/archivo` (latin + latin-ext 500/600/700). **Pin exact versions**
   (D21). Keep the existing subset discipline — latin + latin-ext only.
2. **Font tokens** — [globals.css](../../../apps/web/src/styles/globals.css)
   L136–138: `--font-display` and `--font-reading` → Newsreader; `--font-ui` →
   Archivo. Keep the three variable names so no className churn.
3. **Palette** — revalue the `--paper*` / `--ink*` / `--line*` / `--accent` /
   `--ink-fill` blocks to the design.md **Light** table; retune the `[data-theme]`
   sepia + dark remaps (sepia keeps its values; **dark goes warm**). Retune
   `--reader-*` light + dark onto the warm axis; sepia unchanged.
4. **Tint tokens** — add `--tint-book` / `--tint-music` / `--tint-video` /
   `--tint-note` with light + dark values, exposed to Tailwind via the existing
   `@theme inline` block.
5. **Numerics** — a `tabular-nums` utility (or `font-variant-numeric` on a base
   class) available app-wide; apply it wherever a figure already renders.
6. **Motion setup** — install Motion (`motion`) + copy in the Motion Primitives
   components briefs 28–33 need; add `anime` pinned. Establish the shared easing
   token `(.2,.7,.3,1)` / 300ms and a **`prefers-reduced-motion` wrapper** that
   later briefs reuse rather than each rolling their own.
7. **Sweep raw hex** — grep `apps/web/src` for literal hex outside `globals.css`
   and route it through tokens. The PWA manifest colour (`#fcf9f8` → `#f7f5f2`)
   is the one sanctioned exception; update it and the maskable icon ground.

## Must NOT touch
- Any screen's **structure**, routes or component tree (briefs 28–33).
- The `--reader-*` layer's *architecture* (three themes via `data-theme`).
- Backend, contract, offline store.

## Acceptance
- No Playfair / Source Serif 4 / Inter anywhere; `npm run build` shows the font
  payload **down**, not up.
- All three themes render every existing screen with no unstyled or
  wrong-ground text; artwork reads true on the warm dark.
- Zero raw hex in `apps/web/src` outside `globals.css` (+ the manifest).
- Typecheck + build clean. design.md conformance passes on the *unchanged*
  screens.

## Outcome (2026-08-24) — DONE
Landed as committed `5c561f0`. Tokens, the two-family type stack, and the
motion primitives (`lib/motion.ts`, `lib/tokens.ts`) all in place with no
structural change, as scoped.

**The acceptance criterion "payload down" initially FAILED** — this brief's
premise was wrong. Three families → two is still **five faces → seven**
(Newsreader 400/500/600 + italic, Archivo 500/600/700), so the font payload
rose 12 KiB. The real waste was elsewhere and pre-existing: `@fontsource`
ships a `.woff` fallback beside every `.woff2` and the PWA glob precached
both. Dropping `woff` from `globPatterns` took the precache from
**37 entries / 3101.92 KiB → 31 / 2815.40 KiB**.

Accepted deviations: `@theme static inline` (plain `inline` tree-shakes tokens
only referenced from inline styles); `tabular-nums` on `body` rather than a
per-call-site sweep; a sepia-specific `--tint-book` (the light value is nearly
invisible on sepia's ground — it would have failed the tint test in one of
three themes).
