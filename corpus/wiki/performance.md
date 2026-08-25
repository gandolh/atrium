---
summary: Recorded live + build-time performance baseline of the current (post-code-split) build — initial JS transfer, chunk sizes, cover→first-page for PDF and EPUB, and EPUB open phases — plus how to reproduce the numbers.
updated: 2026-08-25
---

# Performance baseline

The measured baseline for the **current, post-optimization** build (readers are
now code-split — brief 15). Two layers: **build-time** asset sizes from
`vite build`, and **live** numbers driven through a production-like build in a
real Chrome. Reproduce with the harness at
[`../../playwright/perf/`](../../playwright/perf/) (gitignored) — bring-up +
exact steps live there.

## How this was measured (2026-07-13)

- **Production-like, not dev.** `npm run build -w @ebook-reader/{shared,web}`,
  API via `npm run dev -w @ebook-reader/api` (:3001), web via
  `npx vite preview --port 4173` serving `apps/web/dist/`.
- Driven with the **agent-browser** MCP tools (Chrome DevTools MCP / Lighthouse
  is not available here). Numbers come from in-page `performance.*` +
  `agent_browser_network_requests`. Logged in as seeded user `teo`; measured the
  seeded PDF and the 24 MB EPUB "The Apothecary Diaries: Volume 13".
- Environment: WSL2, HeadlessChrome 150, localhost loopback. **Two caveats that
  shape every live number below:**
  1. **Loopback** — the 24 MB EPUB transfers in ~150 ms; on a real network the
     transfer, not the parse, dominates. Live download timings are a lower bound.
  2. **Cross-origin** (:4173 → :3001) — API responses report size 0 in resource
     timing (no `Timing-Allow-Origin`); their sizes come from the network log.

## Build-time asset baseline (`vite build`)

| Asset | Raw | Gzip | Loaded when |
|---|---|---|---|
| Entry chunk `index-*.js` | 407 kB | **123 kB** | initial load (always) |
| Shared reader chunk `use-page-nav-keys-*.js` | 128 kB | 43 kB | first reader open (PDF or EPUB) |
| PDF reader chunk `index-*.js` | 475 kB | 141 kB | PDF open only |
| EPUB reader chunk `index-*.js` | 411 kB | 130 kB | EPUB open only |
| `pdf.worker.min-*.mjs` | 1,046 kB | ~290 kB | PDF open only |
| App CSS (`index-*.css` ×2) | 52 kB | 10 kB | initial + reader |
| Fonts (woff2/woff, latin + latin-ext) | ~544 kB | — | as needed (6 on first paint) |

Readers are **code-split**: the entry chunk no longer bundles react-pdf /
epub.js. That is the headline win vs. the pre-split build (was a single **1.42 MB**
entry chunk — see the 2026-07-13 log entry / status.md).

## Live: initial app load (login screen)

Confirmed the initial load pulls **only the entry chunk** — reader chunks and
pdf.worker are absent until a book is opened (code-split verified live).

| Metric | Cold (first load) | Warm (cached reload) |
|---|---|---|
| Initial JS transfer | **123 kB** gzip (1 file) | (from cache) |

> **Stale as of 2026-08-25.** The 123 kB above is the brief-15 measurement and
> was never re-taken across briefs 19–33 (PWA, media library, discover, notes,
> the Reading Room rework). A build at `00a7bae` — the commit *before* brief 35
> — measures the entry chunk at **195.76 kB gzip**, so the headline number had
> already drifted ~73 kB before profiles touched anything. Brief 35 itself cost
> **+4.90 kB gzip** (195.76 → 200.66) and +19.5 KiB precache, measured by
> building both trees. Re-baselining the whole table needs a fresh live run
> (the harness in `playwright/`); until then, trust the two figures in this
> note over the table.
| Fonts on first paint | 159 kB (6 files) | (from cache) |
| First Contentful Paint | — | 92 ms |
| domInteractive | 119 ms | 26 ms |
| DOMContentLoaded | 209 ms | 55 ms |
| load | 210 ms | 56 ms |

Library page: after login the library is a **client-side route** (no full
navigation); the `/library?sort=recent` JSON is ~0.6 kB. Effectively instant.

## Live: PDF open (cover → first page canvas visible)

Small seeded PDF (~0.6 MB, "Interpretable Context Methodology…").

| Sample | cover→first-page | What loads |
|---|---|---|
| **Cold** (reader chunk uncached) | **513 ms** | PDF reader chunk 141 kB gz + shared chunk 44 kB gz + reader CSS 2 kB, then pdf.worker 290 kB gz, then first canvas |
| **Warm** (chunks + worker cached) | **85 ms** | first canvas only |

The cold cost is dominated by fetching + parsing the reader chunk and the 290 kB
pdf.worker; once cached, a PDF open is ~85 ms.

## Live: EPUB open (cover → reader visible) — the heavy path

24 MB EPUB. The opening screen shows a download %, then epub.js unzips + parses +
renders into a blob iframe. "Reader visible" = the epub.js `<iframe>` appears
with content (confirmed via screenshot: cover page rendered, resume at 4/302).

| Sample | cover→iframe-visible |
|---|---|
| **Cold** (EPUB reader chunk uncached) | **880 ms** |
| **Warm** (reader chunk cached) | **601 ms** |

### EPUB open phases (best-effort)

The `/file` response is `cache-control: private, no-cache` + `Transfer-Encoding:
chunked` (**status 200, always re-downloaded** — not served from cache; no gzip
on the epub bytes). Approximate timeline of a warm-chunk open:

1. click → EPUB reader chunk fetch (130 kB gz, ~20 ms) + shared chunk (cached)
2. → 24 MB `/file` fetch — **~150 ms on loopback** (would be seconds on a real
   network; this is the deploy-time bottleneck)
3. → epub.js `Book()` unzip + parse + rendition render → iframe visible

Steps 1–2 account for only ~150–300 ms of the ~600–880 ms total; the remaining
**~450–700 ms is client-side epub.js work** (unzip/parse/render). That client
cost is the target of **brief 16** (reduce EPUB open cost / double-parse). Note:
DOM signals top out at "iframe visible" — epub.js emits no marks, so the
parse-vs-render split above is inferred from the timeline, not a hard boundary.

## Headline takeaways

- Code-splitting works: initial JS is **123 kB gz** (down from ~1.42 MB
  unsplit), reader payloads load on demand.
- Warm reader opens are cheap (PDF 85 ms). **Cold** opens pay the chunk +
  worker/parse cost (PDF 513 ms; EPUB 601–880 ms).
- The EPUB heavy path has two remaining costs: the 24 MB transfer (network-bound
  on deploy; loopback hides it) and ~450–700 ms of client-side epub.js
  parse/render (brief 16).
- **Not captured** (no chrome-devtools MCP): Lighthouse score, automatic
  LCP/CLS/INP. If that MCP is registered later, add CWV here and keep this
  harness for the interaction timings.

## Reproduce

See [`../../playwright/perf/README.md`](../../playwright/perf/README.md) for
bring-up + the exact agent-browser drive sequence, and
[`../../playwright/perf/instrument.js`](../../playwright/perf/instrument.js) for
the copy-paste `eval` snippets.
