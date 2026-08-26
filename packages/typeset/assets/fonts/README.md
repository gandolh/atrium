# Committed fonts

The engine performs no I/O (D38): `compile()` never opens a file, so a
`FontProvider` is injected by the caller and *something outside `src/`* has to
turn these files into bytes. In Node that something is
`@ebook-reader/typeset/fonts/node`, which reads this directory; in a browser it
would be `fetch()`. Either way the bytes reach the engine through
`createLatinModernProvider()`.

## Latin Modern

- **Source**: CTAN package [`lm`](https://ctan.org/pkg/lm),
  `fonts/opentype/public/lm/` — mirrored from
  <https://mirrors.ctan.org/fonts/lm/fonts/opentype/public/lm/>
- **Version**: 2.005 (21 III 2021)
- **Upstream**: GUST e-foundry,
  <http://www.gust.org.pl/projects/e-foundry/latin-modern/>
- **Authors**: Bogusław Jackowski and Janusz M. Nowacki, after Donald E. Knuth's
  Computer Modern
- **Licence**: GUST Font License 1.0 (an LPPL 1.3c-style permissive licence) —
  see `GUST-FONT-LICENSE.txt` in this directory, which the licence requires be
  distributed alongside the fonts.

Latin Modern is the OpenType successor to Computer Modern, which is why a
document set by this engine looks like a TeX document rather than like a web
page.

The files are unmodified upstream releases. The GUST licence *requests* (but
does not require) that derived works be renamed; we do not modify them, so the
names stay as shipped.

### The faces, and why these twelve

One design size — 10 pt — for every face, because that is LaTeX's default body
size and carrying the optical-size variants would multiply the payload for a
refinement the engine cannot yet ask for.

| `FontRequest`                | file                        |
| ---------------------------- | --------------------------- |
| serif / regular / upright    | `lmroman10-regular.otf`     |
| serif / regular / italic     | `lmroman10-italic.otf`      |
| serif / bold / upright       | `lmroman10-bold.otf`        |
| serif / bold / italic        | `lmroman10-bolditalic.otf`  |
| sans / regular / upright     | `lmsans10-regular.otf`      |
| sans / regular / italic      | `lmsans10-oblique.otf`      |
| sans / bold / upright        | `lmsans10-bold.otf`         |
| sans / bold / italic         | `lmsans10-boldoblique.otf`  |
| mono / regular / upright     | `lmmono10-regular.otf`      |
| mono / regular / italic      | `lmmono10-italic.otf`       |
| mono / bold / upright        | `lmmonolt10-bold.otf`       |
| mono / bold / italic         | `lmmonolt10-boldoblique.otf`|

Two of those need justifying.

*Sans has no italic.* Latin Modern Sans, like Computer Modern Sans, is slanted
rather than italic; `lmsans10-oblique` **is** the family's italic and LaTeX maps
`\itshape` to it. This is the family's own answer, not a substitution.

*Mono bold comes from a neighbouring series.* Computer Modern Typewriter has no
bold, and Latin Modern inherits that: the only bold typewriter GUST ships is in
the "Light" series (`lmmonolt10-bold`, `LMMonoLt10-Bold`). Using it is what TeX
distributions do for `\ttfamily\bfseries`. It is a within-family choice made
once, here, in the open — not a silent fallback at request time. A face the
provider genuinely does not have returns `undefined` so the caller emits a
`missing-font` diagnostic.

### Refreshing them

```
BASE=https://mirrors.ctan.org/fonts/lm
curl -O "$BASE/fonts/opentype/public/lm/<face>.otf"
curl -o GUST-FONT-LICENSE.txt "$BASE/doc/fonts/lm/GUST-FONT-LICENSE.TXT"
```

The loader reads whatever `.otf` files are in this directory and keys them by
filename stem, so adding a face is a matter of dropping the file in and adding a
row to the table in `src/font/latin-modern.ts`. Renaming one, however, changes a
`FontHandle.id`, which is printed verbatim into every golden dump — so don't.
