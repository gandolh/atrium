import type { Config } from '@docusaurus/types'
import type * as Preset from '@docusaurus/preset-classic'

/**
 * Atrium's documentation site (Docusaurus since 2026-10-19, brief 87; it was
 * Astro Starlight before, at the same URLs).
 *
 *   • Narrative  → authored here, and deliberately THIN: atrium's corpus is a
 *                  set of maintained wiki pages, so this site renders them
 *                  rather than restating them. What is authored is only what
 *                  the corpus does not have — an orientation page, the HTTP
 *                  route table, and the database schema (docs/*.mdx).
 *   • Corpus     → synced by scripts/sync-corpus.mjs into docs/wiki/.
 *                  Never edit those; edit corpus/ and rebuild.
 *   • Reference  → TypeDoc over the two published packages, @ebook-reader/shared
 *                  (the web↔api contracts) and @ebook-reader/typeset (the LaTeX
 *                  engine), into static/reference/.
 *   • Diagrams   → archify, from the typed JSON in diagrams/, into
 *                  static/diagrams/.
 */

// The deployed base path, baked in rather than injected at deploy time.
//
// vps-deploy ships what this repo already built and VERIFIES this base — it does
// not set it. A variable the deploy passes that changes nothing is a variable
// that can silently disagree, whereas a value baked here and checked there
// cannot. Build with `npm run docs`; a wrong base fails the deploy by name
// instead of shipping a page whose every asset 404s.
//
// DOCS_BASE still overrides it, for building a copy to serve from somewhere else.
const baseUrl = process.env.DOCS_BASE ?? '/atrium/docs/'

const GITHUB = 'https://github.com/gandolh/atrium'

const config: Config = {
  title: 'Atrium',
  tagline: 'A gallery of books, records, film and notebooks.',
  // The origin, used only for absolute URLs (sitemap, og tags). The real host
  // is the deploy's business, not this repo's.
  url: 'https://example.org',
  baseUrl,
  // Directory-style URLs (/wiki/overview/ → wiki/overview/index.html), the
  // layout the Starlight site published and the sub-path deploy serves.
  trailingSlash: true,
  // Opt in to the v4 behaviour now (Docusaurus Faster, CSS cascade layers,
  // namespaced storage) so the v4 upgrade is a version bump, not a migration.
  future: { v4: true },
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'warn',
  markdown: {
    // .md (the synced corpus) parses as CommonMark, .mdx (hand-authored) as MDX.
    // MDX for everything breaks on corpus prose: a bare `<` or `{` is JSX.
    format: 'detect',
    hooks: { onBrokenMarkdownLinks: 'throw' },
  },
  i18n: { defaultLocale: 'en', locales: ['en'] },
  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/', // docs-only site: no /docs/ prefix under the base
          sidebarPath: './sidebars.ts',
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],
  // Local, offline search (Starlight shipped Pagefind; Docusaurus ships nothing).
  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      { hashed: true, docsRouteBasePath: '/', indexBlog: false, indexPages: false },
    ],
  ],
  themeConfig: {
    // Both modes, with the toggle. Atrium is a three-theme reading app (light,
    // sepia, dark), and documentation for a reading surface that offered no
    // choice would contradict the thing it documents. Sepia is not offered:
    // it is a reading-surface theme, and this is chrome.
    colorMode: { defaultMode: 'light', disableSwitch: false, respectPrefersColorScheme: true },
    navbar: {
      title: 'Atrium',
      items: [{ href: GITHUB, label: 'GitHub', position: 'right' }],
    },
  } satisfies Preset.ThemeConfig,
}

export default config
