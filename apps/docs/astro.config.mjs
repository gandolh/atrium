// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

/**
 * Atrium's documentation site.
 *
 *   • Narrative  → authored here, and deliberately THIN: atrium's corpus is
 *                  eighteen maintained wiki pages, so this site renders them
 *                  rather than restating them. What is authored is only what
 *                  the corpus does not have — an orientation page, the HTTP
 *                  route table, and the database schema.
 *   • Corpus     → synced by scripts/sync-corpus.mjs into src/content/docs/wiki/.
 *                  Never edit those; edit corpus/ and rebuild.
 *   • Reference  → TypeDoc over the two published packages, @ebook-reader/shared
 *                  (the web↔api contracts) and @ebook-reader/typeset (the LaTeX
 *                  engine), into public/reference/.
 *   • Diagrams   → archify, from the typed JSON in diagrams/.
 *
 * Sub-path deploy on the estate's one origin: https://gandolh.ro/atrium/docs/.
 * `base` is left at "/" for local preview; vps-deploy passes DOCS_BASE.
 */
// The deployed base path, baked in rather than injected at deploy time.
//
// vps-deploy ships what this repo already built and VERIFIES this base — it does
// not set it. That is the estate's rule for the case that matters most (Ward's
// UI does the same, see vps-deploy/stacks/ward.ts): a variable the deploy passes
// that changes nothing is a variable that can silently disagree, whereas a value
// baked here and checked there cannot. Build with `npm run docs`; a wrong base
// fails the deploy by name instead of shipping a page whose every asset 404s.
//
// DOCS_BASE still overrides it, for building a copy to serve from somewhere else.
const base = process.env.DOCS_BASE ?? '/atrium/docs/'

export default defineConfig({
  base,
  site: 'https://gandolh.ro',
  integrations: [
    starlight({
      title: 'Atrium',
      description:
        'A personal cloud space — a household media library of books, music and video, plus authored Notes and LaTeX documents.',
      tagline: 'A gallery of books, records, film and notebooks.',
      customCss: ['./src/styles/theme.css'],
      // The light/dark toggle is KEPT here, unlike Ward's docs: atrium is a
      // three-theme reading app, and documentation for a reading surface that
      // offered no choice would contradict the thing it documents.
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/gandolh/atrium' }],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What Atrium is', link: '/' },
            { label: 'Overview', link: '/wiki/overview/' },
            { label: 'Architecture', link: '/wiki/architecture/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'HTTP API', link: '/api/' },
            { label: 'Data model', link: '/data/' },
            { label: 'API layering', link: '/wiki/api-layering/' },
            {
              label: 'Packages (TypeDoc) ↗',
              link: '/reference/',
              attrs: { target: '_blank' },
            },
          ],
        },
        {
          label: 'The product',
          items: [
            { label: 'Design — Reading Room', link: '/wiki/design/' },
            { label: 'The reader', link: '/wiki/reader/' },
            { label: 'Conversion', link: '/wiki/conversion/' },
            { label: 'The PWA layer', link: '/wiki/pwa/' },
          ],
        },
        {
          label: 'LaTeX and typesetting',
          items: [
            { label: 'The /latex destination', link: '/wiki/latex/' },
            { label: 'The typesetting engine', link: '/wiki/typeset/' },
            { label: 'Setting mathematics', link: '/wiki/typeset-math/' },
            { label: 'Authoring vocabulary', link: '/wiki/glossary-authoring/' },
          ],
        },
        {
          label: 'Decisions and state',
          items: [
            { label: 'Decisions (D1–D47)', link: '/wiki/decisions/' },
            { label: 'Glossary', link: '/wiki/glossary/' },
            { label: 'Performance baseline', link: '/wiki/performance/' },
            { label: 'Open questions', link: '/wiki/open-questions/' },
          ],
        },
        {
          label: 'Status',
          items: [
            { label: 'Status snapshot', link: '/wiki/status/' },
            { label: 'Change log', link: '/wiki/log/' },
            { label: 'Archive — through brief 44', link: '/wiki/status-history/' },
            { label: 'Archive — v1', link: '/wiki/status-history-v1/' },
          ],
        },
      ],
    }),
  ],
})
