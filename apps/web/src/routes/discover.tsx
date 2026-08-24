import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { CatalogSearchResponse } from "@ebook-reader/shared";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { useLibrary } from "../lib/use-library";
import { AppHeader } from "../components/AppHeader";
import { QuietSelect } from "../components/QuietSelect";
import { CatalogResultCard } from "../discover/CatalogResultCard";
import { useCatalogSearch } from "../discover/use-catalog";
import { CATALOG_LANGUAGES, CATALOG_TOPICS, DEFAULT_CATALOG_LANGUAGE } from "../discover/catalog-filters";

const routeApi = getRouteApi("/discover");

/**
 * `/discover` — browse and import books from Project Gutenberg (brief 22,
 * chunk 22b). A **utility surface** (wiki/design.md D27, design principle 5):
 * plain and efficient, no hero, no decoration — the polish budget stays on
 * the reader.
 *
 * The URL search params (`q`, `topic`, `lang`, `page`) are the single source
 * of truth the catalog query reads, so a search deep-links and survives a
 * refresh. The search box debounces ~300ms before it writes to `q`; topic and
 * language are plain selects that write immediately. Paging is a "More"
 * button that swaps `page` — no infinite scroll.
 *
 * The "In library" badge cross-references the already-fetched library list
 * (`useLibrary`, the same query/key `routes/home.tsx` reads) against each
 * result's Gutenberg id, per `LibraryBook.sourceId`. The import mutation
 * (`useCatalogSearch`'s sibling `useImportBook`, instantiated per-card in
 * `CatalogResultCard`) invalidates that same `["library"]` key so the badge
 * and the gallery both pick up a fresh import without a manual refetch.
 */
export function Discover() {
  // Same shared theme mechanism as the library home, so a direct visit to
  // /discover (deep link, refresh) still lands in the user's chosen theme.
  useApplyTheme();

  const navigate = useNavigate();
  const search = routeApi.useSearch();

  const q = search.q ?? "";
  const topic = search.topic ?? "";
  const lang = search.lang ?? DEFAULT_CATALOG_LANGUAGE;
  const page = search.page ?? 1;

  const [searchInput, setSearchInput] = useState(q);

  // Keep the box in sync when the URL's `q` changes from elsewhere (back/
  // forward navigation, a topic pick, etc) rather than only ever writing.
  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  // Debounce (~300ms) before writing to the URL — the URL stays the source of
  // truth the catalog query below reads, so typing never itself triggers a
  // fetch per keystroke.
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === q) return;
    const id = setTimeout(() => {
      void navigate({
        to: "/discover",
        search: (prev) => ({ ...prev, q: trimmed || undefined, page: undefined }),
        replace: true,
      });
    }, 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  function setTopic(next: string) {
    void navigate({
      to: "/discover",
      search: (prev) => ({ ...prev, topic: next || undefined, page: undefined }),
    });
  }

  function setLang(next: string) {
    void navigate({
      to: "/discover",
      search: (prev) => ({
        ...prev,
        lang: next === DEFAULT_CATALOG_LANGUAGE ? undefined : next,
        page: undefined,
      }),
    });
  }

  function goToPage(next: number) {
    void navigate({
      to: "/discover",
      search: (prev) => ({ ...prev, page: next === 1 ? undefined : next }),
    });
  }

  const catalog = useCatalogSearch({
    q: q || undefined,
    topic: topic || undefined,
    languages: lang,
    page,
  });

  // Reuse the library home's own query/key (lib/use-library.ts `useLibrary`) so
  // the badge cross-reference shares its cache instead of a second fetch, and
  // the import mutation's `["library"]` invalidation reaches it too.
  const library = useLibrary("recent");
  const inLibraryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const book of library.data ?? []) {
      if (book.source === "gutenberg" && book.sourceId) ids.add(book.sourceId);
    }
    return ids;
  }, [library.data]);

  const isLanding = !q && !topic && lang === DEFAULT_CATALOG_LANGUAGE && page === 1;
  const heading = isLanding ? "Popular on Project Gutenberg" : "Catalog results";

  return (
    <main className="mx-auto flex min-h-[calc(100vh-var(--dock-height,0px))] max-w-6xl flex-col gap-8 px-5 py-8 text-ink md:px-16">
      {/* The shared app shell (wordmark home link + theme toggle) persists here
          — /discover used to drop it entirely, stranding the user without nav
          or the theme control. */}
      <AppHeader
        actions={
          <Link
            to="/"
            className="rounded border border-line-soft/70 px-4 py-2 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            ‹ Back to library
          </Link>
        }
      />

      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-semibold text-ink">Discover</h1>
        <p className="text-sm text-ink-variant">Browse and import books from Project Gutenberg.</p>
      </header>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        {/* Explicit submit alongside the debounced live search: Enter or the
            button commits the query immediately (the debounce effect's
            `trimmed === q` guard keeps its later tick a no-op). */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = searchInput.trim();
            void navigate({
              to: "/discover",
              search: (prev) => ({ ...prev, q: trimmed || undefined, page: undefined }),
            });
          }}
          className="flex flex-1 items-end gap-3 sm:max-w-md"
        >
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="font-ui text-xs font-semibold tracking-[0.08em] text-ink-variant uppercase">
              Search
            </span>
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Title or author…"
              className="border-b border-line-soft bg-transparent px-1 py-1.5 font-ui text-sm text-ink outline-none transition hover:border-line focus:border-b-2 focus:border-accent"
            />
          </label>
          <button
            type="submit"
            className="rounded border border-line-soft px-4 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            Search
          </button>
        </form>

        <div className="flex flex-wrap items-end gap-4">
          <QuietSelect
            stacked
            label="Topic"
            value={topic}
            onChange={setTopic}
            options={[
              { value: "", label: "All topics" },
              ...CATALOG_TOPICS.map((t) => ({ value: t, label: t })),
            ]}
          />
          <QuietSelect
            stacked
            label="Language"
            value={lang}
            onChange={setLang}
            options={CATALOG_LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
          />
        </div>
      </div>

      <section aria-label="Catalog results" className="flex flex-col gap-5">
        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-2xl font-semibold text-ink">{heading}</h2>
          {/* Gutendex round-trips can take several seconds; without a signal the
              held-over previous results read as "search is broken". */}
          {catalog.isFetching && !catalog.isLoading && (
            <span role="status" className="font-ui text-sm text-ink-variant motion-safe:animate-pulse">
              Searching…
            </span>
          )}
        </div>

        {catalog.isLoading ? (
          <CatalogSkeleton />
        ) : catalog.isError ? (
          <ErrorState
            title="Couldn't reach Project Gutenberg"
            body="The catalog may be temporarily unavailable. Please try again."
            onRetry={() => catalog.refetch()}
          />
        ) : catalog.data ? (
          <CatalogResults
            data={catalog.data}
            page={page}
            inLibraryIds={inLibraryIds}
            onMore={goToPage}
            loadingMore={catalog.isFetching}
          />
        ) : null}
      </section>
    </main>
  );
}

