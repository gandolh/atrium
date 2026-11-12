---
summary: The Light / Sepia / Dark / System theme switch (D61) — where it lives, how the choice is kept, how System resolves, and what reads the theme.
updated: 2026-11-12
---

# The theme switch

Four choices: **Light, Sepia, Dark, System**, in the header (sun, half-disc, moon, screen) and in the reader's Aa
panel (miniature pages; System is a page cut in two). A first visit is light, whatever the system prefers. The
choice is kept per profile on the server, so the switch is a guarded `ToggleGroup` (base-ui rule 16): arrow keys
move focus only, Space, Enter or a click chooses, and one item stays pressed. System resolves through
`prefers-color-scheme`, follows it live, and writes the resolved light or dark to `data-theme`, so the attribute is
only ever `light`, `sepia` or `dark`. `dark:` keys off `data-theme="dark"` (`@custom-variant` in `globals.css`), so a
variant never needs a media query. Anything that must know the theme on screen (the PDF's invert, the EPUB
iframe's rules, the LaTeX source theme) reads `useResolvedTheme()`.

See [design.md](design.md) for the palettes and [decisions.md](decisions.md) D61.
