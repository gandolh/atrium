---
paths:
  - "apps/web/src/**"
---

# The web app (`apps/web/src`)

- The Reading Room conformance checklist at the bottom of
  [corpus/wiki/design.md](../../corpus/wiki/design.md) is the design gate. Run it before any web change is done.
- Read the `base-ui` skill before you add or change a component.
- Base UI is imported only through the wrappers in `components/ui/`. Pages import the wrapper, never
  `@base-ui/react`. `check-base-ui` runs strict in `npm run check:conventions`; an exception goes in
  `scripts/conventions.json` with its reason (the two scrubbing sliders, the per-profile theme).
- A dialog that holds a form sets `disablePointerDismissal`; an inline "Delete? Yes / No" stays inline. A side panel
  is a `Drawer`. A choice that is saved to the server on each pick (the theme, the reading font) is a `ToggleGroup`;
  a choice that only sets editor state is a `RadioGroup`. Errors raised through `notify()` stay until dismissed.
- Tailwind: one stylesheet (`styles/globals.css`), classes through `cn()` from `lib/cn.ts`, z-index from the
  `--z-index-*` tokens (`z-popup`, `z-toast`), never a number. A new token name also goes in `cn()`'s lists.
  `better-tailwindcss` runs in `npm run lint` (unknown and deprecated classes, class order).
- Light, sepia and dark are all checked, artwork included, and System resolves to light or dark. The `data-theme`
  attribute is the theme switch, and it is only ever light, sepia or dark (`useApplyTheme`). Code that needs the theme
  on screen reads `useResolvedTheme()`, never the raw pick.
- Colours are tokens only: no hex, `rgb()` or named colour in a component.
- `apps/web/vendor/ward/` is Ward's generated client. Never edit it.
