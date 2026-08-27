import { uploadCover } from "./library-api";

/**
 * Browser-side video cover capture (brief 42, D40). **The browser is the
 * decoder**: mp4/webm are accepted formats precisely because `<video>` plays
 * them (D12), so a frame can be lifted client-side and posted as the cover —
 * which is what keeps brief 23's declined-ffmpeg decision standing instead of
 * being revisited.
 *
 * Shared by BOTH capture sites D40 item 1 requires, because a capture that
 * only happens at upload leaves the existing library (and iOS) permanently
 * coverless:
 *
 * - **Upload** (`use-library.ts`'s `useUploadBook`): a local `File`, so
 *   `URL.createObjectURL` yields a **same-origin `blob:` URL** and the canvas
 *   is never tainted.
 * - **Playback backfill** (the video player): the item is served from the API
 *   on a *different* origin. Drawing a cross-origin video into a canvas taints
 *   it and `toBlob` then throws `SecurityError`, so that caller must pass
 *   `{ kind: "url", crossOrigin: "anonymous" }` — the API sets CORS
 *   `origin: true`, so a **dedicated** capture element with that attribute
 *   loads untainted. It must NOT set the attribute on the element that is
 *   already playing: `crossOrigin` only takes effect on a fresh load, so
 *   changing it mid-playback risks re-loading (and so interrupting) playback.
 *
 * **Everything here is best-effort, exactly like every server-side extractor.**
 * `captureVideoFrame` and `captureAndUploadVideoCover` never throw and never
 * reject: anything that will not decode yields `null` / an `attempted: true,
 * stored: false` outcome and the item keeps today's typographic tile. A capture
 * failure is never an upload failure and never a playback failure.
 */

/**
 * Where the capture element gets its bytes.
 *
 * `file` is the upload path (helper-owned `blob:` URL, revoked on every exit).
 * `url` is for a source the CALLER owns — the helper never revokes a URL it
 * did not create — and is the only variant that can be cross-origin, hence
 * `crossOrigin`.
 */
export type VideoCoverSource =
  | { kind: "file"; file: File }
  | {
      kind: "url";
      url: string;
      /**
       * Mirrors `HTMLMediaElement.crossOrigin`. Required (`"anonymous"`) for a
       * cross-origin URL, or the canvas is tainted and no frame can be read.
       * Omit for a same-origin / `blob:` URL — it has no effect there.
       */
      crossOrigin?: "anonymous" | "use-credentials";
    };

export interface CaptureVideoFrameOptions {
  /**
   * Candidate seek points as fractions of duration. Default 10% / 25% / 50%:
   * one fixed seek lands on a black fade-in or a title card often enough to
   * matter, and the best of three sampled frames wins (see `lumaVariance`).
   */
  fractions?: number[];
}

/** 10% / 25% / 50% (D40 / brief 42's "Capture at upload" bullet). */
const DEFAULT_FRACTIONS = [0.1, 0.25, 0.5];

/**
 * Longest edge of the JPEG we post. The server re-encodes everything through
 * sharp (`fit: "inside"`, 640 bound, q78) and stores THAT, so this is only
 * about not shipping a 4K frame over the wire — it is not a statement about
 * stored geometry, and our bytes are never stored verbatim.
 */
const MAX_EDGE = 640;

/** Above sharp's own q78 on purpose: the server re-encode is the lossy step that counts. */
const JPEG_QUALITY = 0.85;

const METADATA_TIMEOUT_MS = 15_000;
/** Ceiling on ONE wait inside the sampling loop, clamped further by what is left of the budget. */
const SEEK_TIMEOUT_MS = 8_000;
/**
 * Wall clock for the entire sampling phase — prime cycle, seeks, repaint beats
 * and encodes — measured from `loadedmetadata`.
 *
 * **Enforced, not advisory.** `seekTo` and `primeDecoder` each clamp their own
 * timeout to `deadline - now`, so no candidate can run past the deadline; only
 * the encode of a frame already in hand can, and that is milliseconds. The
 * element's whole lifetime is therefore bounded by METADATA_TIMEOUT_MS + this
 * (35s), which is also exactly how long the upload path's `blob:` URL can pin
 * the uploaded `File` — not the multiple of SEEK_TIMEOUT_MS an unclamped loop
 * would have allowed.
 */
