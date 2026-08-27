import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, createLatinModernProvider, decodeUtf8 } from "../src/index.ts";
import type { CompileResult, GlyphRun, Page } from "../src/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";
import { dumpResult, goldenTest, loadFixture } from "./harness.ts";

/**
 * End-to-end tests for `compile()` (brief 37, chunk 7): source in, pages and a
 * PDF out.
 *
 * The two golden fixtures are the acceptance criterion — plain prose and a
 * structured document — and they are checked *by eye* as well as by diff. The
 * PDF written under `writes a PDF that opens` is the artefact that was opened;
 * a golden file can only tell you that nothing changed, never that the page was
 * right in the first place.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());

function run(name: string, opts: Parameters<typeof compile>[2] = {}): CompileResult {
  const fixture = loadFixture(name);
  return compile(fixture.files, fixture.entrypoint, { fonts, ...opts });
}

function encode(text: string): Uint8Array {
  return new Uint8Array(new TextEncoder().encode(text));
}

function project(body: string): { files: Record<string, Uint8Array>; entrypoint: string } {
  return {
    files: { "main.tex": encode(`\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`) },
    entrypoint: "main.tex",
  };
}

function glyphRuns(page: Page): GlyphRun[] {
  return page.items.filter((item): item is GlyphRun => item.kind === "glyphrun");
}

function pageText(page: Page): string {
  return glyphRuns(page)
    .map((item) => item.text)
    .join(" ");
}

// --- the acceptance goldens -------------------------------------------------

goldenTest("prose", compile, { compileOptions: { fonts } });
goldenTest("structured", compile, { compileOptions: { fonts } });

// --- a real PDF -------------------------------------------------------------

test("a .tex file of plain prose compiles to a real PDF", () => {
  const result = run("prose");
  assert.deepEqual(
    result.diagnostics.filter((d) => d.severity === "error"),
    [],
  );
  assert.ok(result.pdf !== null);
  assert.equal(result.stats.pages, result.pages.length);
  assert.equal(result.stats.bytes, result.pdf.length);

  const header = new TextDecoder().decode(result.pdf.subarray(0, 8));
  assert.match(header, /^%PDF-1\.[0-9]/);
  const trailer = new TextDecoder().decode(result.pdf.subarray(result.pdf.length - 32));
  assert.match(trailer, /%%EOF/);
});

test("writes a PDF that opens, for the eyeball check the brief asks for", () => {
  const result = run("structured");
  assert.ok(result.pdf !== null);
  const path = join(mkdtempSync(join(tmpdir(), "typeset-pdf-")), "structured.pdf");
  writeFileSync(path, result.pdf);
  // Three pages, a folio on each, and the last one carrying the section that
  // `\newpage` pushed there. Everything else about this file was checked by
  // opening it.
  assert.equal(result.pages.length, 3);
  for (const page of result.pages) {
    assert.equal(page.width, 612);
    assert.equal(page.height, 792);
    const folio = glyphRuns(page).at(-1);
    assert.equal(folio?.text, String(page.number));
  }
  assert.match(pageText(result.pages[2] as Page), /After a page break/);
});

test("the same source compiles to byte-identical PDFs", () => {
  // No clock anywhere in the pipeline (`renderPdf` is never given a
  // `creationDate`), which is what makes a byte assertion possible at all.
  const a = run("prose").pdf;
  const b = run("prose").pdf;
  assert.ok(a !== null && b !== null);
  assert.deepEqual([...a], [...b]);
});

// --- the two-pass cycle -----------------------------------------------------

test("\\pageref resolves to a real page number rather than ??", () => {
  const result = run("structured");
  const text = result.pages.map(pageText).join(" ");
  assert.doesNotMatch(text, /\?\?/);
  // `sec:lists` is on page 1 of this fixture, and the sentence that references
  // it is too — a forward reference resolved by the second layout pass.
  assert.match(pageText(result.pages[0] as Page), /begins on page/);
});

test("the table of contents carries page numbers from the previous pass", () => {
  const result = run("structured");
  const first = pageText(result.pages[0] as Page);
  assert.match(first, /Contents/);
  assert.match(first, /After a page break/);
  assert.doesNotMatch(first, /\?\?/);
});

test("a \\pageref to a label that never reaches a page is reported", () => {
  // `\label` in the preamble never becomes vertical material, so its marker is
  // never placed — the case `resolvePageNumbers` exists to report.
  const files = {
    "main.tex": encode(
      "\\documentclass{article}\n\\begin{document}\n\\pageref{nowhere}\n\\end{document}\n",
    ),
  };
  const result = compile(files, "main.tex", { fonts });
  assert.ok(result.diagnostics.some((d) => d.code === "undefined-reference"));
});

// --- footnotes --------------------------------------------------------------

test("a footnote lands at the foot of the page its mark is on", () => {
  const filler = "Filler text that pushes the mark down the page. ".repeat(40);
  const { files, entrypoint } = project(
    `${filler}\n\nA sentence with a note\\footnote{The note itself.} in it.`,
  );
  const result = compile(files, entrypoint, { fonts });
  assert.ok(result.pages.length >= 1);

  const withMark = result.pages.find((page) => pageText(page).includes("The note itself."));
  assert.ok(withMark !== undefined, "the note was set somewhere");
  assert.ok(pageText(withMark).includes("A sentence with a note"), "on the same page as its mark");

  // One `GlyphRun` per word, so identify the note by its size rather than by
  // its text: `\footnotesize` is 8pt against the body's 10pt.
  const runs = glyphRuns(withMark);
  const note = runs.filter((item) => item.size === 8);
  const body = runs.filter((item) => item.size === 10 && item.y <= 72 + 648);
  assert.ok(note.length > 0, "set at \\footnotesize");
  assert.ok(body.length > 0);
  const noteTop = Math.min(...note.map((item) => item.y));
  const bodyBottom = Math.max(...body.map((item) => item.y));
  assert.ok(noteTop > bodyBottom, "below every line of the body");
  assert.ok(
    withMark.items.some((item) => item.kind === "rule" && item.y > bodyBottom && item.y < noteTop),
    "with the footnote rule between them",
  );
  // The mark itself is a raised superscript at `\scriptsize`.
  assert.ok(runs.some((item) => item.size === 7));
});

// --- page design ------------------------------------------------------------

test("geometry's margin option moves the text block", () => {
  const wide = compile(
    {
      "main.tex": encode(
        "\\documentclass{article}\n\\usepackage[margin=2in]{geometry}\n\\begin{document}\nHello.\n\\end{document}\n",
      ),
    },
    "main.tex",
    { fonts },
  );
  const first = glyphRuns(wide.pages[0] as Page)[0];
  assert.ok(first !== undefined);
  assert.equal(Math.round(first.x), 144 + 15); // 2in margin plus \parindent
});

test("a4paper changes the media box", () => {
  const a4 = compile(
    {
      "main.tex": encode("\\documentclass[a4paper]{article}\n\\begin{document}\nHello.\n\\end{document}\n"),
    },
    "main.tex",
    { fonts },
  );
  assert.equal(Math.round((a4.pages[0] as Page).width), 595);
  assert.equal(Math.round((a4.pages[0] as Page).height), 842);
});

test("an unimplemented class size is reported rather than silently set at 10pt", () => {
  const result = compile(
    { "main.tex": encode("\\documentclass[12pt]{article}\n\\begin{document}\nx\n\\end{document}\n") },
    "main.tex",
    { fonts },
  );
  const reported = result.diagnostics.find((d) => d.construct === "\\documentclass");
  assert.ok(reported !== undefined);
  assert.equal(reported.severity, "warning");
  assert.match(reported.message, /size10\.clo/);
  assert.ok(result.pdf !== null, "and the document still compiles");
});

test("an empty document is one blank page, not zero pages", () => {
  const result = compile(project("").files, "main.tex", { fonts });
  assert.equal(result.pages.length, 1);
  assert.ok(result.pdf !== null);
});

// --- refusals ---------------------------------------------------------------

test("compiling without a font provider refuses rather than substituting a face", () => {
  const fixture = loadFixture("prose");
  const result = compile(fixture.files, fixture.entrypoint);
  assert.equal(result.pdf, null);
  const missing = result.diagnostics.find((d) => d.code === "missing-font");
  assert.ok(missing !== undefined);
  assert.match(missing.message, /no font provider/);
});

test("a missing entrypoint is a diagnostic, not a throw", () => {
  const result = compile({ "other.tex": encode("x") }, "main.tex", { fonts });
  assert.equal(result.pdf, null);
  assert.equal(result.diagnostics[0]?.code, "missing-file");
});

test("an exhausted step budget stops the compile and says so", () => {
  const fixture = loadFixture("structured");
  const result = compile(fixture.files, fixture.entrypoint, { fonts, stepBudget: 400 });
  assert.equal(result.pdf, null);
  assert.ok(result.diagnostics.some((d) => d.code === "budget-exceeded"));
  assert.ok(result.stats.steps > 0);
});

test("a step budget large enough for the document leaves it alone", () => {
  const result = run("prose", { stepBudget: 5_000_000 });
  assert.ok(!result.diagnostics.some((d) => d.code === "budget-exceeded"));
});

test("an aborted signal stops the compile", () => {
  const fixture = loadFixture("structured");
  const result = compile(fixture.files, fixture.entrypoint, { fonts, signal: { aborted: true } });
  assert.equal(result.pdf, null);
  assert.ok(result.diagnostics.some((d) => d.message.includes("cancelled")));
});

test("maxPages caps a long document", () => {
  const { files, entrypoint } = project("Text.\n\n\\newpage\n\nText.\n\n\\newpage\n\nText.");
  const result = compile(files, entrypoint, { fonts, maxPages: 2 });
  assert.equal(result.pages.length, 2);
  assert.ok(result.diagnostics.some((d) => d.code === "limit-exceeded"));
  assert.equal(result.pdf, null);
});

test("maxOutputBytes caps the PDF", () => {
  const fixture = loadFixture("prose");
  const result = compile(fixture.files, fixture.entrypoint, { fonts, maxOutputBytes: 1024 });
  assert.equal(result.pdf, null);
  assert.ok(result.diagnostics.some((d) => d.code === "limit-exceeded"));
});

test("an unsupported construct keeps its error and produces no PDF", () => {
  // `\includegraphics` used to be the exemplar here; chunk 39.2 implemented it
  // for real (a missing file is now `missing-file`, not `unsupported`, and a
  // resolvable one places into the PDF), so `\textsc` — still genuinely
  // unsupported — takes over the role this test actually needs.
  const { files, entrypoint } = project("\\textsc{cat}");
  const result = compile(files, entrypoint, { fonts });
  assert.equal(result.pdf, null);
  assert.ok(result.diagnostics.some((d) => d.code === "unsupported"));
  // The pages are still there, so an editor can show a preview beside the error.
  assert.ok(result.pages.length >= 1);
});

// --- UTF-8 ------------------------------------------------------------------

test("decodeUtf8 handles ASCII, multi-byte and astral characters", () => {
  assert.equal(decodeUtf8(encode("plain ASCII")), "plain ASCII");
  assert.equal(decodeUtf8(encode("café — naïve")), "café — naïve");
  assert.equal(decodeUtf8(encode("𝔄𝔅ℭ")), "𝔄𝔅ℭ");
});

test("decodeUtf8 strips a byte-order mark", () => {
  assert.equal(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), "a");
  // Only at the start: a BOM in the middle is a real zero-width no-break space.
  assert.equal(decodeUtf8(new Uint8Array([0x61, 0xef, 0xbb, 0xbf])), "a\ufeff");
});

test("decodeUtf8 replaces malformed bytes and keeps going", () => {
  assert.equal(decodeUtf8(new Uint8Array([0x61, 0xff, 0x62])), "a\ufffdb");
  // Overlong `/`, the classic path-traversal smuggle.
  assert.equal(decodeUtf8(new Uint8Array([0xc0, 0xaf])), "\ufffd\ufffd");
  // Truncated sequence: only the sequence is lost, not the text after it.
  assert.equal(decodeUtf8(new Uint8Array([0xe2, 0x82, 0x61])), "\ufffda");
  // A surrogate half is not a scalar value.
  assert.equal(decodeUtf8(new Uint8Array([0xed, 0xa0, 0x80])), "\ufffd");
});

test("decodeUtf8 survives a file larger than its emit chunk", () => {
  const long = "é".repeat(20_000);
  assert.equal(decodeUtf8(encode(long)), long);
});

test("a UTF-8 document sets its accented characters", () => {
  const { files, entrypoint } = project("Caf\u00e9 na\u00efve.");
  const result = compile(files, entrypoint, { fonts });
  assert.match(pageText(result.pages[0] as Page), /Caf\u00e9/);
});

// --- the dump is still readable ---------------------------------------------

test("the golden dump of a real compile names pages, glyph runs and rules", () => {
  const dump = dumpResult(run("structured"), "main.tex");
  assert.match(dump, /^pages: 3$/m);
  assert.match(dump, /lmroman10-bold@14\.400/);
  assert.match(dump, /lmmono10-regular@10\.000/);
  assert.match(dump, /^ {2}rule /m);
});
