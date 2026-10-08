import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BotCommandsResponse, Player, Track } from "@ebook-reader/shared";
import { runMigrations } from "../src/database/bootstrap.js";
import { knex } from "../src/database/knex.js";
import { migrationSource } from "../src/database/migrations/index.js";
import { buildTestApp, type TestApp } from "./harness.js";

/**
 * Brief 81: the Jukebox API. The bot signs in with `{atrium: ["jukebox"]}`
 * (brief 80); a person has the default grant.
 *
 * The Playlist below is one, two, three (artist A's album X, tracks 1 and 2,
 * then artist B), plus a Track only the delete test uses, sorted last.
 */

const VOICE = { id: "200000000000000001", name: "General" };

/** One guild per scenario, so no test inherits another's Player. */
const GUILD = {
  basics: "100000000000000001",
  order: "100000000000000002",
  shuffle: "100000000000000003",
  offline: "100000000000000004",
  poll: "100000000000000005",
  deleted: "100000000000000006",
  previous: "100000000000000007",
};

async function seedTrack(id: string, title: string, author: string, series: string, index: number): Promise<void> {
  await knex("books").insert({
    id,
    title,
    author,
    series,
    series_index: index,
    format: "mp3",
    kind: "audio",
    size_bytes: 1,
    duration_seconds: 180,
    created_at: new Date().toISOString(),
    source: "upload",
  });
}

