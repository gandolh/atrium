import { getRouteApi } from "@tanstack/react-router";

import { LatexList } from "../latex/LatexList";
import { LatexEditor } from "../latex/LatexEditor";

const routeApi = getRouteApi("/latex");

/**
 * `/latex` (brief 38 chunk 7) — one route, two views keyed off the
 * `?project=<id>` search param, same pattern as `/notes`'s `?note=` and
 * `/read`'s `?book=`: the list when absent, the project view when present.
 * Keeps LaTeX a single destination in the nav, sibling to Notes (D33g / D36)
 * — outside the media grid, not a library filter.
 *
 * The project view is the editor itself — source pane, file tree, compile and
 * publish all live in `LatexEditor`.
 */
export function LatexRoute() {
  const { project } = routeApi.useSearch();
  return project ? <LatexEditor id={project} /> : <LatexList />;
}
