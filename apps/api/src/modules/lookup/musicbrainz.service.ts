import { z } from "zod";
import {
  isLookupCoverRef,
  lookupCandidateSchema,
  type LookupCandidate,
} from "@ebook-reader/shared";
import { RateGate, fetchJson } from "./lookup-http.js";

/**
 * The MusicBrainz client (brief 100): a recording search, mapped onto the
 * library's fields, and the Cover Art Archive URL for a match's cover.
 *
 * MusicBrainz asks for at most one request a second from a client; every
 * request here goes through `musicBrainzGate` first. The Cover Art Archive is
 * a separate service (served by the Internet Archive) and is not gated.
 */

const MUSICBRAINZ_SEARCH_URL = "https://musicbrainz.org/ws/2/recording";
const COVER_ART_ARCHIVE_URL = "https://coverartarchive.org";

/** How many recordings to ask for. More than we show, so the ranking below has room. */
const SEARCH_LIMIT = 25;

/** The process-wide gate (see `RateGate`). */
export const musicBrainzGate = new RateGate(1_000);

// --- MusicBrainz's search shape, parsed defensively --------------------------
const releaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string().nullish(),
  date: z.string().nullish(),
  "release-group": z
    .object({
      id: z.string(),
      "primary-type": z.string().nullish(),
      "secondary-types": z.array(z.string()).nullish(),
    })
    .nullish(),
  media: z
    .array(z.object({ track: z.array(z.object({ number: z.string().nullish() })).nullish() }))
    .nullish(),
});
type Release = z.infer<typeof releaseSchema>;

const recordingSchema = z.object({
  id: z.string(),
  title: z.string(),
  score: z.number().nullish(),
  "first-release-date": z.string().nullish(),
  "artist-credit": z
    .array(z.object({ name: z.string(), joinphrase: z.string().nullish() }))
    .nullish(),
  releases: z.array(releaseSchema).nullish(),
});
type Recording = z.infer<typeof recordingSchema>;

const searchResponseSchema = z.object({ recordings: z.array(recordingSchema).default([]) });

// --- The query ---------------------------------------------------------------

/** Underscores and runs of space become one space: a filename's words, searchable. */
export function searchWords(text: string | undefined | null): string {
  return (text ?? "").replace(/[_\s]+/g, " ").trim();
}

/** A Lucene phrase. Inside quotes only `\` and `"` are special. */
function phrase(text: string): string {
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * The fielded query: the title as a phrase in the recording's name, the
 * author as a phrase in its artist credit. Fielded because MusicBrainz's
 * unfielded search only matches the recording's name, so "get lucky daft
 * punk" finds recordings *titled* "… (Daft Punk)".
 */
export function musicBrainzQuery(title: string, author: string): string {
  const parts: string[] = [];
  if (title) parts.push(`recording:${phrase(title)}`);
  if (author) parts.push(`artist:${phrase(author)}`);
  return parts.join(" AND ");
}

async function searchRecordings(query: string): Promise<Recording[]> {
  const url = new URL(MUSICBRAINZ_SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", String(SEARCH_LIMIT));
  await musicBrainzGate.take();
  return searchResponseSchema.parse(await fetchJson(url.toString())).recordings;
}

// --- Ranking -----------------------------------------------------------------

/**
 * MusicBrainz's own score ranks the canonical recording of a well-known song
 * below remixes and covers that happen to match the words better, so the
 * score is weighed against how many releases a recording is on: the album
 * track of a hit is on dozens, a bedroom remix on one.
 */
function recordingRank(recording: Recording): number {
  return (recording.score ?? 0) + 10 * Math.log2(1 + (recording.releases?.length ?? 0));
}

const PRIMARY_TYPE_ORDER: Record<string, number> = { album: 0, single: 1, ep: 1 };

/** The release to show for a recording: official, an album, not a compilation, the earliest. */
function releaseKey(release: Release): [number, number, number, string] {
  const group = release["release-group"];
  return [
    release.status === "Official" ? 0 : 1,
    PRIMARY_TYPE_ORDER[(group?.["primary-type"] ?? "").toLowerCase()] ?? 2,
    (group?.["secondary-types"]?.length ?? 0) > 0 ? 1 : 0,
    release.date || "9999",
  ];
}

function compareKeys(a: [number, number, number, string], b: [number, number, number, string]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0;
}

function bestRelease(recording: Recording): Release | null {
  const releases = recording.releases ?? [];
  if (releases.length === 0) return null;
  return [...releases].sort((a, b) => compareKeys(releaseKey(a), releaseKey(b)))[0];
}

// --- Mapping -----------------------------------------------------------------

/** "Daft Punk feat. Pharrell Williams & Nile Rodgers": names with their join phrases. */
function artistCredit(recording: Recording): string | null {
  const credit = (recording["artist-credit"] ?? [])
    .map((part) => part.name + (part.joinphrase ?? ""))
    .join("")
    .trim();
  return credit || null;
}

/** The track's number on the release, or null for a vinyl side like "B1". */
function trackNumber(release: Release | null): number | null {
  const number = release?.media?.find((m) => m.track && m.track.length > 0)?.track?.[0]?.number;
  return number && /^\d+$/.test(number) ? Number(number) : null;
}

function yearOf(date: string | null | undefined): number | null {
  const match = /^(\d{4})/.exec(date ?? "");
  return match ? Number(match[1]) : null;
}

const clip = (text: string) => text.trim().slice(0, 500);

function toCandidate(recording: Recording): LookupCandidate | null {
  const release = bestRelease(recording);
  const group = release?.["release-group"]?.id ?? null;
  const parsed = lookupCandidateSchema.safeParse({
    source: "musicbrainz",
    sourceId: recording.id,
    title: clip(recording.title),
    author: artistCredit(recording)?.slice(0, 500) ?? null,
    series: release ? clip(release.title) || null : null,
    seriesIndex: trackNumber(release),
    year: yearOf(release?.date) ?? yearOf(recording["first-release-date"]),
    // The release GROUP's front cover: the album's cover, which the Cover Art
    // Archive has for far more albums than it has for any one pressing.
    coverRef: group && isLookupCoverRef("musicbrainz", group) ? group : null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Search MusicBrainz for recordings matching `title` and `author`, best first,
 * one candidate per recording, at most `limit`, duplicates (same title, artist
 * and album) folded. Throws when MusicBrainz cannot be reached.
 *
 * Official releases are asked for first; only when that finds nothing does a
 * second, unfiltered search go out, through the gate like the first.
 */
export async function searchMusicBrainz(
  title: string,
  author: string,
  limit: number,
): Promise<LookupCandidate[]> {
  const query = musicBrainzQuery(title, author);
  let recordings = await searchRecordings(`${query} AND status:official`);
  if (recordings.length === 0) recordings = await searchRecordings(query);

  const ranked = recordings
    .map((recording, order) => ({ recording, rank: recordingRank(recording), order }))
    .sort((a, b) => b.rank - a.rank || a.order - b.order);

  const seen = new Set<string>();
  const candidates: LookupCandidate[] = [];
  for (const { recording } of ranked) {
    const candidate = toCandidate(recording);
    if (!candidate) continue;
    const key = [candidate.title, candidate.author, candidate.series].join("\u0000").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= limit) break;
  }
  return candidates;
}

/** The Cover Art Archive's front cover for a release group, at 250px or 500px. */
export function coverArtArchiveUrl(releaseGroupId: string, size: "thumb" | "full"): string {
  return `${COVER_ART_ARCHIVE_URL}/release-group/${releaseGroupId}/front-${size === "thumb" ? 250 : 500}`;
}
