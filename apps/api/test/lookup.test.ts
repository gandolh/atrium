import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";
import type { FileType, MediaKind } from "@ebook-reader/shared";
import { coverPathFor, filePathFor } from "../src/common/paths.js";
import { knex } from "../src/database/knex.js";
import { RateGate } from "../src/modules/lookup/lookup-http.js";
import { clearLookupCaches } from "../src/modules/lookup/lookup.service.js";
import { buildTestApp, type TestApp } from "./harness.js";

/**
 * Brief 100: Look up on request. Every source is mocked: `fetch` is swapped
 * for a dispatcher keyed on hostname that THROWS on any host it was not given,
 * so a missed stub fails the test instead of reaching the network.
 */

// --- The fake network --------------------------------------------------------

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

interface Sent {
  url: URL;
  userAgent: string | null;
  at: number;
}

const realFetch = globalThis.fetch;
let routes: Record<string, Handler> = {};
let sent: Sent[] = [];

function installFakeNetwork(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    sent.push({ url, userAgent: new Headers(init?.headers).get("user-agent"), at: Date.now() });
    const handler = routes[url.hostname];
    if (!handler) throw new Error(`No network in tests: ${url.hostname} was not stubbed`);
    return handler(url, init);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const image = (bytes: Buffer) => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/png" } });
const timeout = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

// --- MusicBrainz and Open Library fixtures -----------------------------------

const CANONICAL = "833f00e1-0000-4000-8000-000000000001";
const REMIX = "39b7ae7d-0000-4000-8000-000000000002";
const VINYL = "aaaaaaaa-0000-4000-8000-000000000003";
const RAM_GROUP = "aa997ea0-2936-40bd-884d-3af8a0e064dc";

function release(id: number, title: string, opts: { status?: string; type?: string; secondary?: string[]; date?: string; group?: string; number?: string }) {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    title,
    status: opts.status ?? "Official",
    date: opts.date,
    "release-group": {
      id: opts.group ?? `11111111-0000-4000-8000-${String(id).padStart(12, "0")}`,
      "primary-type": opts.type ?? "Album",
      "secondary-types": opts.secondary,
    },
    media: [{ position: 1, "track-offset": 0, track: [{ number: opts.number ?? "1" }] }],
  };
}

/**
 * Shaped like MusicBrainz's real answer for "get lucky" by Daft Punk on
 * 2026-10-28: a remix scores 100 on one release, the album recording scores
 * 72 on dozens.
 */
const MB_RECORDINGS = {
  created: "2026-10-28T00:00:00.000Z",
  count: 3,
  offset: 0,
  recordings: [
    {
      id: REMIX,
      title: "Get Lucky (Daft Punk remix)",
      score: 100,
      "first-release-date": "2023",
      "artist-credit": [{ name: "Daft Punk", joinphrase: "" }],
      releases: [release(1, "Random Access Memories", { status: "Bootleg", number: "5" })],
    },
    {
      id: CANONICAL,
      title: "Get Lucky",
      score: 72,
      "first-release-date": "2013-04-19",
      "artist-credit": [
        { name: "Daft Punk", joinphrase: " feat. " },
        { name: "Pharrell Williams", joinphrase: " & " },
        { name: "Nile Rodgers", joinphrase: "" },
      ],
      releases: [
        ...Array.from({ length: 15 }, (_, i) =>
          release(100 + i, `Hits ${i}`, { secondary: ["Compilation"], date: "2013-06-01", number: "3" }),
        ),
        release(2, "Random Access Memories", { date: "2013-05-17", group: RAM_GROUP, number: "8" }),
      ],
    },
    {
      id: VINYL,
      title: "Get Lucky",
      score: 60,
      "artist-credit": [{ name: "Daft Punk" }],
      releases: [release(3, "Get Lucky 12\"", { type: "Single", date: "2013", number: "B1" })],
    },
  ],
};

