// Sync the hand-authored narrative from corpus/ into the Starlight content
// tree. The corpus is the single source of truth (see CLAUDE.md); this
// script only *renders* it — it never writes back.
//
//   corpus/wiki/<page>.md  ─┐
//   corpus/status.md, log.md ┼─►  src/content/docs/wiki/<page>.md
//                            ┘     (frontmatter rewritten to Starlight's schema,
//                                   intra-corpus links remapped to /wiki/...)
//
// The generated files carry a "do not edit" banner and are gitignored. Run via
// `npm run sync-corpus` (also runs automatically before `dev` and `docs`).

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// docs/scripts/ → the repo root is two levels up. (The ImbatranimOS docs this
// script started from live at apps/docs/, which is three.)
const repoRoot = resolve(here, '../../..')
const corpus = resolve(repoRoot, 'corpus')
const outDir = resolve(here, '../src/content/docs/wiki')

// Which corpus pages become docs, in sidebar-ish order. `slug` is the URL/file
// stem under /wiki/; links between these are rewritten to /wiki/<slug>/.
const PAGES = [
  { src: 'wiki/overview.md', slug: 'overview' },
  { src: 'wiki/architecture.md', slug: 'architecture' },
  { src: 'wiki/api-layering.md', slug: 'api-layering' },
  { src: 'wiki/design.md', slug: 'design' },
  { src: 'wiki/reader.md', slug: 'reader' },
  { src: 'wiki/conversion.md', slug: 'conversion' },
  { src: 'wiki/pwa.md', slug: 'pwa' },
  { src: 'wiki/latex.md', slug: 'latex' },
  { src: 'wiki/typeset.md', slug: 'typeset' },
  { src: 'wiki/typeset-math.md', slug: 'typeset-math' },
  { src: 'wiki/performance.md', slug: 'performance' },
  { src: 'wiki/glossary.md', slug: 'glossary' },
  { src: 'wiki/glossary-authoring.md', slug: 'glossary-authoring' },
  { src: 'wiki/decisions.md', slug: 'decisions' },
  { src: 'wiki/open-questions.md', slug: 'open-questions' },
  { src: 'wiki/status.md', slug: 'status' },
  { src: 'wiki/status-history.md', slug: 'status-history' },
  { src: 'wiki/status-history-v1.md', slug: 'status-history-v1' },
  { src: 'log.md', slug: 'log' },
]


const KNOWN = new Set(PAGES.map((p) => p.slug))

/** Split leading `--- ... ---` frontmatter from a markdown body. */
function splitFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { fm: {}, body: raw }
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  return { fm, body: raw.slice(m[0].length) }
}

/** Pull the first `# H1` as the title, and strip it from the body. */
function extractTitle(body, fallback) {
  const m = /^#\s+(.+?)\s*$/m.exec(body)
  if (m && body.slice(0, m.index).trim() === '') {
    return { title: m[1].trim(), body: body.slice(m.index + m[0].length).replace(/^\r?\n/, '') }
  }
  return { title: fallback, body }
}

/** Remap links that point at other corpus files to their /wiki/<slug>/ route. */
function rewriteLinks(body) {
  return body.replace(/\]\(([^)]+)\)/g, (whole, target) => {
    if (/^(https?:|mailto:|#|\/)/.test(target)) return whole
    // Split off an optional #anchor.
    const [pathPart, anchor] = target.split('#')
    // Bare corpus path: strip any leading ../ or wiki/ and the .md extension.
    const stem = pathPart
      .replace(/^(\.\.\/)+/, '')
      .replace(/^wiki\//, '')
      .replace(/\.md$/, '')
    if (KNOWN.has(stem)) {
      return `](/wiki/${stem}/${anchor ? '#' + anchor : ''})`
    }
    // Point anything else (briefs/, todos/, source files) at the repo on GitHub.
    if (/\.md$/.test(pathPart) || pathPart.startsWith('../')) {
      const clean = pathPart.replace(/^(\.\.\/)+/, '')
      return `](https://github.com/gandolh/atrium/blob/main/corpus/${clean}${anchor ? '#' + anchor : ''})`
    }
    return whole
  })
}

function yamlEscape(s) {
  return '"' + String(s).replace(/"/g, '\\"') + '"'
}

async function main() {
  // Fresh output each run so deleted corpus pages don't linger.
  if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  let count = 0
  for (const { src, slug } of PAGES) {
    const srcPath = resolve(corpus, src)
    if (!existsSync(srcPath)) {
      console.warn(`  ! skipping ${src} — not found`)
      continue
    }
    const raw = await readFile(srcPath, 'utf8')
    const { fm, body: afterFm } = splitFrontmatter(raw)
    const fallbackTitle = slug.replace(/(^|-)([a-z])/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase())
    const { title, body } = extractTitle(afterFm, fallbackTitle)

    const description = (fm.summary || '').replace(/\s+/g, ' ').slice(0, 160)
    const updated = fm.updated ? ` · updated ${fm.updated}` : ''

    const front = [
      '---',
      `title: ${yamlEscape(title)}`,
      description ? `description: ${yamlEscape(description)}` : null,
      'tableOfContents:',
      '  maxHeadingLevel: 3',
      '---',
      '',
      `:::note[Rendered from \`corpus/${src}\`${updated}]`,
      'This page is generated from the project corpus and rewritten on every docs build. Edit the source in `corpus/`, not here.',
      ':::',
      '',
    ]
      .filter((l) => l !== null)
      .join('\n')

    await writeFile(resolve(outDir, `${slug}.md`), front + rewriteLinks(body).trimStart(), 'utf8')
    count++
  }
  console.log(`sync-corpus: wrote ${count} page(s) → src/content/docs/wiki/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
