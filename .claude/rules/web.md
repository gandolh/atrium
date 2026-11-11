---
paths:
  - "apps/web/src/**"
---

# The web app (`apps/web/src`)

- The Reading Room conformance checklist at the bottom of
  [corpus/wiki/design.md](../../corpus/wiki/design.md) is the design gate. Run it before any web change is done.
- Read the `base-ui` skill before you add or change a component.
- Base UI is imported only through the wrappers in `components/ui/`. Pages import the wrapper, never
  `@base-ui/react`. Seven files still import it directly; the Base UI migration moves them.
- Light, sepia and dark are all checked, artwork included. The `data-theme` attribute is the theme switch.
- Colours are tokens only: no hex, `rgb()` or named colour in a component.
- `apps/web/vendor/ward/` is Ward's generated client. Never edit it.
- `npm run check:conventions` runs `check-base-ui` over this folder, `--warn-only` until the Base UI migration
  is done.
