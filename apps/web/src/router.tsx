import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { fileTypeSchema, mediaKindSchema } from "@ebook-reader/shared";

import { RootLayout } from "./routes/root-layout";
import { LibraryHome } from "./library/LibraryHome";
import { Read } from "./routes/read";
import { Discover } from "./routes/discover";
import { Notes } from "./routes/notes";
import { ManageProfiles } from "./profiles/ManageProfiles";

/**
 * Code-based route tree (no file-based plugin — keeps the shell dependency-
 * light; see brief 04). Two routes for now: `/` (home/upload) and `/read`
 * (reader shell). Both later briefs (05 uploader, 06/07 readers) extend
 * these components, not this tree shape.
 */
const rootRoute = createRootRoute({
  component: RootLayout,
});

// `/` is **the** home (brief 28, D33 move 1): one gallery of the whole
// library, with media kind demoted from an address to a filter chip. `?kind`
// carries that filter so Back / refresh / share round-trip; absent = all kinds.
// Validated against the shared `mediaKindSchema`, so a hand-typed `?kind=junk`
// falls back to "all" rather than rendering an empty grid.
const homeSearchSchema = z.object({
  kind: mediaKindSchema.optional().catch(undefined),
  // Cross-library search text (brief 30), so Back / refresh / share round-trip
  // it the same way `?kind` already does. One-line schema addition — brief 30's
  // file lane excludes this file, but the field has to live somewhere.
  q: z.string().optional().catch(undefined),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: homeSearchSchema,
  component: LibraryHome,
});

// The brief-25 per-type areas survive as **redirects**, not deletions. Real
// users have `/books` bookmarked, in browser history, and — because a PWA's
// `start_url` is whatever page was open at install time — baked into the
// installed app's launch URL. Each maps onto the equivalent home filter.
const AREA_REDIRECTS = [
  { path: "/books", kind: "book" },
  { path: "/music", kind: "audio" },
  { path: "/videos", kind: "video" },
] as const;

const [booksRoute, musicRoute, videosRoute] = AREA_REDIRECTS.map((area) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: area.path,
    beforeLoad: () => {
      throw redirect({ to: "/", search: { kind: area.kind } });
    },
  }),
);

// `/notes` (brief 26) — one route, two views: the list, or the editor when
// `?note=<id>` is present (mirrors `/read?book=`).
const notesSearchSchema = z.object({
  note: z.string().optional(),
});

const notesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notes",
  validateSearch: notesSearchSchema,
  component: Notes,
});

// `format` is optional + type-safe (validated against the shared Zod enum) so
// `/read` can be deep-linked. Widened from the pdf/epub `formatSchema` to the
// full `fileTypeSchema` (pdf/epub/mp3/mp4/webm) in brief 23 so media formats
// pass validation and `/read` can branch by kind to the audio/video players.
const readSearchSchema = z.object({
  format: fileTypeSchema.optional(),
  // The library book id being read (D24). Encoded in the URL so a refresh /
  // direct visit can re-fetch the file from the library instead of losing it
  // (the `File` itself lives only in memory). Absent for dev-sample loads.
  book: z.string().optional(),
  // Dev-only, opt-in flag: when `?dev=1` and running the dev server, `/read`
  // loads a bundled sample PDF so the reader is testable without the uploader
  // (brief 06). Gated by `import.meta.env.DEV` — no effect in production.
  dev: z.coerce.boolean().optional(),
});

const readRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/read",
  validateSearch: readSearchSchema,
  component: Read,
});

// `/discover` (brief 22b) — browse + import Project Gutenberg books. Copies the
// `homeSearchSchema`/`readSearchSchema` pattern: a Zod-validated search schema
// so the search box, topic, language, and page all deep-link and survive a
// refresh (the URL is the source of truth the catalog query reads).
const discoverSearchSchema = z.object({
  q: z.string().optional(),
  topic: z.string().optional(),
  lang: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
});

const discoverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/discover",
  validateSearch: discoverSearchSchema,
  component: Discover,
});

// `/profiles` (brief 35 Part C) — the manage screen reached from the header
// switcher's "Manage profiles" entry. No search params: it always shows the
// account's whole profile list, there's nothing to deep-link into.
const profilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profiles",
  component: ManageProfiles,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  booksRoute,
  musicRoute,
  videosRoute,
  notesRoute,
  readRoute,
  discoverRoute,
  profilesRoute,
]);

// `basepath` matches Vite's `base` (import.meta.env.BASE_URL) so client-side
// routing stays under the deploy sub-path (e.g. /ebook-reader/). It's "/" in dev,
// which TanStack treats as no prefix.
export const router = createRouter({
  routeTree,
  basepath: import.meta.env.BASE_URL,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
