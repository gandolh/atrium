// Contrast of every text and icon pair the web app sets, in light, sepia and dark, read from the tokens in
// apps/web/src/styles/globals.css (the :root, [data-theme="sepia"] and [data-theme="dark"] blocks).
//
//   node scripts/check-contrast.mjs          prints the table, exits 1 on any pair below its minimum
//   node scripts/check-contrast.mjs --json   the same rows as JSON
//
// Minimums (WCAG 2.2): 4.5:1 for text, 3:1 for large text and UI parts (an icon, a field edge, a focus ring, a
// progress rule). A translucent foreground ("reader-fg at 70%") is composited over its ground first. Text on cover
// artwork can't know the artwork, so the check takes the worst of a white and a black picture under the chip.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web/src/styles/globals.css"),
  "utf8",
);

/** The custom properties declared in the first block whose selector is exactly `selector`. */
function block(selector) {
  const props = {};
  const re = new RegExp(`(^|\\n)${selector.replace(/[[\]"]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  for (const match of css.matchAll(re)) {
    for (const [, name, value] of match[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) props[name] = value.trim();
  }
  return props;
}

const base = { ...block(":root"), ...block(':root,\n[data-theme="light"]') };
const THEMES = {
  light: base,
  sepia: { ...base, ...block('[data-theme="sepia"]') },
  dark: { ...base, ...block('[data-theme="dark"]') },
};
// The reading layer reads the theme constants: --reader-* = --theme-<name>-*.
for (const [name, tokens] of Object.entries(THEMES)) {
  for (const key of ["bg", "fg", "surface", "border", "accent"])
    tokens[`reader-${key}`] = tokens[`theme-${name}-${key}`];
}

const hex = (value) => {
  const m = /^#([0-9a-f]{6})$/i.exec(value ?? "");
  if (!m) throw new Error(`not a hex colour: ${value}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (fg, bg, alpha) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));

