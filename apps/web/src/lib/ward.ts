/**
 * Where atrium sends somebody who needs to sign in.
 *
 * Atrium has no login screen. Ward serves the estate's single login page at
 * `/ward/login`, and every app hands over by navigating there with a `?next=`
 * saying where to come back to.
 *
 * ## `next` is a path, never an absolute URL
 *
 * Ward validates `next` against an allowlist of the estate's own path roots and
 * refuses anything absolute — including the estate's own origin spelled out in
 * full, because accepting one absolute host is how a later edit accepts two.
 * Sending a bare path is not a courtesy to that check; it is the only form that
 * works.
 */

/** Atrium's root on the shared origin. Where Ward sends people back to. */
const ATRIUM_ROOT = "/atrium/";

/**
 * The URL of Ward's login page, returning to `next` afterwards.
 *
 * Defaults to atrium's root rather than the current location. Deep-linking back
 * into a reader position would be nicer, but the current URL can carry a book
 * id the person no longer has access to, and landing them on a 404 immediately
 * after a successful sign-in reads as the sign-in having failed.
 */
export function wardLoginUrl(next: string = ATRIUM_ROOT): string {
  return `/ward/login?next=${encodeURIComponent(next)}`;
}

/**
 * Send the browser to Ward's login page.
 *
 * `location.assign`, not `replace`: a person who arrived on a deep link and
 * bounced to login should still be able to go Back to where they were, rather
 * than having that step silently removed from their history.
 */
export function goToWardLogin(next?: string): void {
  window.location.assign(wardLoginUrl(next));
}
