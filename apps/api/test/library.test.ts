import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { LIBRARY_FILES_DIR, THUMBNAILS_DIR } from "../src/common/config.js";
import { buildTestApp, type TestApp } from "./harness.js";

/** A one-page PDF, made here so the suite carries no binary fixture. */
async function fixturePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle("Harness Fixture");
  const page = doc.addPage([300, 400]);
  page.drawText("atrium test fixture", { x: 40, y: 340, size: 18, font: await doc.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await doc.save());
}

/** A single-file multipart body, as the web client's upload sends it. */
function multipart(filename: string, contentType: string, bytes: Buffer) {
  const boundary = "----atriumtestboundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

describe("library round trip", () => {
  let t: TestApp;
  let cookie: string;
  let pdf: Buffer;
  let id: string;

  before(async () => {
    t = await buildTestApp();
    cookie = t.ward.signIn("reader", "subject-reader");
    pdf = await fixturePdf();
  });
  after(async () => {
    await t.close();
  });

  it("uploads a PDF", async () => {
    const body = multipart("fixture.pdf", "application/pdf", pdf);
    const res = await t.app.inject({
      method: "POST",
      url: "/library",
      headers: { cookie, ...body.headers },
      payload: body.payload,
    });
    assert.equal(res.statusCode, 201, res.body);
    id = res.json().id;
    assert.ok(entries(LIBRARY_FILES_DIR).some((name) => name.startsWith(id)), "file written to the scratch library");
    // Asserted so the delete test's "thumbnail removed" is not vacuous.
    assert.ok(entries(THUMBNAILS_DIR).some((name) => name.startsWith(id)), "cover extracted to the scratch thumbnails");
  });

  it("lists it", async () => {
    const res = await t.app.inject({ method: "GET", url: "/library", headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const ids = (res.json() as { id: string }[]).map((b) => b.id);
    assert.ok(ids.includes(id));
  });

  it("serves the whole file", async () => {
    const res = await t.app.inject({ method: "GET", url: `/library/${id}/file`, headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.rawPayload.length, pdf.length);
  });

  it("serves a byte range as 206", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/library/${id}/file`,
      headers: { cookie, range: "bytes=0-99" },
    });
    assert.equal(res.statusCode, 206);
    assert.equal(res.rawPayload.length, 100);
    assert.deepEqual(res.rawPayload, pdf.subarray(0, 100));
  });

  it("answers an unsatisfiable range with 416", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/library/${id}/file`,
      headers: { cookie, range: `bytes=${pdf.length + 1000}-` },
    });
    assert.equal(res.statusCode, 416);
  });

  it("deletes it, file and thumbnail with it", async () => {
    const res = await t.app.inject({ method: "DELETE", url: `/library/${id}`, headers: { cookie } });
    assert.equal(res.statusCode, 204);
    assert.ok(!entries(LIBRARY_FILES_DIR).some((name) => name.startsWith(id)), "file removed");
    assert.ok(!entries(THUMBNAILS_DIR).some((name) => name.startsWith(id)), "thumbnail removed");
    const gone = await t.app.inject({ method: "GET", url: `/library/${id}`, headers: { cookie } });
    assert.equal(gone.statusCode, 404);
  });
});