// [label, foreground, ground, minimum, alpha?]   a ground of "art" means the cover-artwork worst case
const PAIRS = [
  ["ink on paper", "ink", "paper", 4.5],
  ["ink on paper-raised", "ink", "paper-raised", 4.5],
  ["ink on paper-low", "ink", "paper-low", 4.5],
  ["ink on paper-container", "ink", "paper-container", 4.5],
  ["ink on place-current", "ink", "place-current", 4.5],
  ["ink on tint-book", "ink", "tint-book", 4.5],
  ["ink on tint-music", "ink", "tint-music", 4.5],
  ["ink on tint-video", "ink", "tint-video", 4.5],
  ["ink on tint-note", "ink", "tint-note", 4.5],
  ["ink-variant on paper", "ink-variant", "paper", 4.5],
  ["ink-variant on paper-raised", "ink-variant", "paper-raised", 4.5],
  ["ink-variant on paper-low", "ink-variant", "paper-low", 4.5],
  ["ink-variant on paper-container", "ink-variant", "paper-container", 4.5],
  ["ink-variant on tint-book", "ink-variant", "tint-book", 4.5],
  ["ink-variant on tint-music", "ink-variant", "tint-music", 4.5],
  ["ink-variant on tint-video", "ink-variant", "tint-video", 4.5],
  ["ink-variant on tint-note", "ink-variant", "tint-note", 4.5],
  ["accent on paper", "accent", "paper", 4.5],
  ["accent on paper-raised", "accent", "paper-raised", 4.5],
  ["accent on paper-low", "accent", "paper-low", 4.5],
  ["on-place-current on place-current", "on-place-current", "place-current", 4.5],
  ["accent on place-current (current place icon)", "accent", "place-current", 4.5],
  ["on-ink-fill on ink-fill (Add, the active chip)", "on-ink-fill", "ink-fill", 4.5],
  ["on-ink-fill on ink-fill-hover", "on-ink-fill", "ink-fill-hover", 4.5],
  ["on-accent on accent", "on-accent", "accent", 4.5],
  ["danger on paper-raised", "danger", "paper-raised", 4.5],
  ["danger on paper", "danger", "paper", 4.5],
  ["danger on danger-soft", "danger", "danger-soft", 4.5],
  ["pdf-ink on pdf-page (the cover's type)", "pdf-ink", "pdf-page", 4.5],
  ["ink-variant on paper-raised, as an icon", "ink-variant", "paper-raised", 3],
  ["outline on paper (a field's edge)", "outline", "paper", 3],
  ["outline on paper-raised (search, chips, select, buttons)", "outline", "paper-raised", 3],
  ["focus ring (accent) on paper", "accent", "paper", 3],
  ["focus ring (accent) on paper-raised", "accent", "paper-raised", 3],
  ["focus ring (accent) on place-current", "accent", "place-current", 3],
  ["focus ring (accent) on tint-book", "accent", "tint-book", 3],
  ["focus ring (accent) on tint-music", "accent", "tint-music", 3],
  ["focus ring (accent) on tint-video", "accent", "tint-video", 3],
  ["focus ring (accent) on tint-note", "accent", "tint-note", 3],
  ["progress rule on pdf-page", "progress", "pdf-page", 3],
  ["progress rule on tint-book", "progress", "tint-book", 3],
  ["reader-fg on reader-bg", "reader-fg", "reader-bg", 4.5],
  ["reader-fg on reader-surface", "reader-fg", "reader-surface", 4.5],
  ["reader-fg at 80% on reader-bg (running heads, hints)", "reader-fg", "reader-bg", 4.5, 0.8],
  ["reader-fg at 80% on reader-surface (toolbar text)", "reader-fg", "reader-surface", 4.5, 0.8],
  ["reader-accent on reader-bg", "reader-accent", "reader-bg", 4.5],
  ["reader-accent on reader-surface", "reader-accent", "reader-surface", 4.5],
  ["duration chip: on-ink-fill on ink-fill at 75% over white art", "on-ink-fill", "ink-fill", 4.5, 0.75, "white"],
  ["duration chip: on-ink-fill on ink-fill at 75% over black art", "on-ink-fill", "ink-fill", 4.5, 0.75, "black"],
];

const rows = PAIRS.map(([label, fg, bg, need, alpha, art]) => {
  const result = {};
  for (const [theme, tokens] of Object.entries(THEMES)) {
    let ground = hex(tokens[bg]);
    let ink = hex(tokens[fg]);
    if (art) {
      // The chip's own colour is the "foreground" token at `alpha` over the artwork; its text is the other token.
      const picture = art === "white" ? [255, 255, 255] : [0, 0, 0];
      ground = mix(hex(tokens[bg]), picture, alpha);
    } else if (alpha !== undefined) {
      ink = mix(ink, ground, alpha);
    }
    result[theme] = Number(ratio(ink, ground).toFixed(2));
  }
  return { pair: label, need, ...result, ok: Object.values(result).every((v) => v >= need) };
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const width = Math.max(...rows.map((r) => r.pair.length));
  console.log(`${"pair".padEnd(width)}  need  light  sepia  dark`);
  for (const r of rows) {
    const mark = (v) => `${v.toFixed(2)}${v >= r.need ? " " : "!"}`.padStart(6);
    console.log(
      `${r.pair.padEnd(width)}  ${String(r.need).padStart(4)} ${mark(r.light)} ${mark(r.sepia)} ${mark(r.dark)}`,
    );
  }
  const min = (need) => {
    const set = rows.filter((r) => r.need === need);
    return ["light", "sepia", "dark"].map((t) => `${t} ${Math.min(...set.map((r) => r[t])).toFixed(2)}`).join(", ");
  };
  console.log(`\nminimum over the 4.5 pairs: ${min(4.5)}\nminimum over the 3 pairs: ${min(3)}`);
}
process.exit(rows.every((r) => r.ok) ? 0 : 1);