function CatalogResults({
  data,
  page,
  inLibraryIds,
  onMore,
  loadingMore,
}: {
  data: CatalogSearchResponse;
  page: number;
  inLibraryIds: Set<string>;
  onMore: (page: number) => void;
  /** True while a page/filter change is refetching — `keepPreviousData` keeps the
   *  prior results on screen (no infinite-scroll flash), so the "More" button is
   *  the only place that needs to say "this is still working". */
  loadingMore: boolean;
}) {
  if (data.results.length === 0) {
    return <p className="text-ink-variant">No results. Try a different search or filter.</p>;
  }

  const nextPage = data.nextPage;

  return (
    <>
      {/* Dim the held-over results while a new query is in flight so the page
          visibly reacts to a search (Gutendex can take seconds). */}
      <div
        className={`grid grid-cols-2 gap-x-6 gap-y-8 transition-opacity sm:grid-cols-3 lg:grid-cols-5 ${
          loadingMore ? "opacity-50" : ""
        }`}
      >
        {data.results.map((book) => (
          <CatalogResultCard
            key={`${book.id}-${page}`}
            book={book}
            inLibrary={inLibraryIds.has(String(book.id))}
          />
        ))}
      </div>

      {nextPage !== null && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => onMore(nextPage)}
            className="rounded border border-line-soft px-5 py-2 font-ui text-sm font-medium text-ink-variant transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
          >
            {loadingMore ? "Loading…" : "More"}
          </button>
        </div>
      )}
    </>
  );
}

function ErrorState({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-line-soft/50 bg-paper-low/40 px-6 py-16 text-center">
      <p className="font-display text-xl font-semibold text-ink">{title}</p>
      <p className="max-w-md text-ink-variant">{body}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-line-soft px-4 py-1.5 text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        Try again
      </button>
    </div>
  );
}

function CatalogSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-5" aria-hidden>
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3">
          <div className="aspect-[2/3] w-full motion-safe:animate-pulse rounded-(--radius-cover) bg-paper-container" />
          <div className="h-4 w-3/4 motion-safe:animate-pulse rounded bg-paper-container" />
          <div className="h-3 w-1/2 motion-safe:animate-pulse rounded bg-paper-container" />
        </div>
      ))}
    </div>
  );
}
