// Sync the hand-authored narrative from corpus/ into the Docusaurus docs tree.
// The corpus is the single source of truth (see corpus-flow); this script only
// *renders* it — it never writes back.
//
//   corpus/wiki/*.md  ┐
//   corpus/status.md  ┼─►  docs/wiki/<slug>.md
//   corpus/log.md     ┘     (frontmatter rewritten to Docusaurus's keys,
//                            corpus links resolved to file links Docusaurus checks)
//
// Pages are auto-discovered: every *.md under corpus/wiki/, plus status.md and
// log.md at the corpus root if present, minus the DENY set. Discovery rather
// than a hand-kept list, because a list drifts silently: a page added to the
// wiki and not to the list is simply absent from the site, and every link to it
// falls through to GitHub.
//
// Links are resolved against the SOURCE page's own directory, not by stripping
// `../`. A link to another rendered page becomes a relative file link
// (`./decisions.md#anchor`), which Docusaurus resolves to the right route under
// any baseUrl and reports at build time if it does not exist. A link to anything
// else in the repo (a brief, a todo, source code, the README) becomes a GitHub
// URL for the path it actually points at — `tree/` for a directory, `blob/` for
// a file.
//
// The generated files carry a "do not edit" banner and are gitignored. Run via
// `npm run sync-corpus` (also runs before `start` and `docs`).
//
// EDIT THIS: the repo's GitHub URL, so links to files the site does not render
// resolve. Set to '' to leave such links untouched.
const GITHUB_REPO = 'https://github.com/gandolh/atrium'
const BRANCH = 'main'
// Sibling checkouts a corpus links into (`../../../<dir>/corpus/...`), keyed by
// the local directory name, which need not match the GitHub repo name. A link
// that leaves the repo for a directory not listed here is reduced to its text,
// with a warning: the site cannot serve it, and a guessed URL would 404.
const OTHER_REPOS = {
  // Ward, the estate's sign-in service; decisions.md links its overview.
  wzd_auth: 'https://github.com/gandolh/ward-auth',
}
// Corpus pages deliberately NOT published (working notes, scratch, history
// snapshots), by slug. A deny list rather than an allow list: a new page is
// published by default, and keeping one back is a decision someone wrote down.
// Links to a denied page fall through to its GitHub URL.
// Empty on purpose: the owner chose on 2026-10-19 to publish all four pages the
// Starlight site's hand-kept list had left out (glossary-jukebox,
// jellyfin-comparison, jukebox, status-history-v2).
const DENY = new Set([])

import { readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve, relative, basename, posix, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const siteDir = resolve(here, '..')
const outDir = resolve(siteDir, 'docs/wiki')

/** The nearest ancestor of the site that holds a corpus/ — no hard-coded depth. */
function findRepoRoot(from) {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, 'corpus'))) return dir
    if (dirname(dir) === dir) return undefined
  }
}

const repoRoot = findRepoRoot(siteDir)
const corpus = repoRoot && resolve(repoRoot, 'corpus')

/** Discover the corpus pages to render, in a stable order. */
async function discoverPages() {
  const pages = []
  const wikiDir = resolve(corpus, 'wiki')
  if (existsSync(wikiDir)) {
    const files = (await readdir(wikiDir)).filter((f) => f.endsWith('.md')).sort()
    for (const f of files) pages.push({ src: `wiki/${f}`, slug: basename(f, '.md') })
  }
  for (const root of ['status.md', 'log.md']) {
    // A corpus that keeps status in wiki/ already has a `status` slug.
    const slug = basename(root, '.md')
    if (existsSync(resolve(corpus, root)) && !pages.some((p) => p.slug === slug)) {
      pages.push({ src: root, slug })
    }
  }
  return pages.filter((p) => !DENY.has(p.slug))
}

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

/**
 * Rewrite the relative links in one page. `src` is the page's path inside
 * corpus/ (e.g. `wiki/overview.md`); `known` maps corpus paths to slugs.
 * Fenced code blocks are left alone — a `[x](y)` in an example is not a link.
 */
