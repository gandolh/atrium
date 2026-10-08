import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FileType, MediaKind } from "@ebook-reader/shared";
import { coverPathFor, filePathFor } from "../src/common/paths.js";
import { knex } from "../src/database/knex.js";
import { buildTestApp, type TestApp } from "./harness.js";

/**
 * Brief 80 (D55): an account whose only atrium role is `jukebox` is the Discord
 * bot, and it reaches `/jukebox/*` plus the file and cover of `audio` items.
 * Everything else is 403 `JUKEBOX_ROLE_FORBIDDEN`, because the library has no
 * owners and a leaked bot password must not be able to delete it.
 */

const AUDIO_BYTES = Buffer.alloc(4096, 7);

/** A library row straight into SQLite, with its file (and cover) on disk. */
async function seed(id: string, format: FileType, kind: MediaKind, withCover: boolean): Promise<void> {
  await knex("books").insert({
    id,
    title: id,
    format,
    kind,
    size_bytes: AUDIO_BYTES.length,
    created_at: new Date().toISOString(),
    source: "upload",
  });
  const file = filePathFor(id, format);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, AUDIO_BYTES);
  if (withCover) {
    const cover = coverPathFor(id);
    mkdirSync(dirname(cover), { recursive: true });
    writeFileSync(cover, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
}

describe("the jukebox role", () => {
  let t: TestApp;
  let bot: string;

  before(async () => {
    t = await buildTestApp();
    bot = t.ward.signIn("bot", "subject-bot", { atrium: ["jukebox"] });
    await seed("song", "mp3", "audio", true);
    await seed("bare-song", "mp3", "audio", false);
    await seed("book", "pdf", "book", true);
    await seed("film", "mp4", "video", true);
  });
  after(async () => {
    await t.close();
  });

  const forbidden = (res: { statusCode: number; json: () => { error?: string } }) => {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "JUKEBOX_ROLE_FORBIDDEN");
  };

  describe("signed in as jukebox only", () => {
    it("cannot list, upload, record progress on or delete library items", async () => {
      forbidden(await t.app.inject({ method: "GET", url: "/library", headers: { cookie: bot } }));
      forbidden(await t.app.inject({ method: "POST", url: "/library", headers: { cookie: bot } }));
      forbidden(
        await t.app.inject({
          method: "PATCH",
          url: "/library/song/progress",
          headers: { cookie: bot },
          payload: { progress: 0.5 },
        }),
      );
      forbidden(await t.app.inject({ method: "DELETE", url: "/library/song", headers: { cookie: bot } }));
      assert.ok(await knex("books").where({ id: "song" }).first(), "the delete attempt left the row");
    });

    it("cannot list or switch profiles", async () => {
      forbidden(await t.app.inject({ method: "GET", url: "/profiles", headers: { cookie: bot } }));
      const profile = await knex("profiles").where({ subject: "subject-bot" }).first();
      forbidden(
        await t.app.inject({
          method: "POST",
          url: `/profiles/${profile?.id ?? "unknown"}/activate`,
          headers: { cookie: bot },
        }),
      );
    });

    it("cannot reach notes or LaTeX", async () => {
      forbidden(await t.app.inject({ method: "GET", url: "/notes", headers: { cookie: bot } }));
      forbidden(await t.app.inject({ method: "GET", url: "/latex", headers: { cookie: bot } }));
    });

    it("cannot get past the guard with a query string", async () => {
      forbidden(await t.app.inject({ method: "GET", url: "/library?x=/library/song/file", headers: { cookie: bot } }));
    });

    it("is refused on a path that matches no route", async () => {
      forbidden(await t.app.inject({ method: "GET", url: "/nowhere", headers: { cookie: bot } }));
    });

    it("streams an audio file, whole and by range", async () => {
      const whole = await t.app.inject({ method: "GET", url: "/library/song/file", headers: { cookie: bot } });
      assert.equal(whole.statusCode, 200);
      assert.equal(whole.rawPayload.length, AUDIO_BYTES.length);
      const part = await t.app.inject({
        method: "GET",
        url: "/library/song/file",
        headers: { cookie: bot, range: "bytes=0-99" },
      });
      assert.equal(part.statusCode, 206);
      assert.equal(part.rawPayload.length, 100);
    });

    it("cannot stream a book's file", async () => {
      forbidden(await t.app.inject({ method: "GET", url: "/library/book/file", headers: { cookie: bot } }));
    });

    it("gets an audio cover, or a 404 when there is none", async () => {
      const cover = await t.app.inject({ method: "GET", url: "/library/song/cover", headers: { cookie: bot } });
      assert.equal(cover.statusCode, 200);
      const none = await t.app.inject({ method: "GET", url: "/library/bare-song/cover", headers: { cookie: bot } });
      assert.equal(none.statusCode, 404);
    });

    it("cannot get a video's cover", async () => {
      forbidden(await t.app.inject({ method: "GET", url: "/library/film/cover", headers: { cookie: bot } }));
    });

    it("reaches /jukebox/*, which is a 404 until brief 81", async () => {
      const res = await t.app.inject({ method: "GET", url: "/jukebox/anything", headers: { cookie: bot } });
      assert.equal(res.statusCode, 404);
    });

    it("has the one lazily created Default profile", async () => {
      const profiles = await knex("profiles").where({ subject: "subject-bot" });
      assert.equal(profiles.length, 1);
      assert.equal(profiles[0].name, "Default");
    });
  });

  // A full account that also holds `jukebox` must never be limited by it, so
  // granting the role to the owner by mistake cannot lock them out.
  for (const roles of [["user"], ["user", "jukebox"]]) {
    describe(`signed in as ${roles.join(" + ")}`, () => {
      let cookie: string;
      const subject = `subject-${roles.join("-")}`;
      const doomed = `doomed-${roles.join("-")}`;

      before(async () => {
        cookie = t.ward.signIn(`full-${roles.join("-")}`, subject, { atrium: roles });
        await seed(doomed, "pdf", "book", false);
      });

      it("reaches the routes the bot cannot", async () => {
        for (const [method, url] of [
          ["GET", "/library"],
          ["GET", "/profiles"],
          ["GET", "/notes"],
          ["GET", "/latex"],
          ["GET", "/library/book/file"],
          ["GET", "/library/film/cover"],
        ] as const) {
          const res = await t.app.inject({ method, url, headers: { cookie } });
          assert.equal(res.statusCode, 200, `${method} ${url}`);
        }
        const progress = await t.app.inject({
          method: "PATCH",
          url: "/library/book/progress",
          headers: { cookie },
          payload: { progress: 0.5 },
        });
        assert.equal(progress.statusCode, 200, progress.body);
        // An empty upload is the route's own 400/406, not the guard's 403.
        const upload = await t.app.inject({ method: "POST", url: "/library", headers: { cookie } });
        assert.notEqual(upload.statusCode, 403);
        assert.ok(upload.statusCode < 500, upload.body);
      });

      it("can switch profiles", async () => {
        const profile = await knex("profiles").where({ subject }).first();
        const res = await t.app.inject({
          method: "POST",
          url: `/profiles/${profile.id}/activate`,
          headers: { cookie },
        });
        assert.equal(res.statusCode, 200);
      });

      it("can delete an item", async () => {
        const res = await t.app.inject({ method: "DELETE", url: `/library/${doomed}`, headers: { cookie } });
        assert.ok(res.statusCode < 300, `${res.statusCode} ${res.body}`);
        assert.equal(await knex("books").where({ id: doomed }).first(), undefined);
      });
    });
  }

  it("/health still needs no session", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
  });
});