describe("the Jukebox API", () => {
  let t: TestApp;
  let bot: string;
  let person: string;

  before(async () => {
    t = await buildTestApp();
    bot = t.ward.signIn("bot", "subject-bot", { atrium: ["jukebox"] });
    person = t.ward.signIn("person", "subject-person");
  });
  after(async () => {
    await t.close();
  });

  const send = async (cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => {
    const res = await t.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };

  /** The bot reports a guild, with a stale `playId` unless one is given, so only liveness and voice change. */
  const report = (guildId: string, extra: object = {}) =>
    send(bot, "POST", "/jukebox/bot/status", {
      guildId,
      guildName: `Guild ${guildId.slice(-1)}`,
      voiceChannel: VOICE,
      voiceChannels: [VOICE],
      playId: 999_999,
      state: "idle",
      positionMs: 0,
      ...extra,
    });

  const control = async (guildId: string, body: object): Promise<Player> => {
    const res = await send(person, "POST", `/jukebox/players/${guildId}/control`, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Player;
  };

  const player = async (guildId: string): Promise<Player> => {
    const res = await send(person, "GET", `/jukebox/players/${guildId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Player;
  };

  const cursorOf = async (guildId: string): Promise<string | null> =>
    (await knex("jukebox_players").where("guild_id", guildId).first()).playlist_cursor_book_id;

  it("the migration runs down and up again", async () => {
    await knex.migrate.down({ migrationSource, tableName: "knex_migrations", disableTransactions: true });
    for (const table of ["jukebox_players", "jukebox_queue_entries", "jukebox_history", "jukebox_commands"]) {
      assert.equal(await knex.schema.hasTable(table), false, table);
    }
    await runMigrations();
    for (const table of ["jukebox_players", "jukebox_queue_entries", "jukebox_history", "jukebox_commands"]) {
      assert.equal(await knex.schema.hasTable(table), true, table);
    }
    // Seeded after the round trip, so the Playlist exists for every test below.
    await seedTrack("t1", "One", "Artist A", "Album X", 1);
    await seedTrack("t3", "Three", "Artist B", "Album Y", 1);
    await seedTrack("t2", "Two", "artist a", "album x", 2);
    await seedTrack("zz", "Doomed", "Zed", "Last", 1);
    await knex("books").insert({
      id: "book",
      title: "A Book",
      format: "pdf",
      kind: "book",
      size_bytes: 1,
      created_at: new Date().toISOString(),
      source: "upload",
    });
  });

  it("lists Tracks in Playlist order, case-insensitively, and filters on q", async () => {
    const all = await send(person, "GET", "/jukebox/tracks");
    assert.deepEqual(
      (all.body as Track[]).map((track) => track.id),
      ["t1", "t2", "t3", "zz"],
    );
    const filtered = await send(person, "GET", "/jukebox/tracks?q=ALBUM%20y");
    assert.deepEqual(
      (filtered.body as Track[]).map((track) => track.id),
      ["t3"],
    );
  });

  it("a bot status creates a Player, listed online until 30 seconds pass", async () => {
    const res = await report(GUILD.basics);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.upcoming));
    const listed = (await send(person, "GET", "/jukebox/players")).body as Player[];
    const found = listed.find((p) => p.guildId === GUILD.basics);
    assert.equal(found?.online, true);
    assert.deepEqual(found?.voiceChannel, VOICE);

    await knex("jukebox_players")
      .where("guild_id", GUILD.basics)
      .update({ last_seen_at: new Date(Date.now() - 31_000).toISOString() });
    assert.equal((await player(GUILD.basics)).online, false);
  });

  it("an unknown Player is 404 and a malformed guild id is 400", async () => {
    assert.equal((await send(person, "GET", "/jukebox/players/100000000000000099")).body.error, "PLAYER_NOT_FOUND");
    assert.equal((await send(person, "GET", "/jukebox/players/abc")).status, 400);
  });

  it("attributes Queue entries to the profile, or to the Discord name the bot sends", async () => {
    const mine = await send(person, "POST", `/jukebox/players/${GUILD.basics}/queue`, {
      bookId: "t1",
      at: "end",
      addedBy: { name: "Impostor" },
    });
    assert.equal(mine.status, 200);
    const entry = (mine.body as Player).queue[0];
    assert.deepEqual(entry.addedBy, { kind: "profile", name: "Default" });
    assert.equal(entry.track.id, "t1");

    const theirs = await send(bot, "POST", `/jukebox/players/${GUILD.basics}/queue`, {
      bookId: "t2",
      at: "end",
      addedBy: { name: "Discord Dana" },
    });
    assert.equal(theirs.status, 200);
    assert.deepEqual((theirs.body as Player).queue[1].addedBy, { kind: "discord", name: "Discord Dana" });

    const unnamed = await send(bot, "POST", `/jukebox/players/${GUILD.basics}/queue`, { bookId: "t2", at: "end" });
    assert.equal(unnamed.status, 400);
  });

  it("refuses a book in the Queue with 400 NOT_A_TRACK", async () => {
    const res = await send(person, "POST", `/jukebox/players/${GUILD.basics}/queue`, { bookId: "book", at: "end" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "NOT_A_TRACK");
  });

  it("moves, removes and clears Queue entries", async () => {
    let p = await player(GUILD.basics);
    const [first, second] = p.queue;
    p = (await send(person, "POST", `/jukebox/players/${GUILD.basics}/queue/${second.id}/move`, { toIndex: 0 }))
      .body as Player;
    assert.deepEqual(
      p.queue.map((e) => e.id),
      [second.id, first.id],
    );
    p = (await send(person, "DELETE", `/jukebox/players/${GUILD.basics}/queue/${second.id}`)).body as Player;
    assert.deepEqual(
      p.queue.map((e) => e.id),
      [first.id],
    );
    const missing = await send(person, "DELETE", `/jukebox/players/${GUILD.basics}/queue/${second.id}`);
    assert.equal(missing.body.error, "ENTRY_NOT_FOUND");
    p = (await send(person, "DELETE", `/jukebox/players/${GUILD.basics}/queue`)).body as Player;
    assert.deepEqual(p.queue, []);
  });

  it("the long-poll answers within a second of a command, and empty once wait runs out", async () => {
    await report(GUILD.poll);
    await send(person, "POST", `/jukebox/players/${GUILD.poll}/queue`, { bookId: "t3", at: "end" });
    const start = (await send(bot, "GET", "/jukebox/bot/commands")).body as BotCommandsResponse;
    assert.deepEqual(start.commands, []);

    const waiting = t.app.inject({
      method: "GET",
      url: `/jukebox/bot/commands?after=${start.cursor}&wait=5`,
      headers: { cookie: bot },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const sent = Date.now();
    await control(GUILD.poll, { action: "next" });
    const res = await waiting;
    const elapsed = Date.now() - sent;
    assert.ok(elapsed < 1000, `answered after ${elapsed} ms`);
    const body = res.json() as BotCommandsResponse;
    const play = body.commands.find((command) => command.kind === "play");
    assert.ok(play && play.kind === "play");
    assert.equal(play.guildId, GUILD.poll);
    assert.equal(play.track.id, "t3");
    assert.equal(body.cursor, body.commands[body.commands.length - 1].id);

    const quiet = Date.now();
    const empty = (await send(bot, "GET", `/jukebox/bot/commands?after=${body.cursor}&wait=5`))
      .body as BotCommandsResponse;
    const waited = Date.now() - quiet;
    assert.deepEqual(empty.commands, []);
    assert.equal(empty.cursor, body.cursor);
    assert.ok(waited >= 4500 && waited < 7000, `waited ${waited} ms`);
  });

  it("advance with a stale playId answers stale and changes nothing", async () => {
    const before = await player(GUILD.poll);
    const res = await send(bot, "POST", `/jukebox/bot/players/${GUILD.poll}/advance`, {
      playId: before.playId - 1,
      reason: "ended",
    });
    assert.deepEqual(res.body, { play: null, stale: true });
    const afterwards = await player(GUILD.poll);
    assert.equal(afterwards.playId, before.playId);
    assert.equal(afterwards.track?.id, before.track?.id);
  });

  it("Next takes the Queue first, then the Playlist after the cursor, and honours repeat", async () => {
    const g = GUILD.order;
    await report(g);
    await send(person, "POST", `/jukebox/players/${g}/queue`, { bookId: "t3", at: "end" });
    let p = await control(g, { action: "playTrack", bookId: "t1" });
    assert.equal(p.track?.id, "t1");
    assert.deepEqual(
      p.upcoming.map((track) => track.id),
      ["t3", "t2"],
    );

    p = await control(g, { action: "next" });
    assert.equal(p.track?.id, "t3", "the Queue head");
    assert.equal(await cursorOf(g), "t1", "a Queue play does not move the cursor");
    p = await control(g, { action: "next" });
    assert.equal(p.track?.id, "t2", "the Playlist after the cursor");
    p = await control(g, { action: "next" });
    assert.equal(p.track?.id, "t3");
    p = await control(g, { action: "next" });
    assert.equal(p.track?.id, "zz");
    p = await control(g, { action: "next" });
    assert.equal(p.state, "idle", "repeat off stops at the end");
    assert.equal(p.track, null);

    await send(person, "PATCH", `/jukebox/players/${g}/settings`, { repeat: "all" });
    p = await control(g, { action: "playTrack", bookId: "zz" });
    p = await control(g, { action: "next" });
    assert.equal(p.track?.id, "t1", "repeat all wraps");

    await send(person, "PATCH", `/jukebox/players/${g}/settings`, { repeat: "one" });
    const replay = await send(bot, "POST", `/jukebox/bot/players/${g}/advance`, { playId: p.playId, reason: "ended" });
    assert.equal(replay.body.play.track.id, "t1", "repeat one replays an ended Track");
    assert.equal(replay.body.play.playId, p.playId + 1);
    p = await control(g, { action: "next" });
    assert.equal(p.track?.id, "t2", "Next advances even with repeat one");

    const moved = await send(bot, "POST", `/jukebox/bot/players/${g}/advance`, { playId: p.playId, reason: "error" });
    assert.equal(moved.body.play.track.id, "t3", "an error moves on even with repeat one");
  });

  it("Play from idle continues after the cursor, and pause and resume pass through", async () => {
    const g = GUILD.order;
    let p = await control(g, { action: "stop" });
    assert.equal(p.state, "idle");
    p = await control(g, { action: "play" });
    assert.equal(p.state, "playing");
    assert.equal(p.track?.id, "zz", "the Playlist after the cursor");
    p = await control(g, { action: "pause" });
    assert.equal(p.state, "paused");
    p = await control(g, { action: "play" });
    assert.equal(p.state, "playing", "play resumes when paused");
  });

  it("Previous plays the newest history entry", async () => {
    const g = GUILD.previous;
    await report(g);
    await control(g, { action: "playTrack", bookId: "t1" });
    let p = await control(g, { action: "next" });
    assert.equal(p.track?.id, "t2");
    p = await control(g, { action: "previous" });
    assert.equal(p.track?.id, "t1");
    assert.equal(await cursorOf(g), "t1", "a Playlist Track moves the cursor back");
    const restarted = await control(g, { action: "previous" });
    assert.equal(restarted.track?.id, "t1", "no history left: the current Track restarts");
    assert.equal(restarted.playId, p.playId + 1);
  });

  it("with shuffle on, upcoming holds still between polls and Next plays its head", async () => {
    const g = GUILD.shuffle;
    await report(g);
    await control(g, { action: "playTrack", bookId: "t1" });
    await send(person, "PATCH", `/jukebox/players/${g}/settings`, { shuffle: true });
    const first = (await player(g)).upcoming.map((track) => track.id);
    const second = (await player(g)).upcoming.map((track) => track.id);
    assert.equal(first.length, 2);
    assert.deepEqual(first, second);
    assert.ok(!first.includes("t1"), "the current Track is not picked again at once");
    const p = await control(g, { action: "next" });
    assert.equal(p.track?.id, first[0]);
    assert.equal(p.upcoming[0].id, first[1], "the second pick moves up");
  });

  it("a person cannot call the bot routes", async () => {
    for (const [method, url, payload] of [
      ["GET", "/jukebox/bot/commands", undefined],
      ["POST", "/jukebox/bot/status", {}],
      ["POST", `/jukebox/bot/players/${GUILD.basics}/advance`, { playId: 0, reason: "ended" }],
    ] as const) {
      const res = await send(person, method, url, payload);
      assert.equal(res.status, 403, url);
      assert.equal(res.body.error, "JUKEBOX_BOT_ONLY");
    }
  });

  it("the bot account can list Tracks and Players", async () => {
    assert.equal((await send(bot, "GET", "/jukebox/tracks?q=one")).status, 200);
    assert.equal((await send(bot, "GET", "/jukebox/players")).status, 200);
    assert.equal((await send(bot, "GET", `/jukebox/players/${GUILD.order}`)).status, 200);
  });

  it("an offline Player refuses control with 409 and still takes Queue edits", async () => {
    const g = GUILD.offline;
    await report(g);
    await knex("jukebox_players")
      .where("guild_id", g)
      .update({ last_seen_at: new Date(Date.now() - 31_000).toISOString() });
    const refused = await send(person, "POST", `/jukebox/players/${g}/control`, { action: "play" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "PLAYER_OFFLINE");
    const queued = await send(person, "POST", `/jukebox/players/${g}/queue`, { bookId: "t2", at: "next" });
    assert.equal(queued.status, 200);
    assert.equal((queued.body as Player).queue.length, 1);
  });

  it("a bot restart (a fresh cursor) leaves the Player idle with its Queue", async () => {
    const g = GUILD.offline;
    await report(g);
    await control(g, { action: "playTrack", bookId: "t1" });
    const res = await send(bot, "GET", "/jukebox/bot/commands");
    assert.equal(res.status, 200);
    const p = await player(g);
    assert.equal(p.state, "idle");
    assert.equal(p.track, null);
    assert.equal(p.voiceChannel, null);
    assert.equal(p.queue.length, 1);
  });

  it("no voice channel on the current play is lost voice: idle", async () => {
    const g = GUILD.offline;
    await report(g);
    const playing = await control(g, { action: "playTrack", bookId: "t1" });
    await report(g, { voiceChannel: null, playId: playing.playId, state: "playing" });
    const p = await player(g);
    assert.equal(p.state, "idle");
    assert.equal(p.track, null);
  });

  it("a report about an older play changes nothing but voice and liveness", async () => {
    const g = GUILD.offline;
    await report(g);
    const playing = await control(g, { action: "playTrack", bookId: "t2" });
    // The bot has not reached the join and play yet: no voice, the old playId.
    await report(g, { voiceChannel: null, playId: playing.playId - 1, state: "idle" });
    let p = await player(g);
    assert.equal(p.state, "playing");
    assert.equal(p.track?.id, "t2");

    // A report sent before the bot saw a stop cannot start the play again.
    await control(g, { action: "stop" });
    await report(g, { playId: playing.playId, state: "playing", positionMs: 5000 });
    p = await player(g);
    assert.equal(p.state, "idle");
    assert.equal(p.track, null);
  });

  it("deleting a queued, current library Track removes the entry and clears it", async () => {
    const g = GUILD.deleted;
    await report(g);
    await control(g, { action: "playTrack", bookId: "zz" });
    await send(person, "POST", `/jukebox/players/${g}/queue`, { bookId: "zz", at: "end" });
    const deleted = await t.app.inject({ method: "DELETE", url: "/library/zz", headers: { cookie: person } });
    assert.ok(deleted.statusCode < 300, deleted.body);
    const p = await player(g);
    assert.equal(p.track, null);
    assert.deepEqual(p.queue, []);
    const next = await send(bot, "POST", `/jukebox/bot/players/${g}/advance`, { playId: p.playId, reason: "ended" });
    assert.ok(next.body.play, "the bot's advance moves on normally");
  });
});
