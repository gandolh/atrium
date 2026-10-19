import type { SidebarsConfig } from '@docusaurus/plugin-content-docs'

// Ported group by group from the Starlight sidebar (brief 87), labels as they
// were, plus the four corpus pages its hand-kept list had left out. Doc items
// are checked at build time: an entry for a page that does not exist fails the
// build. Doc ids are paths under docs/ without the extension
// (docs/wiki/status.md → 'wiki/status').
const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Start here',
      collapsible: false,
      items: [
        { type: 'doc', id: 'index', label: 'What Atrium is' },
        { type: 'doc', id: 'wiki/overview', label: 'Overview' },
        { type: 'doc', id: 'wiki/architecture', label: 'Architecture' },
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsible: false,
      items: [
        { type: 'doc', id: 'api', label: 'HTTP API' },
        { type: 'doc', id: 'data', label: 'Data model' },
        { type: 'doc', id: 'wiki/api-layering', label: 'API layering' },
        // TypeDoc's HTML in static/, not a Docusaurus route: `pathname://` makes
        // it a plain link (new tab, baseUrl still applied) instead of a router
        // navigation that would 404.
        { type: 'link', label: 'Packages (TypeDoc) ↗', href: 'pathname:///reference/' },
      ],
    },
    {
      type: 'category',
      label: 'The product',
      collapsible: false,
      items: [
        { type: 'doc', id: 'wiki/design', label: 'Design — Reading Room' },
        { type: 'doc', id: 'wiki/reader', label: 'The reader' },
        { type: 'doc', id: 'wiki/conversion', label: 'Conversion' },
        { type: 'doc', id: 'wiki/pwa', label: 'The PWA layer' },
        { type: 'doc', id: 'wiki/jukebox', label: 'The Jukebox' },
        { type: 'doc', id: 'wiki/glossary-jukebox', label: 'Jukebox vocabulary' },
      ],
    },
    {
      type: 'category',
      label: 'LaTeX and typesetting',
      collapsible: false,
      items: [
        { type: 'doc', id: 'wiki/latex', label: 'The /latex destination' },
        { type: 'doc', id: 'wiki/typeset', label: 'The typesetting engine' },
        { type: 'doc', id: 'wiki/typeset-math', label: 'Setting mathematics' },
        { type: 'doc', id: 'wiki/glossary-authoring', label: 'Authoring vocabulary' },
      ],
    },
    {
      type: 'category',
      label: 'Decisions and state',
      collapsible: false,
      items: [
        { type: 'doc', id: 'wiki/decisions', label: 'Decisions (D1–D47)' },
        { type: 'doc', id: 'wiki/glossary', label: 'Glossary' },
        { type: 'doc', id: 'wiki/performance', label: 'Performance baseline' },
        { type: 'doc', id: 'wiki/open-questions', label: 'Open questions' },
        { type: 'doc', id: 'wiki/jellyfin-comparison', label: 'Jellyfin compared' },
      ],
    },
    {
      type: 'category',
      label: 'Status',
      collapsible: false,
      items: [
        { type: 'doc', id: 'wiki/status', label: 'Status snapshot' },
        { type: 'doc', id: 'wiki/log', label: 'Change log' },
        { type: 'doc', id: 'wiki/status-history', label: 'Archive — through brief 44' },
        { type: 'doc', id: 'wiki/status-history-v2', label: 'Archive — 2026-08-26 to 08-27' },
        { type: 'doc', id: 'wiki/status-history-v1', label: 'Archive — v1' },
      ],
    },
  ],
}

export default sidebars