const OVERALL_BUDGET_MS = 20_000;
/** One extra beat for a decoder that has not painted the seeked frame yet (see below). */
const REPAINT_WAIT_MS = 120;
/** Ceiling on the real playback the iOS prime cycle is allowed to burn. */
const PRIME_TIMEOUT_MS = 1_200;

/**
 * Luminance variance (0..255 scale) below which a frame is treated as "no
 * frame at all". A black fade-in, a solid-colour card, and — critically — a
 * canvas the decoder never actually painted into all land here, and posting
 * any of them would replace the typographic tile with a black rectangle, which
 * is strictly worse than falling back. sd 2 is far below any real scene.
 */
const MIN_LUMA_VARIANCE = 4;

/**
 * Capture a representative frame, or `null`.
 *
 * Samples `fractions` of the duration, scores each drawn frame by luminance
 * variance, and returns the highest-scoring one as a JPEG `Blob`. Variance is
 * the cheap proxy for "this frame has content in it" — a fade-in or a title
 * card scores near zero, a real scene does not.
 *
 * **Never throws.** Every failure mode — undecodable container, a tainted
 * canvas, a stalled seek, a decoder that paints nothing — resolves `null`.
 */
export async function captureVideoFrame(
  source: VideoCoverSource,
  options?: CaptureVideoFrameOptions,
): Promise<Blob | null> {
  // Created here only for the `file` variant, and revoked in `finally` on
  // EVERY path including the failures: a leaked object URL pins the entire
  // video file in memory for the life of the document.
  let objectUrl: string | null = null;
  // Never appended to the DOM — an unparented element still decodes, and a
  // detached one cannot be seen, styled, or interacted with, so there is
  // nothing to clean up in the tree either.
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");

  try {
    video.muted = true; // also what makes the play() cycle below permissible
    video.playsInline = true; // iOS: without this a play() attempt goes fullscreen
    // `auto` only for `file`, where the bytes are already local and buffering
    // ahead is free. On the `url` variant this element points at the SAME URL
    // the user is streaming (that variant IS the playback backfill), and `auto`
    // there opens a second full-speed download competing with playback for the
    // connection — a rebuffer stall in the first seconds that the user would
    // read as the video being broken. `metadata` still yields `duration` /
    // `videoWidth`, and the seeks below fetch only the ranges they land on.
    video.preload = source.kind === "file" ? "auto" : "metadata";

    // `src` last, and `crossOrigin` strictly before it: the CORS mode is baked
    // in when the load starts, so setting it afterwards would either do
    // nothing or force a second load.
    if (source.kind === "file") {
      objectUrl = URL.createObjectURL(source.file);
      video.src = objectUrl;
    } else {
      if (source.crossOrigin) video.crossOrigin = source.crossOrigin;
      video.src = source.url;
    }

    // `loadedmetadata` is the first point `duration` / `videoWidth` exist. An
    // `error` on the element rejects this (and every wait below), which is how
    // an undecodable container becomes a clean `null` rather than a hang.
    if (video.readyState < HAVE_METADATA) {
      await waitForEvent(video, "loadedmetadata", METADATA_TIMEOUT_MS);
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    // An audio-only or metadata-less stream has no frame to give.
    if (!width || !height) return null;

    // Everything below is inside the sampling budget, the prime cycle included,
    // and every wait below clamps itself against this (see `OVERALL_BUDGET_MS`).
    const deadline = Date.now() + OVERALL_BUDGET_MS;

    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    // `willReadFrequently`: we getImageData once per candidate, so ask for a
    // readback-friendly (software) surface instead of paying a GPU stall each time.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    /**
     * Draw whatever frame the element currently holds and score it.
     *
     * `getImageData` throws `SecurityError` on a tainted canvas (cross-origin
     * source with no usable CORS grant). That is not per-candidate bad luck, it
     * is terminal for this source, so it is left to propagate out of the loop.
     */
    const drawAndScore = (): number => {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return lumaVariance(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
    };

    let best: Blob | null = null;
    let bestScore = -1;
    // The iOS prime cycle is paid at most once per capture, and only once a
    // draw has actually come back blank — see the third branch below.
    let primed = false;

    for (const time of candidateTimes(video.duration, options?.fractions ?? DEFAULT_FRACTIONS)) {
      // A frame in hand beats a better frame that arrives too late; with none
      // in hand there is nothing to lose by stopping either.
      if (Date.now() > deadline) break;
      try {
        await seekTo(video, time, deadline);
        let score = drawAndScore();
        if (score < MIN_LUMA_VARIANCE) {
          // Either a genuinely blank frame, or a decoder that had not yet
          // propagated the seeked frame when we drew. One repaint beat tells
          // the two apart, and costs nothing on the frames that already scored.
          await nextFrame(video);
          score = drawAndScore();
        }
        if (score < MIN_LUMA_VARIANCE && !primed) {
          // Still nothing. The remaining explanation is the iOS one: mobile
          // Safari has historically refused to paint at all from a video that
          // has never played, and a muted + playsInline play()/pause() cycle is
          // the known mitigation (D40 item 1's whole reason for existing).
          //
          // Deliberately LAZY rather than unconditional: on the `url` variant
          // the prime competes with the element the user is watching, so a
          // browser that paints from a seek alone — every desktop engine — must
          // never pay for it. A device that needs it fails the two draws above
          // first, which is the signal, and then pays once per capture.
          //
          // play() moved the playhead, so re-seek to the candidate before
          // drawing. Both calls clamp to `deadline`, so this cannot escape the
          // budget; if it exhausts it, the loop's guard stops the next candidate.
          primed = true;
          await primeDecoder(video, deadline);
          await seekTo(video, time, deadline);
          await nextFrame(video);
          score = drawAndScore();
        }
        if (score <= bestScore || score < MIN_LUMA_VARIANCE) continue;
        // Encode on improvement rather than remembering timestamps and
        // re-seeking the winner at the end: at most three cheap encodes of a
        // 640px frame, and no seek is ever paid for twice.
        const blob = await canvasToJpeg(canvas);
        // A null blob is a tainted canvas (`toBlob` throws where `getImageData`
        // somehow did not) or an allocation failure — neither improves on the
        // next candidate, so stop and keep whatever earlier frame we hold.
        if (!blob) return best;
        best = blob;
        bestScore = score;
      } catch (err) {
        if (isSecurityError(err)) return null;
        // A single bad seek (a sparse keyframe near the end, a truncated
        // moov) does not condemn the other candidates.
      }
    }

    return best;
  } catch {
    return null;
  } finally {
    // Order matters: stop the element referencing the resource BEFORE revoking
    // the URL, so the revoke actually releases the file rather than racing a
    // still-loading decoder.
    try {
      video.pause();
    } catch {
      /* pause() on a never-started element is harmless either way */
    }
    video.removeAttribute("src");
    try {
      video.load(); // resets to the empty state and frees the decoder + buffers
    } catch {
      /* best-effort teardown; nothing above depends on it */
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    // Drop the backing store rather than waiting for GC to notice a canvas
    // that is holding width*height*4 bytes.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Per-id capture bookkeeping for this page session, which is what makes this
 * function self-guarding for BOTH call sites (see below). Not persisted: after
 * a reload `hasCover` is authoritative again, so a fresh attempt is correct.
 *
 * `inFlight` is a *decline*, never an attempt: nothing is created, nothing is
 * sampled, and `attempts` is untouched — which is why the outcome below has to
 * say so, and why a decline must not cost a caller its one-shot.
 */
const inFlight = new Set<string>();
const attempts = new Map<string, number>();
/**
 * Two, so that a **failed** upload-time capture still leaves the playback
 * backfill one shot at the same item in the same session — that is exactly
 * D40 item 1's iOS mitigation, and a permanent claim on first failure would
 * silently disable it. Bounded so a video that simply cannot be captured
 * cannot burn a capture pass on every `play` event forever.
 */
const MAX_ATTEMPTS_PER_SESSION = 2;

/**
 * The outcome of a `captureAndUploadVideoCover` call.
 *
 * `stored` alone is not enough for a caller holding a one-shot: a bare `false`
 * conflates "we tried and it did not work" with "we declined and tried
 * nothing", and a caller that spends its only attempt on the latter silently
 * disables itself (which is precisely how the playback backfill — D40 item 1's
 * iOS mitigation — used to be defeated by an upload-time capture still in
 * flight when the user pressed play).
 */
export interface VideoCoverCaptureOutcome {
  /**
   * Whether a capture element was actually created and sampled. `false` means a
   * guard declined before touching the decoder or the network, and — this is
   * the load-bearing part — **without spending an attempt from the budget**.
   */
  attempted: boolean;
  /** True only when a cover actually reached the server. Implies `attempted`. */
  stored: boolean;
  /** Which guard declined. Absent whenever `attempted` is true. */
  declined?: "in-flight" | "attempts-spent";
}

/**
 * Capture a frame and POST it as `bookId`'s cover.
 *
 * **Never throws and never rejects** — a rejected capture must never surface
 * as an upload or playback failure — so a caller can `void` this without a
 * `.catch()` and without risking an unhandled rejection.
 *
 * **Self-guarding**, and the outcome names the guard, because to a caller with
 * one attempt to spend the two declines are not the same event as a failure:
 *
 * - `{ attempted: false, declined: "in-flight" }` — a capture for this id is
 *   already running; typically the upload-time one, while the user clicks
 *   straight through to the player (the card is on screen before the capture
 *   finishes, by design). Nothing was tried and no budget was spent, so a
 *   caller must NOT count this as its attempt: the running capture can still
 *   fail, and covering that failure is the backfill's entire job.
 * - `{ attempted: false, declined: "attempts-spent" }` — this id has used its
 *   `MAX_ATTEMPTS_PER_SESSION`, or a capture already succeeded this session.
 *   Nothing but a reload will change that, so a caller may stop asking.
 * - `{ attempted: true, stored }` — an element was created and sampled;
 *   `stored` says whether a cover reached the server.
 *
 * Callers should still gate on `!hasCover` (D40 item 2) — that is the durable
 * guard, this only closes the window before the library query refetches.
 */
export async function captureAndUploadVideoCover(
  bookId: string,
  source: VideoCoverSource,
  options?: CaptureVideoFrameOptions,
): Promise<VideoCoverCaptureOutcome> {
  if (inFlight.has(bookId)) return { attempted: false, stored: false, declined: "in-flight" };
  const priorAttempts = attempts.get(bookId) ?? 0;
  if (priorAttempts >= MAX_ATTEMPTS_PER_SESSION) {
    return { attempted: false, stored: false, declined: "attempts-spent" };
  }
  inFlight.add(bookId);
  attempts.set(bookId, priorAttempts + 1);
  try {
    const frame = await captureVideoFrame(source, options);
    if (!frame) return { attempted: true, stored: false };
    await uploadCover(bookId, frame);
    // Success is permanent: nothing should capture this item again until a
    // reload, where `hasCover` will be true anyway.
    attempts.set(bookId, MAX_ATTEMPTS_PER_SESSION);
    return { attempted: true, stored: true };
  } catch {
    // Includes the POST's own failures: a 400 (bytes sharp could not decode),
    // a 413, a 404 for an item deleted while we were sampling, or offline.
    // Last-write-wins at the route means a retry is always safe, so there is
    // nothing to unwind and nothing to tell the user about. Still `attempted`:
    // the budget was spent and a caller's one-shot is legitimately gone.
    return { attempted: true, stored: false };
  } finally {
    inFlight.delete(bookId);
  }
}

// --- internals -------------------------------------------------------------

/** `HTMLMediaElement.HAVE_METADATA` / `HAVE_CURRENT_DATA` without needing an instance. */
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;

/**
 * Resolve on `event`, reject on the element's `error` or after `timeoutMs`.
 * A timeout (rather than an unbounded wait) is what stops a stalled network or
 * a decoder that never fires `seeked` from leaving the element — and, for the
 * upload path, the whole video file — alive indefinitely.
 */
function waitForEvent(video: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ac = new AbortController();
    let timer = 0;
    const settle = (fn: () => void) => {
      ac.abort(); // detaches BOTH listeners below in one go
      window.clearTimeout(timer);
      fn();
    };
    timer = window.setTimeout(
      () => settle(() => reject(new Error(`video-cover: timed out waiting for ${event}`))),
      timeoutMs,
    );
    video.addEventListener(event, () => settle(resolve), { signal: ac.signal });
    video.addEventListener(
      "error",
      () => settle(() => reject(new Error(`video-cover: media error waiting for ${event}`))),
      { signal: ac.signal },
    );
  });
}

/**
 * The iOS "paint something first" cycle. Bounded and swallowed: a refused
 * autoplay, a stall, or a browser that needs none of this must all fall
 * through to the seeks.
 *
 * Called **only after a draw has come back blank**, never up front: on the
 * `url` variant this is real playback of the very stream the user is watching,
 * so it is a cost only the devices that actually need it should pay. `deadline`
 * caps it against what is left of the sampling budget on top of
 * `PRIME_TIMEOUT_MS`, so a slow start cannot eat the remaining candidates.
 */
async function primeDecoder(video: HTMLVideoElement, deadline: number): Promise<void> {
  const budget = Math.min(PRIME_TIMEOUT_MS, deadline - Date.now());
  if (budget <= 0) return;
  try {
    const started = video.play();
    if (!started) return; // older signature, nothing to await
    await Promise.race([started, sleep(budget)]);
  } catch {
    /* autoplay refused — expected on some policies, and not fatal */
  } finally {
    try {
      video.pause();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Candidate seek points, in seconds, deduplicated (a very short clip can map
 * several fractions onto the same frame) and pulled just inside the end so a
 * fraction of a rounded duration cannot land past the last frame.
 *
 * A non-finite duration (a stream, or a container that exposes none) leaves
 * only `[0]`: no fraction of `Infinity` means anything, but the first frame is
 * still worth one attempt.
 */
function candidateTimes(duration: number, fractions: number[]): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const last = Math.max(0, duration - 0.05);
  const seen = new Set<number>();
  const times: number[] = [];
  for (const fraction of fractions) {
    const time = Math.round(Math.min(Math.max(fraction * duration, 0), last) * 1000) / 1000;
    if (seen.has(time)) continue;
    seen.add(time);
    times.push(time);
  }
  return times.length ? times : [0];
}

/**
 * Seek and wait for the frame to be available. Rejects on error/timeout.
 *
 * Every wait is clamped to whatever is left of `deadline` as well as to
 * SEEK_TIMEOUT_MS, which is what makes `OVERALL_BUDGET_MS` a real bound
 * instead of an advisory one: without it a single candidate could burn two
 * full seek timeouts, and the loop's pre-flight deadline check only ever
 * stopped the NEXT candidate from starting.
 */
async function seekTo(video: HTMLVideoElement, time: number, deadline: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.001) {
    // Assigning the current time fires no `seeked`, so waiting for one here
    // would always time out. Wait for data instead (this is the t=0 path).
    if (video.readyState >= HAVE_CURRENT_DATA) return;
    // `loadeddata` is right here and only here: this is genuinely the FIRST
    // arrival at HAVE_CURRENT_DATA for this load, which is the only time the
    // ready-state algorithm queues that event.
    await waitForEvent(video, "loadeddata", seekBudget(deadline));
    return;
  }
  // Listener attached before the assignment — a cached seek can complete
  // synchronously enough that a listener added afterwards misses the event.
  const seeked = waitForEvent(video, "seeked", seekBudget(deadline));
  try {
    video.currentTime = time;
  } catch (err) {
    // `currentTime` writes are wrapped here for the same reason they are in
    // `use-playback-element.ts` and `use-media-progress.ts`: the setter can
    // throw. The extra beat this file needs is the orphan — the wait above is
    // already live with nothing awaiting it, and would reject into nobody's
    // hands (an unhandled rejection) once its timer expires.
    void seeked.catch(() => {});
    throw err;
  }
  await seeked;
  if (video.readyState < HAVE_CURRENT_DATA) {
    // NOT `loadeddata`: it fires at most once per load, and a `seeked` having
    // already fired means it has necessarily fired too, so waiting for it here
    // could only ever time out. `canplay` is the event that fires on a
    // RE-entry to HAVE_CURRENT_DATA, which is what this branch is waiting on.
    // (Per spec a decoder should not report HAVE_METADATA at `seeked` at all,
    // so this is a belt-and-braces path either way.)
    await waitForEvent(video, "canplay", seekBudget(deadline));
  }
}

/**
 * What one wait inside the sampling loop may spend: the smaller of its own
 * ceiling and whatever is left of the phase budget.
 */
function seekBudget(deadline: number): number {
  return Math.max(0, Math.min(SEEK_TIMEOUT_MS, deadline - Date.now()));
}

/**
 * Wait one beat for the decoder to propagate a frame, capped.
 *
 * `requestVideoFrameCallback` is tried where it exists, but **it is not the
 * expected winner here**: rVFC fires when a frame is *presented to the
 * compositor*, and this element is deliberately never parented (see
 * `captureVideoFrame`), so it composites nothing and the callback normally
 * never comes at all. `sleep(REPAINT_WAIT_MS)` is the path that actually
 * settles the race, and that is the designed behaviour — the rVFC arm is kept
 * only because a browser that drives it off the media pipeline rather than the
 * compositor would let us proceed sooner, and losing the race costs nothing.
 */
/** `requestVideoFrameCallback` isn't in every TS DOM lib, and isn't in every browser. */
interface RvfcCapable {
  requestVideoFrameCallback: (callback: () => void) => number;
}
function nextFrame(video: HTMLVideoElement): Promise<void> {
  const request = (video as HTMLVideoElement & Partial<RvfcCapable>).requestVideoFrameCallback;
  if (typeof request !== "function") return sleep(REPAINT_WAIT_MS);
  return Promise.race([
    new Promise<void>((resolve) => request.call(video, () => resolve())),
    sleep(REPAINT_WAIT_MS),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Variance of perceived luminance over the frame — the "does this frame have
 * content in it" score. Strided 4 pixels at a time: at 640px a quarter of the
 * pixels is a statistically indistinguishable estimate for a quarter of the work.
 */
function lumaVariance(data: Uint8ClampedArray): number {
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i + 2 < data.length; i += 16) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += luma;
    sumSquares += luma * luma;
    count += 1;
  }
  if (!count) return 0;
  const mean = sum / count;
  // Clamped: floating-point cancellation can push a perfectly uniform frame
  // marginally below zero, which would read as "worse than blank".
  return Math.max(0, sumSquares / count - mean * mean);
}

/** Promisified `toBlob`, resolving `null` instead of throwing on a tainted canvas. */
function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", JPEG_QUALITY);
    } catch {
      resolve(null);
    }
  });
}

/**
 * A tainted-canvas read. Matched by `name`, not `instanceof DOMException`:
 * the class is the same everywhere but the codes are legacy, and `name` is the
 * part the spec actually pins.
 */
function isSecurityError(err: unknown): boolean {
  return err instanceof Error && err.name === "SecurityError";
}