async function rewriteLinks(body, src, known, warnings) {
  // Split into prose and fenced blocks. Prose is matched as a whole, not line
  // by line, because link text wraps: `[brief\n74](../briefs/…)` is one link.
  const blocks = []
  let fence = null
  for (const line of body.split('\n')) {
    const open = /^\s*(`{3,}|~{3,})/.exec(line)
    const inCode = fence !== null || open !== null
    if (open) fence = fence === null ? open[1][0] : open[1][0] === fence ? null : fence
    const last = blocks.at(-1)
    if (last && last.code === inCode) last.lines.push(line)
    else blocks.push({ code: inCode, lines: [line] })
  }

  const out = []
  for (const { code, lines } of blocks) {
    let text = lines.join('\n')
    if (!code) {
      const matches = [...text.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g)]
      for (const [whole, bang, label, target, title = ''] of matches) {
        const next = await rewriteTarget(target, src, known, bang === '!', warnings)
        if (next === null) text = text.replace(whole, label)
        else if (next !== target) text = text.replace(whole, `${bang}[${label}](${next}${title})`)
      }
    }
    out.push(text)
  }
  return out.join('\n')
}

async function rewriteTarget(target, src, known, isImage, warnings) {
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target
  const [pathPart, anchor] = target.split('#')
  const hash = anchor ? `#${anchor}` : ''
  const corpusRel = posix.normalize(posix.join(posix.dirname(src), decodeURI(pathPart)))

  if (!isImage && known.has(corpusRel)) return `./${known.get(corpusRel)}.md${hash}`
  if (!GITHUB_REPO) return target

  const abs = resolve(corpus, corpusRel)
  const repoRel = relative(repoRoot, abs).split(sep).join('/')
  if (repoRel.startsWith('..')) {
    // `<sibling>/<path>` relative to the directory holding this checkout.
    const [sibling, ...rest] = relative(dirname(repoRoot), abs).split(sep)
    if (OTHER_REPOS[sibling] && !sibling.startsWith('..')) {
      return `${OTHER_REPOS[sibling]}/blob/${BRANCH}/${rest.join('/')}${hash}`
    }
    warnings.push(`${src}: link leaves the repo, kept as text — ${target}`)
    return null
  }
  let kind = 'blob'
  try {
    if ((await stat(abs)).isDirectory()) kind = 'tree'
  } catch {
    warnings.push(`${src}: link target does not exist — ${target}`)
  }
  // An image needs the raw bytes, not GitHub's HTML page for the file.
  if (isImage) return `${GITHUB_REPO}/raw/${BRANCH}/${repoRel}`
  return `${GITHUB_REPO}/${kind}/${BRANCH}/${repoRel}${hash}`
}

const yamlEscape = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

async function main() {
  if (!corpus) {
    console.error(`sync-corpus: no corpus/ above ${siteDir} — is this a corpus-flow project?`)
    process.exit(1)
  }
  const PAGES = await discoverPages()
  const known = new Map(PAGES.map((p) => [p.src, p.slug]))

  // Fresh output each run so deleted corpus pages don't linger.
  if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const warnings = []
  for (const { src, slug } of PAGES) {
    const raw = await readFile(resolve(corpus, src), 'utf8')
    const { fm, body: afterFm } = splitFrontmatter(raw)
    const fallbackTitle = slug.replace(/(^|-)([a-z])/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase())
    const { title, body } = extractTitle(afterFm, fallbackTitle)
    const description = (fm.summary || '').replace(/\s+/g, ' ').slice(0, 160)
    const updated = fm.updated ? ` · updated ${fm.updated}` : ''

    const front = [
      '---',
      `title: ${yamlEscape(title)}`,
      description ? `description: ${yamlEscape(description)}` : null,
      'toc_max_heading_level: 3',
      '---',
      '',
      // A plain-text title: in CommonMark mode (.md) Docusaurus drops a title
      // that holds inline code into the body and shows "NOTE" instead.
      `:::note[Rendered from corpus/${src}${updated}]`,
      'This page is generated from the project corpus and rewritten on every docs build. Edit the source in `corpus/`, not here.',
      ':::',
      '',
    ]
      .filter((l) => l !== null)
      .join('\n')

    const rendered = await rewriteLinks(body, src, known, warnings)
    await writeFile(resolve(outDir, `${slug}.md`), front + rendered.trimStart(), 'utf8')
  }
  for (const w of warnings) console.warn(`  ! ${w}`)
  console.log(`sync-corpus: wrote ${PAGES.length} page(s) → docs/wiki/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
