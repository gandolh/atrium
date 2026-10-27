import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { JUKEBOX_FAILURE_BUDGET, type BotCommandsResponse, type Player, type Track } from "@ebook-reader/shared";
import { runMigrations } from "../src/database/bootstrap.js";
import { IDLE_REPORT_GRACE_MS } from "../src/modules/jukebox/jukebox.service.js";
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
  stopped: "100000000000000008",
  deleteMiddle: "100000000000000009",
  deleteCursor: "100000000000000010",
  deletePaused: "100000000000000011",
  idleReport: "100000000000000012",
  idleGrace: "100000000000000013",
  failing: "100000000000000014",
  recovering: "100000000000000015",
  noVoice: "100000000000000016",
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
    bot = await t.signIn("subject-bot", "jukebox");
    person = await t.signIn("subject-person");
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
    // By name: it is no longer the newest migration (D58's came after it). The
    // later one that alters its table goes first, or latest would not re-add it.
    for (const name of [
      "20261027000001-jukebox-failures",
      "20261027000000-jukebox-idle-report",
      "20261008000000-jukebox",
    ]) {
      await knex.migrate.down({ migrationSource, tableName: "knex_migrations", disableTransactions: true, name });
    }
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

  it("advance on a stopped Player starts nothing", async () => {
    const g = GUILD.stopped;
    await report(g);
    const playing = await control(g, { action: "playTrack", bookId: "t2" });
    await control(g, { action: "stop" });
    const res = await send(bot, "POST", `/jukebox/bot/players/${g}/advance`, { playId: playing.playId, reason: "ended" });
    assert.deepEqual(res.body, { play: null });
    const p = await player(g);
    assert.equal(p.state, "idle");
    assert.equal(p.track, null);
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

  it("with no voice channel, a control that would start a song is 409 NOT_IN_VOICE", async () => {
    const g = GUILD.noVoice;
    // The bot is in the guild but in no voice channel.
    await report(g, { voiceChannel: null });
    for (const body of [
      { action: "play" },
      { action: "resume" },
      { action: "next" },
      { action: "previous" },
      { action: "playTrack", bookId: "t1" },
    ]) {
      const res = await send(person, "POST", `/jukebox/players/${g}/control`, body);
      assert.equal(res.status, 409, body.action);
      assert.equal(res.body.error, "NOT_IN_VOICE");
    }
    let p = await player(g);
    assert.equal(p.state, "idle");
    assert.equal(p.track, null);
    assert.equal(
      await knex("jukebox_commands").where("guild_id", g).count({ n: "*" }).first().then((row) => Number(row?.n)),
      0,
      "nothing was queued for the bot",
    );

    // Stop is still allowed, and Join then Play works before the bot reports the channel.
    assert.equal((await control(g, { action: "stop" })).state, "idle");
    await control(g, { action: "join", channelId: VOICE.id });
    p = await control(g, { action: "play" });
    assert.equal(p.state, "playing");
    assert.ok(p.track);
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

  it("no voice channel on the current play twice running is lost voice: idle", async () => {
    const g = GUILD.offline;
    await report(g);
    const playing = await control(g, { action: "playTrack", bookId: "t1" });
    // One report without voice is a Discord voice reconnect: the audio carries on.
    await report(g, { voiceChannel: null, playId: playing.playId, state: "playing" });
    let p = await player(g);
    assert.equal(p.state, "playing");
    assert.equal(p.track?.id, "t1");
    // The voice came back: a later gap starts counting again.
    await report(g, { playId: playing.playId, state: "playing" });
    await report(g, { voiceChannel: null, playId: playing.playId, state: "playing" });
    assert.equal((await player(g)).state, "playing");
    // A second report in a row without voice is lost voice.
    await report(g, { voiceChannel: null, playId: playing.playId, state: "playing" });
    p = await player(g);
    assert.equal(p.state, "idle");
    assert.equal(p.track, null);
  });

  it("an idle report for the current play waits for the advance, which plays the next Track", async () => {
    const g = GUILD.idleReport;
    await report(g);
    const playing = await control(g, { action: "playTrack", bookId: "t1" });
    // The bot set itself idle at the Track's end and reported before advancing.
    await report(g, { playId: playing.playId, state: "idle" });
    const waiting = await player(g);
    assert.equal(waiting.state, "playing");
    assert.equal(waiting.track?.id, "t1");
    const next = await send(bot, "POST", `/jukebox/bot/players/${g}/advance`, {
      playId: playing.playId,
      reason: "ended",
    });
    assert.equal(next.status, 200);
    assert.equal(next.body.play.track.id, "t2");
    const p = await player(g);
    assert.equal(p.state, "playing");
    assert.equal(p.track?.id, "t2");
    assert.equal(
      (await knex("jukebox_players").where("guild_id", g).first()).idle_reported_at,
      null,
      "the new play has no idle report pending",
    );
  });

  it("an idle report with no advance goes idle once the grace period passes", async () => {
    const g = GUILD.idleGrace;
    await report(g);
    const playing = await control(g, { action: "playTrack", bookId: "t2" });
    await report(g, { playId: playing.playId, state: "idle" });
    assert.equal((await player(g)).state, "playing", "still inside the grace period");

    await knex("jukebox_players")
      .where("guild_id", g)
      .update({ idle_reported_at: new Date(Date.now() - IDLE_REPORT_GRACE_MS - 1000).toISOString() });
    const listed = (await send(person, "GET", "/jukebox/players")).body as Player[];
    const p = listed.find((one) => one.guildId === g)!;
    assert.equal(p.state, "idle");
    assert.equal(p.track, null);
    assert.equal(p.playId, playing.playId);
    // An advance that comes after that finds the Player stopped.
    const late = await send(bot, "POST", `/jukebox/bot/players/${g}/advance`, {
      playId: playing.playId,
      reason: "ended",
    });
    assert.equal(late.body.play, null);

    // A playing report after an idle one clears it: the grace never runs out.
    const again = await control(g, { action: "playTrack", bookId: "t3" });
    await report(g, { playId: again.playId, state: "idle" });
    await report(g, { playId: again.playId, state: "playing", positionMs: 1000 });
    const row = await knex("jukebox_players").where("guild_id", g).first();
    assert.equal(row.idle_reported_at, null);
    assert.equal((await player(g)).track?.id, "t3");
  });

  /** The bot could not play the current Track, `times` times running. Answers each advance's play. */
  const failRepeatedly = async (guildId: string, times: number) => {
    const plays = [];
    for (let attempt = 0; attempt < times; attempt++) {
      const { playId } = await player(guildId);
      const res = await send(bot, "POST", `/jukebox/bot/players/${guildId}/advance`, { playId, reason: "error" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      plays.push(res.body.play);
    }
    return plays;
  };

  it("five songs in a row that will not play leave the Player idle, saying so", async () => {
    assert.equal(JUKEBOX_FAILURE_BUDGET, 5);
    const g = GUILD.failing;
    await report(g);
    // Repeat-all never runs out, which is how the bot and atrium used to loop.
    await send(person, "PATCH", `/jukebox/players/${g}/settings`, { repeat: "all" });
    await control(g, { action: "playTrack", bookId: "t1" });

    const plays = await failRepeatedly(g, 5);
    assert.ok(plays.slice(0, 4).every((play) => play !== null), "the first four failures move on");
    assert.equal(plays[4], null, "the fifth stops");
    const p = await player(g);
    assert.equal(p.state, "idle");
    assert.equal(p.track, null);
    assert.match(p.failure ?? "", /^5 songs in a row would not play, the last “.+”\.$/);

    // A person's Play starts afresh: the failure goes, and the count starts again.
    const again = await control(g, { action: "play" });
    assert.equal(again.state, "playing");
    assert.equal(again.failure, null);
    const more = await failRepeatedly(g, 4);
    assert.ok(more.every((play) => play !== null));
  });

  it("a song that ends normally resets the count of failures", async () => {
    const g = GUILD.recovering;
    await report(g);
    await send(person, "PATCH", `/jukebox/players/${g}/settings`, { repeat: "all" });
    await control(g, { action: "playTrack", bookId: "t1" });

    await failRepeatedly(g, 4);
    const { playId } = await player(g);
    const ended = await send(bot, "POST", `/jukebox/bot/players/${g}/advance`, { playId, reason: "ended" });
    assert.ok(ended.body.play);
    const plays = await failRepeatedly(g, 4);
    assert.ok(plays.every((play) => play !== null), "four more failures are not five in a row");
    const p = await player(g);
    assert.equal(p.state, "playing");
    assert.equal(p.failure, null);
    assert.equal((await failRepeatedly(g, 1))[0], null, "the fifth in a row stops");
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

  const deleteFromLibrary = async (id: string) => {
    const res = await t.app.inject({ method: "DELETE", url: `/library/${id}`, headers: { cookie: person } });
    assert.ok(res.statusCode < 300, res.body);
  };

  /** The newest command atrium wrote for a guild, as the bot would read it. */
  const lastCommand = async (guildId: string) => {
    const row = await knex("jukebox_commands").where("guild_id", guildId).orderBy("id", "desc").first();
    return JSON.parse(row.body) as { kind: string; playId?: number; track?: Track };
  };

  it("deleting the playing last Track at repeat off goes idle, not back to the first", async () => {
    const g = GUILD.deleted;
    await report(g);
    const playing = await control(g, { action: "playTrack", bookId: "zz" });
    await send(person, "POST", `/jukebox/players/${g}/queue`, { bookId: "zz", at: "end" });
    await deleteFromLibrary("zz");
    const p = await player(g);
    assert.equal(p.state, "idle");
    assert.equal(p.track, null);
    assert.deepEqual(p.queue, []);
    assert.equal(p.playId, playing.playId, "no Track started");
    assert.equal(await cursorOf(g), "t3", "the cursor is the Track before the deleted one");
    assert.equal((await lastCommand(g)).kind, "stop");
    const next = await send(bot, "POST", `/jukebox/bot/players/${g}/advance`, { playId: p.playId, reason: "ended" });
    assert.equal(next.body.play, null, "the bot's late advance starts nothing");
  });

  it("deleting the playing Track in the middle plays the one after it", async () => {
    // The Playlist is now t1, t2, t3, then y1..y4 (artist Yan sorts before Zed).
    for (const n of [1, 2, 3, 4]) await seedTrack(`y${n}`, `Yan ${n}`, "Yan", "Mid", n);
    const g = GUILD.deleteMiddle;
    await report(g);
    const playing = await control(g, { action: "playTrack", bookId: "y2" });
    await deleteFromLibrary("y2");
    const p = await player(g);
    assert.equal(p.state, "playing");
    assert.equal(p.track?.id, "y3");
    assert.equal(p.playId, playing.playId + 1);
    assert.equal(await cursorOf(g), "y3");
    const command = await lastCommand(g);
    assert.equal(command.kind, "play");
    assert.equal(command.track?.id, "y3");
    assert.equal(command.playId, p.playId);
    // The bot's advance for the deleted Track's play is stale.
    const late = await send(bot, "POST", `/jukebox/bot/players/${g}/advance`, { playId: playing.playId, reason: "ended" });
    assert.equal(late.body.stale, true);
  });

  it("deleting the cursor while a Queue Track plays continues after the Track before it", async () => {
    const g = GUILD.deleteCursor;
    await report(g);
    await control(g, { action: "playTrack", bookId: "y1" });
    await send(person, "POST", `/jukebox/players/${g}/queue`, { bookId: "t1", at: "next" });
    const fromQueue = await control(g, { action: "next" });
    assert.equal(fromQueue.track?.id, "t1");
    assert.equal(await cursorOf(g), "y1");

    await deleteFromLibrary("y1");
    let p = await player(g);
    assert.equal(p.track?.id, "t1", "the Queue Track plays on");
    assert.equal(p.playId, fromQueue.playId);
    assert.equal(await cursorOf(g), "t3");
    assert.deepEqual(p.upcoming.map((track) => track.id), ["y3", "y4"]);

    const next = await send(bot, "POST", `/jukebox/bot/players/${g}/advance`, { playId: p.playId, reason: "ended" });
    assert.equal(next.body.play.track.id, "y3");
    p = await player(g);
    assert.equal(p.track?.id, "y3");
  });

  it("deleting a paused current Track stops the Player", async () => {
    const g = GUILD.deletePaused;
    await report(g);
    await control(g, { action: "playTrack", bookId: "y4" });
    await control(g, { action: "pause" });
    await deleteFromLibrary("y4");
    const p = await player(g);
    assert.equal(p.state, "idle");
    assert.equal(p.track, null);
    assert.equal(await cursorOf(g), "y3");
    assert.equal((await lastCommand(g)).kind, "stop");
  });
});
