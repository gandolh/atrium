import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";

/**
 * Single QueryClient for the app. No queries live here yet — the convert
 * `useMutation` (wrapping `POST /convert`) lands in brief 05. This just
 * provides the client so `QueryClientProvider` can wrap the router.
 *
 * One coupling worth knowing at the definition site: `lib/auth.ts` calls
 * `queryClient.clear()` on every profile switch and on the 401 re-lock (brief
 * 35 step 7), because library rows and notes are profile-scoped data. Nothing
 * cached here may outlive a switch — so if a persister is ever added below, it
 * must hydrate per profile or it will hand one person's Continue row to the
 * next. The query keys carry the active profile id for the same reason.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // v5 defaults to 3 retries w/ exponential backoff. A 401 means the
      // guard re-locked the app (bad/missing token) — it won't heal by
      // retrying, and each retry re-fires the global re-lock handler and
      // hammers the auth guard. Skip retries for 401s; cap everything else.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status === 401) return false;
        return failureCount < 2;
      },
    },
  },
});
