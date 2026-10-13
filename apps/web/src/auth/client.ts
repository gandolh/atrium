import { configureAuth } from "../../vendor/ward/ward-auth-react.js";
import { apiUrl } from "../lib/api-client";

/**
 * The one auth client (D58): Ward's vendored hooks, pointed at the library's
 * routes under atrium's API prefix (`/atrium-api/auth/...`).
 *
 * Imported by `main.tsx` **before the router**, and that order matters.
 * Creating the client reads `?ward_error=` / `?ward=` off the address bar (the
 * outcome of a Ward round trip) and replaces the URL without them. Done after
 * the router had read the location, the router would hold the old URL with
 * the code still in it.
 *
 * Built through `apiUrl()` like every other API URL, so the deploy's prefix
 * and the dev server's proxy apply here too. Every hook reads this one shared
 * session state; nothing here renders.
 */
export const authClient = configureAuth({ basePath: apiUrl("/auth").toString() });