const OL_DOCS = {
  numFound: 2,
  docs: [
    { key: "/works/OL27482W", title: "The Hobbit", author_name: ["J.R.R. Tolkien"], first_publish_year: 1937, cover_i: 14627509 },
    { key: "/works/OL219602W", title: "The Hobbit", author_name: ["Charles Dixon", "Sean Deming", "J.R.R. Tolkien"], first_publish_year: 1990 },
  ],
};

// --- Library rows ------------------------------------------------------------

async function seed(
  id: string,
  format: FileType,
  kind: MediaKind,
  fields: { title: string; author?: string | null; series?: string | null; seriesIndex?: number | null; convertedFrom?: string },
): Promise<void> {
  await knex("books").insert({
    id,
    title: fields.title,
    author: fields.author ?? null,
    series: fields.series ?? null,
    series_index: fields.seriesIndex ?? null,
    format,
    kind,
    size_bytes: 16,
    created_at: new Date().toISOString(),
    source: "upload",
    subjects: "[]",
    converted_from: fields.convertedFrom ?? null,
  });
  const file = filePathFor(id, format);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(16, 1));
}

async function writeCover(id: string): Promise<Buffer> {
  const bytes = await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: 10, g: 120, b: 40 } } })
    .jpeg()
    .toBuffer();
  const path = coverPathFor(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return bytes;
}

const row = (id: string) => knex("books").where({ id }).first();

// --- The suite ---------------------------------------------------------------

