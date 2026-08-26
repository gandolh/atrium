---
summary: Naming authority for authored content — Notes (note, page, stroke, text box) and LaTeX (project, draft, published document, version, typesetting engine, supported subset, diagnostic); the collected-media half lives in glossary.md.
updated: 2026-08-26
---

# Glossary — authored content

The second half of the project's naming authority, split from
[glossary.md](glossary.md) when it outgrew the page-size rule. The split follows
D36's own distinction: **collected** things (library, media, reading state) are
defined there; **authored** things — what you make inside Atrium — are defined
here. Same rules: one canonical term per concept, `_Avoid_` lists the synonyms it
displaces, definitions only.

## Notes

**Note**:
One per-user notebook: an ordered list of note pages, stored server-side
(brief 26).
_Avoid_: notebook, document, doc, sketch

**Note page**:
A single page inside a note, carrying a template (blank / ruled / grid), its
strokes and its text boxes.
_Avoid_: canvas, sheet, slide, board

**Stroke**:
One vector ink mark — sampled points with pressure, rendered via
perfect-freehand. Coordinates are normalized to page width.
_Avoid_: path, line, scribble, mark

**Text box**:
A movable typed-text element placed on a note page.
_Avoid_: label, annotation, caption, textarea

## Authoring

**LaTeX project**:
A per-profile document tree (`.tex`, `.bib`, figures) edited at `/latex` and
compiled server-side. Outside the media grid — authored, not collected (D36).
_Avoid_: paper, tex file, document, notebook

**Draft**:
The live, editable state of a LaTeX project — reachable only from the editor and
**never** shown in the gallery. Deleting it leaves published documents untouched.
_Avoid_: working copy, unpublished, source

**Published document**:
The single library entry a LaTeX project produces. One entry per project however
often publish is pressed — repeat publishes add versions, never cards.
_Avoid_: export, output, final, artifact

**Version**:
One publish: its compiled PDF plus a zip of the whole project at that moment, so
it can be rebuilt. Selectable in the reader; the newest opens by default.
_Avoid_: revision, snapshot, release, build

## The engine

**Typesetting engine**:
Atrium's own TypeScript library (`packages/typeset`, brief 37, D38) that turns a
LaTeX project into a PDF. Ours, not TeX — it takes an in-memory file map and
returns bytes, with no filesystem, network, or shell. See `wiki/typeset.md`.
_Avoid_: the compiler, LaTeX, TeX, Tectonic, the renderer

**Supported subset**:
The exact set of LaTeX commands and environments the engine implements. The
scope line is **syntax, not semantics**: Atrium reads LaTeX-shaped documents, it
does not execute TeX. Anything outside it is a **diagnostic**, never a silent
skip.
_Avoid_: supported features, our LaTeX, the dialect, partial support

**Diagnostic**:
One structured problem from a compile — file, line, severity, message. Both a
real LaTeX error and "this engine does not implement `\foo`" are diagnostics;
the loud-failure contract (D38) means the second kind must always be produced.
_Avoid_: error, warning, log line, compile message
