# atrium: the controller's rulings over the critic (2026-11-12)

The critic's verdict is fix; its file is board/critiques/atrium.md. Everything in it stands except where a ruling below says otherwise.

1. **Notes, one list card (critic 1): accept.** One raised list card, max 720 px, one-line 68 px rows at desktop. **Phone: the select and Delete stay visible at rest**, as today does (the app's own choice), laid out in the row's second line inside the same list card, not as separate cards. Put the ⋮ menu idea on an ask sticky for the owner; don't draw it.
2. **Six columns (critic 2): accept, over direction B's "5 columns ≥168 px".** Density is the pilot's top regression and today shows 6 at 1280. Use the critic's grid values, and `auto-fill minmax(150px,1fr)` under 820.
3. **Reader (critic 3): accept.** Chapter ticks back on the progress rule; set a full page of text (17 lines at 1280, about 19 at 390) from the app's real reader copy.
4. **PDF cover (critic 4): accept.** Draw it as an SVG with a viewBox so it scales at 360 and 768. The text sitting lower than today's shot (so the offline button never covers it) is accepted; its sticky stays.
5. **Phone Library (critic 5): accept.** Sort on the title row, 12 px chip padding under 380 px, bars at the screen's foot (`min-height:100dvh`).
6. **Never truncate** to buy any of this room (no ellipsis or clamp on titles, authors or notes).
7. **The hand-off to code** (board-shared.md's last section, new since your build): write board/manifests/atrium.tokens.css and atrium.tokens-map.md in the app's existing token names.
8. Re-run every Floor check after the fixes and report the first-screen counts against the critic's (covers per row at 1280 and 768, note rows at 1280 and 390, covers visible at 360x800).

## Round 3 (the controller's look, 2026-11-12)

- **The reader page repeats one sentence ("A small lamp stood on the table.") about 40 times.** That reads as broken or as filler, and the judges' G4 forbids fake text. Put the seed book's real text back, as today shows it. Show the full-page measure (17 lines at 1280, about 19 at 390) on the Direction sheet instead: a specimen block with a public-domain paragraph, labelled "Specimen: a full page at 1280" (and 390), never on the comp as the book's own text.
- Everything else from round 2 stands. Re-run the Floor checks that the change touches.
