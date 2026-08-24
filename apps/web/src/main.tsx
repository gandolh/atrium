import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { queryClient } from "./lib/query-client";
import { router } from "./router";

// Self-hosted fonts (wiki/design.md "Reading Room", D33 — no Google CDN, D14).
// Two families, not three: Newsreader for anything a person wrote (the page
// greeting, section heads, the reading pane) and Archivo for anything the
// interface says (card titles, nav, chips, figures). Playfair Display, Source
// Serif 4 and Inter retired with Quiet Gallery.
//
// Only the latin + latin-ext subsets are imported (per-subset entrypoints, not
// the full family CSS) — this app is English-first, so the cyrillic/greek/
// vietnamese subsets @fontsource ships per weight are unnecessary payload and
// are intentionally skipped.
import "@fontsource/newsreader/latin-400.css";
import "@fontsource/newsreader/latin-ext-400.css";
import "@fontsource/newsreader/latin-400-italic.css";
import "@fontsource/newsreader/latin-ext-400-italic.css";
import "@fontsource/newsreader/latin-500.css";
import "@fontsource/newsreader/latin-ext-500.css";
import "@fontsource/newsreader/latin-600.css";
import "@fontsource/newsreader/latin-ext-600.css";
import "@fontsource/archivo/latin-500.css";
import "@fontsource/archivo/latin-ext-500.css";
import "@fontsource/archivo/latin-600.css";
import "@fontsource/archivo/latin-ext-600.css";
import "@fontsource/archivo/latin-700.css";
import "@fontsource/archivo/latin-ext-700.css";
import "./styles/globals.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
