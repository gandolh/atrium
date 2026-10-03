import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { GUTENDEX_BASE_URL, LIBRARY_FILES_DIR, THUMBNAILS_DIR } from "../src/common/config.js";
import { knex } from "../src/database/knex.js";
import { sweepInterruptedOutputs } from "../src/modules/library/convert.service.js";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 58: an upload streamed straight to its final name, with no cleanup, so
// a dropped client, a full disk or a throwing insert left a file (and maybe a
// cover) that no row points at and nothing ever reclaims.

const BOUNDARY = "----atriumcleanupboundary";
const head = (filename: string, type: string) =>
  Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`,
  );
const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
const multipartHeaders = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };

const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` holds or `ms` passes; the abort is cleaned up asynchronously. */
async function eventually(check: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
    if (check()) return true;
  }
  return check();
}

/** A PDF with a title page, so extraction writes a cover thumbnail. */
async function fixturePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]).drawText("cleanup fixture", {
    x: 40,
    y: 340,
    size: 18,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  return Buffer.from(await doc.save());
}

/** Make the next `books` insert throw, as a failing `insertBook` would. */
const failInserts = () =>
  knex.raw("CREATE TRIGGER fail_book_insert BEFORE INSERT ON books BEGIN SELECT RAISE(ABORT, 'forced'); END");
const allowInserts = () => knex.raw("DROP TRIGGER IF EXISTS fail_book_insert");

describe("an upload that does not finish leaves nothing behind", () => {
  let t: TestApp;
  let cookie: string;
  let pdf: Buffer;

  before(async () => {
    t = await buildTestApp();
    cookie = t.ward.signIn("uploader", "subject-uploader");
    pdf = await fixturePdf();
  });
  after(async () => {
    await t.close();
  });

  it("a client that drops mid-upload leaves no file", async () => {
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = t.app.server.address() as AddressInfo;
    const before = entries(LIBRARY_FILES_DIR);

    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/library",
      headers: { cookie, ...multipartHeaders, "content-length": String(8 * 1024 * 1024) },
    });
    req.on("error", () => undefined); // the abort below is the point
    req.write(head("big.pdf", "application/pdf"));
    req.write(Buffer.alloc(1024 * 1024, 0x41));

    // The partial body is on disk under the in-progress name, never the final one.
    const writing = await eventually(() => entries(LIBRARY_FILES_DIR).some((n) => n.endsWith(".pdf.uploading")));
    assert.ok(writing, `no in-progress file appeared: ${entries(LIBRARY_FILES_DIR).join(", ")}`);
    assert.ok(!entries(LIBRARY_FILES_DIR).some((n) => !before.includes(n) && n.endsWith(".pdf")));

    req.destroy();
    const clean = await eventually(() => entries(LIBRARY_FILES_DIR).join() === before.join());
    assert.ok(clean, `left behind: ${entries(LIBRARY_FILES_DIR).filter((n) => !before.includes(n)).join(", ")}`);
  });

  it("a failing insert leaves no file and no cover", async () => {
    const files = entries(LIBRARY_FILES_DIR);
    const covers = entries(THUMBNAILS_DIR);
    await failInserts();
    try {
      const res = await t.app.inject({
        method: "POST",
        url: "/library",
        headers: { cookie, ...multipartHeaders },
        payload: Buffer.concat([head("fixture.pdf", "application/pdf"), pdf, tail]),
      });
      assert.equal(res.statusCode, 500, res.body);
    } finally {
      await allowInserts();
    }
    assert.deepEqual(entries(LIBRARY_FILES_DIR), files);
    assert.deepEqual(entries(THUMBNAILS_DIR), covers);
  });

  it("a normal upload still lands under its final name with its cover", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/library",
      headers: { cookie, ...multipartHeaders },
      payload: Buffer.concat([head("fixture.pdf", "application/pdf"), pdf, tail]),
    });
    assert.equal(res.statusCode, 201, res.body);
    const { id } = res.json();
    assert.ok(entries(LIBRARY_FILES_DIR).includes(`${id}.pdf`));
    assert.ok(entries(THUMBNAILS_DIR).some((n) => n.startsWith(id)));
    assert.ok(!entries(LIBRARY_FILES_DIR).some((n) => n.endsWith(".uploading")));
  });

  describe("the catalog import", () => {
    const realFetch = globalThis.fetch;
    const epubUrl = "https://www.gutenberg.org/ebooks/99999.epub.images";

    before(() => {
      // Gutendex and the download, answered locally. Extraction of these bytes
      // fails, which the import already treats as "no cover"; the file write and
      // the insert are what is under test.
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith(GUTENDEX_BASE_URL)) {
          return Response.json({
            count: 1,
            results: [{ id: 99999, title: "Stub", formats: { "application/epub+zip": epubUrl } }],
          });
        }
        if (url === epubUrl) return new Response(Buffer.from("not really an epub"));
        return realFetch(input);
      }) as typeof fetch;
    });
    after(() => {
      globalThis.fetch = realFetch;
    });

    const importBook = () =>
      t.app.inject({ method: "POST", url: "/library/import", headers: { cookie }, payload: { gutenbergId: 99999 } });

    it("a failing insert leaves no file", async () => {
      const files = entries(LIBRARY_FILES_DIR);
      await failInserts();
      try {
        const res = await importBook();
        assert.equal(res.statusCode, 500, res.body);
      } finally {
        await allowInserts();
      }
      assert.deepEqual(entries(LIBRARY_FILES_DIR), files);
    });

    it("a normal import still stores its file", async () => {
      const res = await importBook();
      assert.equal(res.statusCode, 201, res.body);
      assert.ok(entries(LIBRARY_FILES_DIR).includes(`${res.json().id}.epub`));
    });
  });
});

describe("the boot sweep reclaims an upload a dead process left", () => {
  it("removes <uuid>.<ext>.uploading and nothing else", async () => {
    mkdirSync(LIBRARY_FILES_DIR, { recursive: true });
    const orphan = `${randomUUID()}.pdf.uploading`;
    const kept = [`${randomUUID()}.pdf`, "notes.txt.uploading", `${randomUUID()}.uploading`];
    for (const name of [orphan, ...kept]) writeFileSync(join(LIBRARY_FILES_DIR, name), "x");

    const removed = await sweepInterruptedOutputs();

    assert.equal(removed, 1);
    const left = entries(LIBRARY_FILES_DIR);
    assert.ok(!left.includes(orphan));
    for (const name of kept) assert.ok(left.includes(name), `${name} was removed`);
  });
});
