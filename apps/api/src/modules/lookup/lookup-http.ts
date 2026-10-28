/**
 * The outbound half of the metadata lookup (brief 100): how the API talks to
 * MusicBrainz, the Cover Art Archive and Open Library. Shaped after the
 * Gutendex client (`catalog/gutendex.service.ts`): `fetch` with a timeout and
 * a descriptive `User-Agent`, an error thrown on anything but a 2xx.
 *
 * What a source sees from Atrium is the search terms, the ids of the covers
 * asked for, this User-Agent and the server's IP. Never the browser's: the
 * dialog's thumbnails come through `GET /lookup/covers/...` too.
 */

/**
 * Names Atrium and a contact, which MusicBrainz asks of every client
 * (`Application/version ( contact )`) and Open Library asks of frequent ones.
 * The contact is the repository's URL rather than an email address.
 */
export const LOOKUP_USER_AGENT = "Atrium/0.1 ( https://github.com/gandolh/atrium )";

/** A search that takes longer than this is "couldn't reach", not a hung dialog. */
export const SEARCH_TIMEOUT_MS = 10_000;
/** Covers redirect (the Cover Art Archive to archive.org), so a little longer. */
export const COVER_TIMEOUT_MS = 15_000;
/** A cover is a JPEG of a few hundred KB; anything past this is not one we want. */
export const MAX_COVER_BYTES = 8 * 1024 * 1024;

/** GET a JSON document. Throws on a network error, a timeout or a non-2xx. */
export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { "User-Agent": LOOKUP_USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`);
  return res.json();
}

/** The source has no cover under that id: an answer, not a failure. */
export class NoCoverError extends Error {}

/**
 * GET an image into memory, following redirects, under `MAX_COVER_BYTES`.
 * Throws `NoCoverError` on a 404 and a plain error on anything else that is
 * not a 2xx, a network error, a timeout, or a body over the cap. The bytes are
 * not trusted: every caller re-encodes them through sharp before they go
 * anywhere.
 */
export async function fetchImage(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(COVER_TIMEOUT_MS),
    headers: { "User-Agent": LOOKUP_USER_AGENT, Accept: "image/*" },
    redirect: "follow",
  });
  if (res.status === 404) throw new NoCoverError();
  if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`);

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) {
    throw new Error("Cover is larger than the cap.");
  }
  if (!res.body) throw new Error("Cover response had no body.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_COVER_BYTES) throw new Error("Cover is larger than the cap.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Spaces request STARTS at least `intervalMs` apart, across the whole process.
 *
 * Each caller reserves its slot synchronously before it awaits anything, so
 * two searches arriving together (two browsers, two tabs) get two different
 * slots rather than both seeing a free one. That is the whole of MusicBrainz's
 * "at most one request a second": one gate, one process, every MusicBrainz
 * request through it.
 */
export class RateGate {
  private nextAt = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  /** Resolves when the caller may send its request. */
  async take(): Promise<void> {
    const now = this.clock.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.intervalMs;
    if (at > now) await this.clock.sleep(at - now);
  }
}

/**
 * A small TTL cache in front of a source, as the Gutendex client keeps one: a
 * repeat search inside the TTL never leaves the server. Oldest-out past
 * `maxEntries`, so a long-running API cannot grow it without bound.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