describe("the rate gate", () => {
  it("spaces request starts a second apart, concurrent callers included", async () => {
    let now = 0;
    const slept: number[] = [];
    const gate = new RateGate(1_000, {
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await Promise.all([gate.take(), gate.take(), gate.take()]);
    assert.deepEqual(slept, [1_000, 2_000]);
    now = 5_000;
    await gate.take();
    assert.deepEqual(slept, [1_000, 2_000], "a caller after a quiet spell does not wait");
  });
});

describe("Look up", () => {
  let t: TestApp;
  let cookie: string;
  let coverPng: Buffer;

  before(async () => {
    installFakeNetwork();
    t = await buildTestApp();
    cookie = await t.signIn("subject-lookup");
    coverPng = await sharp({ create: { width: 600, height: 600, channels: 3, background: { r: 200, g: 50, b: 50 } } })
      .png()
      .toBuffer();
    await seed("song", "mp3", "audio", { title: "Track 01", author: "Unknown Artist" });
    await seed("book", "pdf", "book", { title: "the_hobbit_tolkien", author: null });
    await seed("film", "mp4", "video", { title: "Holiday" });
    await seed("pair", "pdf", "book", { title: "scan_0042" });
    await seed("pair-epub", "epub", "book", { title: "scan_0042", convertedFrom: "pair" });
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await t.close();
  });
  beforeEach(() => {
    routes = {};
    sent = [];
    clearLookupCaches();
  });

  const search = (id: string, query = "") =>
    t.app.inject({ method: "GET", url: `/library/${id}/lookup${query}`, headers: { cookie } });
  const apply = (id: string, body: unknown) =>
    t.app.inject({ method: "POST", url: `/library/${id}/lookup`, headers: { cookie }, payload: body as object });

  it("searches MusicBrainz for a song and ranks the album recording first", async () => {
    routes["musicbrainz.org"] = () => json(MB_RECORDINGS);
    const res = await search("song", "?title=get%20lucky&author=daft%20punk");
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.source, "musicbrainz");
    assert.deepEqual(body.candidates[0], {
      source: "musicbrainz",
      sourceId: CANONICAL,
      title: "Get Lucky",
      author: "Daft Punk feat. Pharrell Williams & Nile Rodgers",
      series: "Random Access Memories",
      seriesIndex: 8,
      year: 2013,
      coverRef: RAM_GROUP,
    });
    const vinyl = body.candidates.find((c: { sourceId: string }) => c.sourceId === VINYL);
    assert.equal(vinyl.seriesIndex, null, "a vinyl side like B1 is not a track number");

    assert.equal(sent.length, 1);
    const [request] = sent;
    assert.equal(request.url.pathname, "/ws/2/recording");
    assert.equal(
      request.url.searchParams.get("query"),
      'recording:"get lucky" AND artist:"daft punk" AND status:official',
    );
    assert.match(request.userAgent ?? "", /^Atrium\/\S+ \( .+ \)$/, "MusicBrainz's descriptive User-Agent");
  });

  it("starts from the item's own title and author, and escapes them", async () => {
    await knex("books").where({ id: "song" }).update({ title: 'Say "Hi" \\o/', author: "Unknown Artist" });
    routes["musicbrainz.org"] = () => json(MB_RECORDINGS);
    const res = await search("song");
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(
      sent[0].url.searchParams.get("query"),
      'recording:"Say \\"Hi\\" \\\\o/" AND artist:"Unknown Artist" AND status:official',
    );
    await knex("books").where({ id: "song" }).update({ title: "Track 01" });
  });

  it("asks again without the official filter when it finds nothing", async () => {
    routes["musicbrainz.org"] = (url) =>
      json(url.searchParams.get("query")?.endsWith("status:official") ? { recordings: [] } : MB_RECORDINGS);
    const res = await search("song", "?title=get%20lucky&author=");
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].url.searchParams.get("query"), 'recording:"get lucky"');
    assert.ok(sent[1].at - sent[0].at >= 990, `MusicBrainz is held to one request a second (${sent[1].at - sent[0].at}ms)`);
    assert.ok(res.json().candidates.length > 0);
  });

  it("holds two searches arriving together to one MusicBrainz request a second", async () => {
    routes["musicbrainz.org"] = () => json(MB_RECORDINGS);
    const [a, b] = await Promise.all([
      search("song", "?title=one&author=a"),
      search("song", "?title=two&author=b"),
    ]);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(sent.length, 2);
    assert.ok(Math.abs(sent[1].at - sent[0].at) >= 990, `${sent[1].at - sent[0].at}ms apart`);
  });

  it("answers a repeat search from the cache", async () => {
    routes["musicbrainz.org"] = () => json(MB_RECORDINGS);
    await search("song", "?title=again&author=");
    await search("song", "?title=again&author=");
    assert.equal(sent.length, 1);
  });

  it("searches Open Library for a book, from its filename title", async () => {
    routes["openlibrary.org"] = () => json(OL_DOCS);
    const res = await search("book");
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(sent[0].url.searchParams.get("q"), "the hobbit tolkien");
    assert.match(sent[0].userAgent ?? "", /^Atrium\//);
    const [first, second] = res.json().candidates;
    assert.deepEqual(first, {
      source: "openlibrary",
      sourceId: "/works/OL27482W",
      title: "The Hobbit",
      author: "J.R.R. Tolkien",
      series: null,
      seriesIndex: null,
      year: 1937,
      coverRef: "14627509",
    });
    assert.equal(second.author, "Charles Dixon, Sean Deming, J.R.R. Tolkien");
    assert.equal(second.coverRef, null);
  });

  it("says when there are no results", async () => {
    routes["openlibrary.org"] = () => json({ numFound: 0, docs: [] });
    const res = await search("book", "?title=zzzz&author=");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { source: "openlibrary", candidates: [] });
  });

  it("names the source that is down, or slow", async () => {
    routes["musicbrainz.org"] = () => json({ error: "busy" }, 503);
    const down = await search("song", "?title=down&author=");
    assert.equal(down.statusCode, 502);
    assert.deepEqual(down.json(), { error: "UPSTREAM", source: "musicbrainz" });

    routes["openlibrary.org"] = () => timeout();
    const slow = await search("book", "?title=slow&author=");
    assert.equal(slow.statusCode, 502);
    assert.deepEqual(slow.json(), { error: "UPSTREAM", source: "openlibrary" });
  });

  it("refuses an empty query, and video, which has no source", async () => {
    const empty = await search("song", "?title=%20&author=");
    assert.equal(empty.statusCode, 400);
    const film = await search("film");
    assert.equal(film.statusCode, 422);
    assert.equal(film.json().error, "NO_LOOKUP_SOURCE");
    const missing = await search("nope");
    assert.equal(missing.statusCode, 404);
    assert.equal(sent.length, 0, "nothing left the server");
  });

  it("applies a song's title, artist, album, track number and cover", async () => {
    routes["coverartarchive.org"] = (url) => {
      assert.equal(url.pathname, `/release-group/${RAM_GROUP}/front-500`);
      return image(coverPng);
    };
    routes["musicbrainz.org"] = () => json(MB_RECORDINGS);
    const candidate = (await search("song", "?title=get%20lucky&author=daft%20punk")).json().candidates[0];
    sent = [];

    const res = await apply("song", {
      candidate,
      fields: { title: true, author: true, series: true, seriesIndex: true, cover: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    const book = res.json();
    assert.equal(book.title, "Get Lucky");
    assert.equal(book.author, "Daft Punk feat. Pharrell Williams & Nile Rodgers");
    assert.equal(book.series, "Random Access Memories");
    assert.equal(book.seriesIndex, 8);
    assert.equal(book.hasCover, true);
    assert.deepEqual(sent.map((s) => s.url.hostname), ["coverartarchive.org"], "apply asks MusicBrainz nothing");

    const stored = readFileSync(coverPathFor("song"));
    assert.notDeepEqual(stored, coverPng, "the source's bytes are re-encoded, never stored as-is");
    assert.equal((await sharp(stored).metadata()).format, "jpeg");
  });

  it("applies only the ticked fields, and leaves the cover alone when it is not ticked", async () => {
    const before = await writeCover("book");
    const mtime = statSync(coverPathFor("book")).mtimeMs;
    await knex("books").where({ id: "book" }).update({ series: "Middle-earth", series_index: 1 });
    routes["openlibrary.org"] = () => json(OL_DOCS);
    const candidate = (await search("book")).json().candidates[0];
    sent = [];

    const res = await apply("book", { candidate, fields: { title: true, author: true } });
    assert.equal(res.statusCode, 200, res.body);
    const stored = await row("book");
    assert.equal(stored.title, "The Hobbit");
    assert.equal(stored.author, "J.R.R. Tolkien");
    assert.equal(stored.series, "Middle-earth", "an unticked field stays as it was");
    assert.equal(stored.series_index, 1);
    assert.deepEqual(readFileSync(coverPathFor("book")), before);
    assert.equal(statSync(coverPathFor("book")).mtimeMs, mtime);
    assert.equal(sent.length, 0, "no cover was fetched");
  });

  it("changes nothing when the cover cannot be fetched", async () => {
    await knex("books").where({ id: "song" }).update({ title: "Track 01", author: "Unknown Artist", series: null, series_index: null });
    const cover = await writeCover("song");
    const candidate = {
      source: "musicbrainz",
      sourceId: CANONICAL,
      title: "Get Lucky",
      author: "Daft Punk",
      series: "Random Access Memories",
      seriesIndex: 8,
      year: 2013,
      coverRef: RAM_GROUP,
    };
    const fields = { title: true, author: true, series: true, seriesIndex: true, cover: true };

    routes["coverartarchive.org"] = () => json({ error: "down" }, 503);
    const down = await apply("song", { candidate, fields });
    assert.equal(down.statusCode, 502);
    assert.deepEqual(down.json(), { error: "UPSTREAM", source: "musicbrainz" });

    routes["coverartarchive.org"] = () => new Response("", { status: 404 });
    const none = await apply("song", { candidate, fields });
    assert.equal(none.statusCode, 422);
    assert.equal(none.json().error, "NO_COVER");

    routes["coverartarchive.org"] = () => image(Buffer.from("not an image at all"));
    const junk = await apply("song", { candidate, fields });
    assert.equal(junk.statusCode, 502);

    const stored = await row("song");
    assert.equal(stored.title, "Track 01");
    assert.equal(stored.author, "Unknown Artist");
    assert.equal(stored.series, null);
    assert.deepEqual(readFileSync(coverPathFor("song")), cover);
  });

  it("refuses a ticked field the candidate has no value for, a wrong source, and video", async () => {
    const candidate = {
      source: "openlibrary",
      sourceId: "/works/OL27482W",
      title: "The Hobbit",
      author: null,
      series: null,
      seriesIndex: null,
      year: null,
      coverRef: null,
    };
    const clearing = await apply("book", { candidate, fields: { author: true } });
    assert.equal(clearing.statusCode, 400, "a lookup sets a field, it never clears one");
    const nothing = await apply("book", { candidate, fields: {} });
    assert.equal(nothing.statusCode, 400);
    const wrong = await apply("song", { candidate, fields: { title: true } });
    assert.equal(wrong.statusCode, 422);
    assert.equal(wrong.json().error, "WRONG_SOURCE");
    const film = await apply("film", { candidate, fields: { title: true } });
    assert.equal(film.statusCode, 422);
    const url = await apply("book", {
      candidate: { ...candidate, coverRef: "https://example.com/x.jpg" },
      fields: { cover: true },
    });
    assert.equal(url.statusCode, 400, "a cover is an id, never a URL");
    assert.equal(sent.length, 0);
  });

  it("writes both rows of a converted pair", async () => {
    const candidate = {
      source: "openlibrary",
      sourceId: "/works/OL1W",
      title: "A Real Title",
      author: "An Author",
      series: null,
      seriesIndex: null,
      year: 2001,
      coverRef: null,
    };
    const res = await apply("pair", { candidate, fields: { title: true, author: true } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await row("pair")).title, "A Real Title");
    assert.equal((await row("pair-epub")).title, "A Real Title", "the other format reads the same");
    assert.equal((await row("pair-epub")).author, "An Author");
  });

  it("serves a candidate's thumbnail through the API, and refuses anything but a cover id", async () => {
    routes["covers.openlibrary.org"] = (url) => {
      assert.equal(url.pathname, "/b/id/14627509-M.jpg");
      assert.equal(url.searchParams.get("default"), "false");
      return image(coverPng);
    };
    const ok = await t.app.inject({ method: "GET", url: "/lookup/covers/openlibrary/14627509", headers: { cookie } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers["content-type"], "image/jpeg");
    const meta = await sharp(ok.rawPayload).metadata();
    assert.ok((meta.width ?? 0) <= 300, "re-encoded small");

    routes["coverartarchive.org"] = () => new Response("", { status: 404 });
    const none = await t.app.inject({ method: "GET", url: `/lookup/covers/musicbrainz/${RAM_GROUP}`, headers: { cookie } });
    assert.equal(none.statusCode, 404);

    sent = [];
    for (const path of ["/lookup/covers/openlibrary/..%2F..%2Fetc", "/lookup/covers/tmdb/1", `/lookup/covers/musicbrainz/123`]) {
      const bad = await t.app.inject({ method: "GET", url: path, headers: { cookie } });
      assert.equal(bad.statusCode, 400, path);
    }
    assert.equal(sent.length, 0);
  });

  it("is not on the Discord bot's allowlist", async () => {
    const bot = await t.signIn("subject-lookup-bot", "jukebox");
    for (const [method, url] of [
      ["GET", "/library/song/lookup"],
      ["POST", "/library/song/lookup"],
      ["GET", `/lookup/covers/musicbrainz/${RAM_GROUP}`],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: { cookie: bot } });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
    }
    assert.equal(sent.length, 0);
  });

  it("never runs on upload", async () => {
    // Uploads read the file only (extract.service.ts); a stray lookup would
    // hit the fake network, which has no routes here and would throw.
    const boundary = "----lookupboundary";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="get_lucky.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
      Buffer.alloc(64, 0),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await t.app.inject({
      method: "POST",
      url: "/library",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(sent.length, 0);
    assert.ok(existsSync(filePathFor(res.json().id, "mp3")));
  });
});
